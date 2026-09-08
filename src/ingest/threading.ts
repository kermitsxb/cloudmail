import { normalizeSubject, type ParsedMessage } from "./parse";

export type ThreadResolution = { threadId: number; created: boolean };

const THIRTY_DAYS = 30 * 86400;

// Borne haute du nombre d'adresses comparées lors du rattrapage par sujet. Elle ne sert
// plus à contourner la limite de paramètres liés (json_each n'en consomme qu'un) mais à
// borner le coût de la requête sur un message à plusieurs centaines de destinataires.
const MAX_PARTICIPANTS = 100;

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
  // La liste des participants est passée en UN SEUL paramètre lié (un tableau JSON déplié
  // par json_each) au lieu d'un IN (?, ?, ...) répété deux fois. D1 plafonne à 100 le nombre
  // de paramètres liés par requête : l'ancienne forme en liait 2 + 2 × participants, donc
  // levait dès ~49 participants — une liste de diffusion ou une longue chaîne en
  // répondre-à-tous, exactement les cas où le rattrapage par sujet sert. La requête ne lie
  // plus que 3 paramètres, quel que soit le nombre de participants.
  const uniqueParticipants = [...new Set(participants.filter(Boolean))].slice(0, MAX_PARTICIPANTS);
  if (subjectNorm && uniqueParticipants.length > 0) {
    const row = await db
      .prepare(
        `SELECT t.id FROM threads t
         JOIN messages m ON m.thread_id = t.id
         LEFT JOIN recipients r ON r.message_id = m.id
         WHERE t.subject_norm = ?
           AND t.last_message_at >= ?
           AND EXISTS (
             SELECT 1 FROM json_each(?) p
             WHERE p.value = m.from_addr OR p.value = r.address
           )
         ORDER BY t.last_message_at DESC
         LIMIT 1`
      )
      .bind(subjectNorm, msg.date - THIRTY_DAYS, JSON.stringify(uniqueParticipants))
      .first<{ id: number }>();
    if (row) return { threadId: row.id, created: false };
  }

  const inserted = await db
    .prepare("INSERT INTO threads (subject_norm, last_message_at) VALUES (?, ?)")
    .bind(subjectNorm, msg.date)
    .run();
  return { threadId: Number(inserted.meta.last_row_id), created: true };
}
