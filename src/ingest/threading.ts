import { normalizeSubject, type ParsedMessage } from "./parse";

export type ThreadResolution = { threadId: number; created: boolean };

const THIRTY_DAYS = 30 * 86400;

async function threadOfMessage(db: D1Database, messageId: string): Promise<number | null> {
  const row = await db
    .prepare("SELECT thread_id FROM messages WHERE message_id = ?")
    .bind(messageId)
    .first<{ thread_id: number }>();
  return row?.thread_id ?? null;
}

export async function resolveThread(
  db: D1Database,
  msg: ParsedMessage,
  participants: string[],
): Promise<ThreadResolution> {
  if (msg.inReplyTo) {
    const id = await threadOfMessage(db, msg.inReplyTo);
    if (id !== null) return { threadId: id, created: false };
  }

  for (const ref of [...msg.references].reverse()) {
    const id = await threadOfMessage(db, ref);
    if (id !== null) return { threadId: id, created: false };
  }

  const subjectNorm = normalizeSubject(msg.subject);
  if (subjectNorm && participants.length > 0) {
    const placeholders = participants.map(() => "?").join(",");
    const row = await db
      .prepare(
        `SELECT t.id FROM threads t
         JOIN messages m ON m.thread_id = t.id
         LEFT JOIN recipients r ON r.message_id = m.id
         WHERE t.subject_norm = ?
           AND t.last_message_at >= ?
           AND (m.from_addr IN (${placeholders}) OR r.address IN (${placeholders}))
         ORDER BY t.last_message_at DESC
         LIMIT 1`
      )
      .bind(subjectNorm, msg.date - THIRTY_DAYS, ...participants, ...participants)
      .first<{ id: number }>();
    if (row) return { threadId: row.id, created: false };
  }

  const inserted = await db
    .prepare("INSERT INTO threads (subject_norm, last_message_at) VALUES (?, ?)")
    .bind(subjectNorm, msg.date)
    .run();
  return { threadId: Number(inserted.meta.last_row_id), created: true };
}
