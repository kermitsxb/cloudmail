import type { Env } from "../env";
import { countsInThread, type Folder } from "../db/folders";
import { parseEmail, safeKey, snippetOf, type ParsedAttachment, type ParsedMessage } from "./parse";
import { resolveThread } from "./threading";

export type StoreResult = { messageId: number | null; duplicate: boolean; rawKey: string };

export const sanitizeFilename = (name: string): string =>
  name.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 120) || "fichier";

// Pièce jointe écrite dans R2, avec la clé sous laquelle elle l'a été.
export type StoredAttachment = ParsedAttachment & { r2Key: string };

// Clé R2 d'une pièce jointe. Partagée par l'ingestion et le réimport : une même pièce
// jointe d'un même message doit toujours atterrir sous la même clé.
export const attachmentKey = (messageId: string, index: number, filename: string): string =>
  `att/${safeKey(messageId)}/${index}-${sanitizeFilename(filename)}`;

// Écrit les pièces jointes dans R2, une par une, avant toute écriture D1 qui les référence.
// `onWritten` est appelé après chaque écriture réussie : un appelant qui veut nettoyer les
// objets déjà écrits si une écriture suivante échoue (reparseInPlace, src/admin/reimport.ts)
// n'a ainsi pas besoin d'attendre le résultat final, jamais renvoyé en cas d'erreur.
// `keyPrefix` isole chaque message réimporté ; chaque essai reçoit un préfixe unique
// pour qu'un rollback ne puisse pas supprimer l'objet validé par un autre essai.
export async function putAttachments(
  env: Env,
  messageId: string,
  attachments: ParsedAttachment[],
  onWritten?: (r2Key: string) => void,
  keyPrefix?: string,
): Promise<StoredAttachment[]> {
  const stored: StoredAttachment[] = [];
  const attemptPrefix = keyPrefix ? `${keyPrefix}/${crypto.randomUUID()}` : null;
  for (const [i, att] of attachments.entries()) {
    let r2Key = attachmentKey(messageId, i, att.filename);
    if (attemptPrefix) r2Key = `${attemptPrefix}/${i}-${sanitizeFilename(att.filename)}`;
    await env.MAIL.put(r2Key, att.content, { httpMetadata: { contentType: att.mimeType } });
    stored.push({ ...att, r2Key });
    onWritten?.(r2Key);
  }
  return stored;
}

export function recipientStatements(db: D1Database, rowId: number, msg: ParsedMessage): D1PreparedStatement[] {
  const statements: D1PreparedStatement[] = [];
  for (const [kind, list] of [["to", msg.to], ["cc", msg.cc], ["reply-to", msg.replyTo]] as const) {
    for (const a of list) {
      statements.push(
        db.prepare("INSERT INTO recipients (message_id, kind, address, name) VALUES (?, ?, ?, ?)")
          .bind(rowId, kind, a.address, a.name)
      );
    }
  }
  return statements;
}

export function attachmentStatements(db: D1Database, rowId: number, stored: StoredAttachment[]): D1PreparedStatement[] {
  return stored.map((att) =>
    db.prepare(
      "INSERT INTO attachments (message_id, filename, mime_type, size, content_id, r2_key) VALUES (?, ?, ?, ?, ?, ?)"
    ).bind(rowId, att.filename, att.mimeType, att.size, att.contentId, att.r2Key)
  );
}

// Borne de taille appliquée à chaque corps (texte et HTML) avant insertion en D1. Une
// ligne D1 ne peut pas dépasser 2 Mo, alors qu'Email Routing accepte des messages bien
// plus gros (une infolettre bourrée d'images data: dépasse couramment 2 Mo de HTML à elle
// seule). Sans cette borne, l'INSERT lève, handleEmail avale l'erreur, et le message ne
// survit que comme objet R2 sans ligne D1 — c'est-à-dire perdu. On tronque donc, on marque
// la ligne (body_truncated) et on garde le MIME brut complet dans R2 sous raw_key.
export const MAX_BODY_BYTES = 512 * 1024;

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8");

// Tronque sur les octets UTF-8 (pas sur les unités de code JS) : c'est la taille en octets
// qui compte pour la limite de ligne D1. Le caractère éventuellement coupé en deux par la
// découpe est décodé en U+FFFD par TextDecoder ; on le retire pour ne pas laisser un
// caractère de remplacement parasite en fin de corps.
export function truncateBody(value: string | null): { value: string | null; truncated: boolean } {
  if (value === null) return { value: null, truncated: false };
  const bytes = encoder.encode(value);
  if (bytes.byteLength <= MAX_BODY_BYTES) return { value, truncated: false };
  const cut = decoder.decode(bytes.subarray(0, MAX_BODY_BYTES)).replace(/\uFFFD$/, "");
  return { value: cut, truncated: true };
}

const sha256Hex = async (data: ArrayBuffer): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
};

// Correspondance entre un message parsé et les colonnes qu'il alimente en base, partagée
// par storeIncoming (nouvelle arrivée) et reparseInPlace (réanalyse d'une ligne existante,
// src/admin/reimport.ts). Les deux appelants doivent produire la même ligne à partir du
// même ParsedMessage ; centraliser cette correspondance ici empêche les deux de diverger.
// `messageId` est pris à part (et non msg.messageId) car reparseInPlace peut choisir de
// conserver l'identifiant déjà en base plutôt que celui, inventé, du nouveau parsing.
export function parsedColumns(msg: ParsedMessage, messageId: string) {
  const text = truncateBody(msg.text);
  const html = truncateBody(msg.html);
  return {
    messageId,
    inReplyTo: msg.inReplyTo,
    fromAddr: msg.from.address,
    fromName: msg.from.name,
    subject: msg.subject,
    textBody: text.value,
    htmlBody: html.value,
    snippet: snippetOf(msg.text || msg.subject),
    receivedAt: msg.date,
    hasAttachments: msg.attachments.length > 0 ? 1 : 0,
    parseError: msg.parseError ? 1 : 0,
    bodyTruncated: text.truncated || html.truncated ? 1 : 0,
    authSpf: msg.auth.spf,
    authDkim: msg.auth.dkim,
    authDmarc: msg.auth.dmarc,
    spamScore: msg.auth.spamScore,
  };
}

