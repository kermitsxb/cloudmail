import type { Env } from "../env";
import { parseEmail, safeKey, snippetOf } from "./parse";
import { resolveThread } from "./threading";

export type StoreResult = { messageId: number | null; duplicate: boolean; rawKey: string };

const sanitizeFilename = (name: string): string =>
  name.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 120) || "fichier";

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

  const { threadId } = await resolveThread(env.DB, msg, participants);

  const inserted = await env.DB.prepare(
    `INSERT INTO messages
       (thread_id, message_id, in_reply_to, direction, folder, from_addr, from_name,
        subject, text_body, html_body, snippet, received_at, is_read, has_attachments, raw_key, parse_error)
     VALUES (?, ?, ?, 'in', 'inbox', ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`
  ).bind(
    threadId, msg.messageId, msg.inReplyTo, msg.from.address, msg.from.name,
    msg.subject, msg.text, msg.html, snippetOf(msg.text || msg.subject),
    msg.date, msg.attachments.length > 0 ? 1 : 0, rawKey, msg.parseError ? 1 : 0
  ).run();
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
