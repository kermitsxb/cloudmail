import type { Env } from "../env";
import { parseEmail, safeKey, snippetOf } from "./parse";
import { resolveThread } from "./threading";

export type StoreResult = { messageId: number | null; duplicate: boolean; rawKey: string };

export const sanitizeFilename = (name: string): string =>
  name.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 120) || "fichier";

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
  const key = safeKey(msg.messageId);

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

  const text = truncateBody(msg.text);
  const html = truncateBody(msg.html);

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
        parse_error, body_truncated)
     VALUES (?, ?, ?, 'in', 'inbox', ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`
  ).bind(
    threadId, msg.messageId, msg.inReplyTo, msg.from.address, msg.from.name,
    msg.subject, text.value, html.value, snippetOf(msg.text || msg.subject),
    msg.date, msg.attachments.length > 0 ? 1 : 0, rawKey, msg.parseError ? 1 : 0,
    text.truncated || html.truncated ? 1 : 0
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

  const statements: D1PreparedStatement[] = [];
  for (const [kind, list] of [["to", msg.to], ["cc", msg.cc], ["reply-to", msg.replyTo]] as const) {
    for (const a of list) {
      statements.push(
        env.DB.prepare("INSERT INTO recipients (message_id, kind, address, name) VALUES (?, ?, ?, ?)")
          .bind(messageId, kind, a.address, a.name)
      );
    }
  }

  for (const [i, att] of msg.attachments.entries()) {
    const r2Key = `att/${key}/${i}-${sanitizeFilename(att.filename)}`;
    await env.MAIL.put(r2Key, att.content, { httpMetadata: { contentType: att.mimeType } });
    statements.push(
      env.DB.prepare(
        "INSERT INTO attachments (message_id, filename, mime_type, size, content_id, r2_key) VALUES (?, ?, ?, ?, ?, ?)"
      ).bind(messageId, att.filename, att.mimeType, att.size, att.contentId, r2Key)
    );
  }

  statements.push(
    env.DB.prepare(
      `UPDATE threads
         SET message_count = message_count + 1,
             unread_count = unread_count + 1,
             last_message_at = MAX(last_message_at, ?)
       WHERE id = ?`
    ).bind(msg.date, threadId)
  );

  await env.DB.batch(statements);
  return { messageId, duplicate: false, rawKey };
}