export async function storeIncoming(
  env: Env,
  raw: ArrayBuffer,
  envelope: { from: string; to: string },
): Promise<StoreResult> {
  // La clé est dérivée du brut lui-même (SHA-256 des octets), pas du message
  // parsé : l'écriture R2 précède ainsi structurellement tout appel à
  // parseEmail. Un même brut redélivré écrit le même objet (adressage par
  // contenu), et même si parseEmail venait à lever, le message est déjà
  // rejouable depuis R2.
  const rawKey = `raw/${await sha256Hex(raw)}.eml`;
  await env.MAIL.put(rawKey, raw);

  const msg = await parseEmail(raw, envelope.from);

  const participants = [
    msg.from.address,
    ...msg.to.map((a) => a.address),
    ...msg.cc.map((a) => a.address),
  ];

  const existing = await env.DB.prepare("SELECT id FROM messages WHERE message_id = ?")
    .bind(msg.messageId)
    .first<{ id: number }>();
  if (existing) return { messageId: existing.id, duplicate: true, rawKey };

  const { threadId, created } = await resolveThread(env.DB, msg, participants);

  const cols = parsedColumns(msg, msg.messageId);

  // Seul un échec DMARC classe en spam : c'est le cas « usurpation probable », déterministe.
  // Les échecs plus faibles (SPF ou DKIM seuls) restent en boîte de réception avec un
  // avertissement côté interface. Le message est toujours archivé, jamais rejeté.
  const folder: Folder = msg.auth.dmarc === "fail" ? "spam" : "inbox";

  // INSERT OR IGNORE plutôt qu'un INSERT sec : le SELECT d'idempotence ci-dessus ne
  // protège pas de deux livraisons concurrentes du même Message-ID (les deux passent le
  // SELECT avant que l'une n'ait inséré). Avec un INSERT sec, la seconde levait sur la
  // contrainte d'unicité alors que resolveThread lui avait déjà créé un thread : échec
  // signalé à tort ET thread orphelin laissé en base. Ici la seconde livraison est
  // simplement ignorée (meta.changes === 0), et on nettoie le thread créé pour rien.
  const inserted = await env.DB.prepare(
    `INSERT OR IGNORE INTO messages
       (thread_id, message_id, in_reply_to, direction, folder, from_addr, from_name,
        subject, text_body, html_body, snippet, received_at, is_read, has_attachments, raw_key,
        parse_error, body_truncated, trashed_at, auth_spf, auth_dkim, auth_dmarc, spam_score)
     VALUES (?, ?, ?, 'in', ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?,
             CASE WHEN ? = 'spam' THEN unixepoch() END, ?, ?, ?, ?)`
  ).bind(
    threadId, cols.messageId, cols.inReplyTo, folder, cols.fromAddr, cols.fromName,
    cols.subject, cols.textBody, cols.htmlBody, cols.snippet,
    cols.receivedAt, cols.hasAttachments, rawKey, cols.parseError,
    cols.bodyTruncated, folder, cols.authSpf, cols.authDkim, cols.authDmarc, cols.spamScore
  ).run();

  if (inserted.meta.changes === 0) {
    // Course perdue : une livraison concurrente a inséré ce Message-ID entre notre SELECT
    // et notre INSERT. On supprime le thread que resolveThread venait de créer pour ce
    // message (il est resté vide, la ligne n'ayant pas été insérée), et on retourne le
    // message gagnant comme un doublon ordinaire.
    if (created) {
      await env.DB.prepare(
        "DELETE FROM threads WHERE id = ? AND NOT EXISTS (SELECT 1 FROM messages WHERE thread_id = ?)"
      ).bind(threadId, threadId).run();
    }
    const winner = await env.DB.prepare("SELECT id FROM messages WHERE message_id = ?")
      .bind(msg.messageId)
      .first<{ id: number }>();
    return { messageId: winner?.id ?? null, duplicate: true, rawKey };
  }

  const messageId = Number(inserted.meta.last_row_id);

  const stored = await putAttachments(env, msg.messageId, msg.attachments);
  const statements: D1PreparedStatement[] = [
    ...recipientStatements(env.DB, messageId, msg),
    ...attachmentStatements(env.DB, messageId, stored),
  ];

  // Un message qui vient d'arriver est toujours non lu. En boîte de réception, les deux
  // compteurs du thread progressent d'une unité et la date du fil avance. En spam, dossier
  // hors compteurs, rien ne bouge : une réponse usurpée ne doit pas faire remonter un fil
  // légitime en tête de la boîte de réception. Un fil créé pour ce spam a déjà reçu sa date
  // à l'insertion (resolveThread).
  const counted = countsInThread(folder) ? 1 : 0;
  statements.push(
    env.DB.prepare(
      `UPDATE threads
         SET message_count = message_count + ?,
             unread_count = unread_count + ?,
             last_message_at = CASE WHEN ? = 1 THEN MAX(last_message_at, ?) ELSE last_message_at END
       WHERE id = ?`
    ).bind(counted, counted, counted, msg.date, threadId)
  );

  await env.DB.batch(statements);
  return { messageId, duplicate: false, rawKey };
}
