import type { Env } from "../env";
import { resolveThread } from "../ingest/threading";
import { safeKey, snippetOf } from "../ingest/parse";
import { sanitizeFilename } from "../ingest/store";
import type { SendRequest } from "../send/client";

export async function setRead(db: D1Database, messageId: number, isRead: boolean): Promise<boolean> {
  const row = await db
    .prepare("SELECT thread_id, folder, is_read FROM messages WHERE id = ?")
    .bind(messageId)
    .first<{ thread_id: number; folder: string; is_read: number }>();
  if (!row) return false;
  if (Boolean(row.is_read) === isRead) return true;

  const statements = [db.prepare("UPDATE messages SET is_read = ? WHERE id = ?").bind(isRead ? 1 : 0, messageId)];

  // Le compteur de non-lus du thread ne reflète que les messages hors corbeille : un message
  // à la corbeille ne doit jamais faire varier unread_count, sous peine de désynchroniser le
  // compteur (cf. moveToFolder, qui a déjà ajusté unread_count au moment de la mise à la corbeille).
  if (row.folder !== "trash") {
    statements.push(
      db.prepare("UPDATE threads SET unread_count = MAX(0, unread_count + ?) WHERE id = ?")
        .bind(isRead ? -1 : 1, row.thread_id)
    );
  }

  await db.batch(statements);
  return true;
}

export async function moveToFolder(
  db: D1Database,
  messageId: number,
  folder: "inbox" | "sent" | "trash",
): Promise<boolean> {
  const row = await db
    .prepare("SELECT thread_id, folder, is_read FROM messages WHERE id = ?")
    .bind(messageId)
    .first<{ thread_id: number; folder: string; is_read: number }>();
  if (!row) return false;
  if (row.folder === folder) return true;

  const wasTrash = row.folder === "trash";
  const goingToTrash = folder === "trash";

  const statements = [db.prepare("UPDATE messages SET folder = ? WHERE id = ?").bind(folder, messageId)];

  // message_count et unread_count ne comptabilisent que les messages hors corbeille. Un
  // aller-retour inbox <-> sent (les deux hors corbeille) ne doit donc toucher aucun des deux
  // compteurs ; seule une entrée ou sortie de la corbeille les fait varier.
  if (wasTrash !== goingToTrash) {
    const delta = goingToTrash ? -1 : 1;
    const unreadDelta = row.is_read ? 0 : delta;
    statements.push(
      db.prepare(
        `UPDATE threads
            SET message_count = MAX(0, message_count + ?),
                unread_count = MAX(0, unread_count + ?)
          WHERE id = ?`
      ).bind(delta, unreadDelta, row.thread_id)
    );
  }

  await db.batch(statements);
  return true;
}

export async function purgeMessage(env: Env, messageId: number): Promise<boolean> {
  const row = await env.DB
    .prepare("SELECT thread_id, folder, is_read, raw_key FROM messages WHERE id = ?")
    .bind(messageId)
    .first<{ thread_id: number; folder: string; is_read: number; raw_key: string }>();
  if (!row) return false;

  const atts = await env.DB
    .prepare("SELECT r2_key FROM attachments WHERE message_id = ?")
    .bind(messageId)
    .all<{ r2_key: string }>();

  // Ordre volontaire (retour sur décision) : on supprime d'abord les objets R2, puis la ligne
  // D1. `R2Bucket#delete` est idempotent — répéter l'appel sur des clés déjà absentes ne fait
  // rien — donc une purge interrompue après la suppression R2 mais avant la suppression D1 se
  // rejoue simplement jusqu'au bout : la ligne D1 encore présente sert d'adresse pour ce rejeu.
  // Si la suppression R2 échoue, on s'arrête sans toucher D1, pour ne jamais perdre l'adresse
  // (raw_key/r2_key) du contenu qu'on n'a pas réussi à supprimer.
  // L'ordre inverse (D1 avant R2) a été essayé puis rejeté : une fois la ligne messages
  // supprimée, `raw_key` et `attachments.r2_key` disparaissent avec elle, et un objet R2
  // orphelin résultant d'un échec R2 après coup n'est alors plus retrouvable qu'en balayant
  // tout le bucket à la recherche de clés sans ligne correspondante — un échec silencieux et
  // définitif sur du contenu de message potentiellement sensible. Le résidu temporaire de
  // l'ordre retenu (une ligne D1 qui référence des objets déjà supprimés, le temps d'un rejeu)
  // est au contraire visible (404 sur la pièce jointe ou le brut) et réparable en relançant la
  // purge.
  const keys = [row.raw_key, ...atts.results.map((a) => a.r2_key)];
  await env.MAIL.delete(keys);

  // Un message déjà à la corbeille a déjà été retiré de message_count/unread_count par
  // moveToFolder : ne pas les décrémenter une seconde fois ici.
  const statements = [
    env.DB.prepare("DELETE FROM attachments WHERE message_id = ?").bind(messageId),
    env.DB.prepare("DELETE FROM recipients WHERE message_id = ?").bind(messageId),
    env.DB.prepare("DELETE FROM messages WHERE id = ?").bind(messageId),
  ];
  if (row.folder !== "trash") {
    statements.push(
      env.DB.prepare(
        `UPDATE threads
            SET message_count = MAX(0, message_count - 1),
                unread_count = MAX(0, unread_count - ?)
          WHERE id = ?`
      ).bind(row.is_read ? 0 : 1, row.thread_id)
    );
  }
  await env.DB.batch(statements);

  const remaining = await env.DB
    .prepare("SELECT COUNT(*) AS n FROM messages WHERE thread_id = ?")
    .bind(row.thread_id)
    .first<{ n: number }>();
  if ((remaining?.n ?? 0) === 0) {
    await env.DB.prepare("DELETE FROM threads WHERE id = ?").bind(row.thread_id).run();
  }

  // Une clé de brut adressée par contenu (raw/<sha256>.eml) pourrait en théorie être partagée
  // par deux messages aux octets strictement identiques ; l'unicité de messages.message_id
  // rend ce cas quasi impossible en pratique (il faudrait deux Message-Id différents pour un
  // corps d'e-mail rigoureusement identique). On ne construit pas de comptage de références
  // pour ce cas résiduel.
  return true;
}

// Stocke une copie d'un message sortant déjà envoyé avec succès (voir POST /messages dans
// api/routes.ts, qui n'appelle cette fonction qu'après confirmation de sendEmail). On
// réutilise resolveThread — écrit pour les messages entrants — en construisant un objet de
// forme ParsedMessage : resolveThread ne lit que inReplyTo, references, subject et date, donc
// cette réutilisation est sûre même si les autres champs (attachments, parseError, replyTo)
// sont des valeurs neutres qui ne servent qu'à satisfaire le type. `date` est l'instant présent
// (l'API Email Sending n'indique pas d'horodatage serveur dans sa réponse), `references` celles
// fournies par la route (reconstituées à partir du message parent), et `subject` le sujet tel
// que saisi par l'utilisateur — resolveThread le normalise lui-même via normalizeSubject avant
// de l'utiliser pour l'appariement.
//
// `raw_key` vaut `sent/<messageId>` : aucun objet R2 n'existe à cette clé pour un message
// envoyé (il n'y a pas de MIME brut, seulement les champs structurés qu'on vient d'insérer).
// C'est assumé : GET /messages/:id/raw répondra 404 pour ces messages, comme pour tout message
// dont l'objet R2 aurait disparu.
const base64ToBytes = (b64: string): Uint8Array => {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
};

export async function storeOutgoing(env: Env, req: SendRequest, messageId: string): Promise<number> {
  const now = Math.floor(Date.now() / 1000);
  const parsedLike = {
    messageId,
    inReplyTo: req.inReplyTo ?? null,
    references: req.references ?? [],
    from: { address: req.from, name: null },
    to: req.to.map((a) => ({ address: a, name: null })),
    cc: (req.cc ?? []).map((a) => ({ address: a, name: null })),
    replyTo: [],
    subject: req.subject,
    text: req.text,
    html: req.html ?? null,
    date: now,
    attachments: [],
    parseError: false,
  };

  const participants = [req.from, ...req.to, ...(req.cc ?? [])];
  const { threadId } = await resolveThread(env.DB, parsedLike, participants);

  const inserted = await env.DB.prepare(
    `INSERT INTO messages
       (thread_id, message_id, in_reply_to, direction, folder, from_addr, subject, text_body, html_body,
        snippet, received_at, is_read, has_attachments, raw_key, parse_error)
     VALUES (?, ?, ?, 'out', 'sent', ?, ?, ?, ?, ?, ?, 1, ?, ?, 0)`
  ).bind(
    threadId, messageId, req.inReplyTo ?? null, req.from, req.subject, req.text, req.html ?? null,
    snippetOf(req.text), now, (req.attachments?.length ?? 0) > 0 ? 1 : 0, `sent/${messageId}`
  ).run();
  const id = Number(inserted.meta.last_row_id);

  const statements: D1PreparedStatement[] = [];
  for (const [kind, list] of [["to", req.to], ["cc", req.cc ?? []]] as const) {
    for (const address of list) {
      statements.push(
        env.DB.prepare("INSERT INTO recipients (message_id, kind, address, name) VALUES (?, ?, ?, NULL)")
          .bind(id, kind, address)
      );
    }
  }
  // Les pièces jointes du message envoyé sont réellement persistées : octets dans R2 sous
  // att/sent-<messageId sûr>/<i>-<nom assaini> (même schéma de clé et même assainissement de
  // nom que l'ingestion, cf. sanitizeFilename dans ingest/store.ts), et une ligne par pièce
  // dans `attachments`. Sans cela, has_attachments = 1 faisait afficher un trombone dans la
  // liste pour une conversation qui n'en montrait aucune une fois ouverte, et l'utilisateur
  // n'avait aucune copie de ce qu'il avait envoyé. `content_id` reste NULL : un message
  // composé ici n'a pas d'image inline référencée par cid:.
  const key = safeKey(messageId);
  for (const [i, att] of (req.attachments ?? []).entries()) {
    const bytes = base64ToBytes(att.contentBase64);
    const r2Key = `att/sent-${key}/${i}-${sanitizeFilename(att.filename)}`;
    await env.MAIL.put(r2Key, bytes, { httpMetadata: { contentType: att.mimeType } });
    statements.push(
      env.DB.prepare(
        "INSERT INTO attachments (message_id, filename, mime_type, size, content_id, r2_key) VALUES (?, ?, ?, ?, NULL, ?)"
      ).bind(id, att.filename, att.mimeType, bytes.byteLength, r2Key)
    );
  }

  statements.push(
    env.DB.prepare(
      "UPDATE threads SET message_count = message_count + 1, last_message_at = MAX(last_message_at, ?) WHERE id = ?"
    ).bind(now, threadId)
  );
  await env.DB.batch(statements);

  return id;
}
