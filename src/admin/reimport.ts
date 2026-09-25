import type { Env } from "../env";
import { parseEmail } from "../ingest/parse";
import {
  attachmentStatements,
  parsedColumns,
  putAttachments,
  recipientStatements,
  storeIncoming,
} from "../ingest/store";

// Seules les clés de brut entrant sont réimportables. Les messages envoyés ont une clé
// sent/<id> sans objet R2, et les pièces jointes vivent sous att/ : ce motif ferme aussi
// la porte à toute clé fabriquée (chemin relatif, autre préfixe).
export const RAW_KEY_PATTERN = /^raw\/[0-9a-f]{64}\.eml$/;

export const ORPHAN_PAGE_SIZE = 500;
export const PARSE_ERRORS_PAGE_SIZE = 50;

export type Orphan = { key: string; size: number; uploaded: string };

// Une page de raw/ dans R2, moins les clés connues de D1. Une page sans orphelin avec un
// curseur non nul est normale : l'appelant continue jusqu'à cursor === null.
export async function listOrphans(
  env: Env,
  opts: { cursor?: string; limit?: number } = {},
): Promise<{ orphans: Orphan[]; cursor: string | null }> {
  const page = await env.MAIL.list({
    prefix: "raw/",
    limit: opts.limit ?? ORPHAN_PAGE_SIZE,
    cursor: opts.cursor,
  });
  const keys = page.objects.map((o) => o.key);

  let known = new Set<string>();
  if (keys.length > 0) {
    // Les clés passent en un seul paramètre JSON : D1 plafonne à 100 paramètres liés par
    // requête, une page de 500 clés en IN (?, ?, …) serait refusée.
    const rows = await env.DB.prepare(
      "SELECT DISTINCT raw_key FROM messages WHERE raw_key IN (SELECT value FROM json_each(?))"
    ).bind(JSON.stringify(keys)).all<{ raw_key: string }>();
    known = new Set(rows.results.map((r) => r.raw_key));
  }

  return {
    orphans: page.objects
      .filter((o) => !known.has(o.key))
      .map((o) => ({ key: o.key, size: o.size, uploaded: o.uploaded.toISOString() })),
    cursor: page.truncated ? page.cursor : null,
  };
}

export type ParseErrorMessage = { id: number; rawKey: string; subject: string | null; receivedAt: number };

// Messages reçus que le parseur n'a pas compris, du plus récent au plus ancien. Pagination
// par clé (id décroissant) : le curseur est le dernier id renvoyé.
export async function listParseErrors(
  env: Env,
  opts: { cursor?: number; limit?: number } = {},
): Promise<{ messages: ParseErrorMessage[]; cursor: string | null }> {
  const limit = opts.limit ?? PARSE_ERRORS_PAGE_SIZE;
  const rows = await env.DB.prepare(
    `SELECT id, raw_key, subject, received_at FROM messages
      WHERE direction = 'in' AND parse_error = 1 AND (?1 IS NULL OR id < ?1)
      ORDER BY id DESC LIMIT ?2`
  ).bind(opts.cursor ?? null, limit + 1).all<{ id: number; raw_key: string; subject: string | null; received_at: number }>();

  const page = rows.results.slice(0, limit);
  const last = page[page.length - 1];
  return {
    messages: page.map((r) => ({ id: r.id, rawKey: r.raw_key, subject: r.subject, receivedAt: r.received_at })),
    cursor: rows.results.length > limit && last ? String(last.id) : null,
  };
}

// Expéditeur d'enveloppe d'un orphelin : l'enveloppe n'est stockée nulle part. L'en-tête
// From prime ; cette valeur n'apparaît que si le message est totalement illisible. .invalid
// est le TLD réservé à cet usage (RFC 2606).
export const ORPHAN_ENVELOPE_FROM = "unknown@invalid";

export type ReimportResult =
  | { key: string; outcome: "imported"; messageIds: number[] }
  | { key: string; outcome: "reparsed"; messageIds: number[] }
  | { key: string; outcome: "duplicate"; messageIds: number[] }
  | { key: string; outcome: "not_found" }
  | { key: string; outcome: "error"; error: string };

type ExistingRow = { id: number; message_id: string; from_addr: string };

// Supprime des objets R2 sans jamais lever : un échec ici ne laisse qu'un objet de pièce
// jointe inutilisé, jamais une perte de contenu.
async function deleteQuietly(env: Env, keys: string[], rawKey: string): Promise<void> {
  if (keys.length === 0) return;
  try {
    await env.MAIL.delete(keys);
  } catch (err) {
    console.error(JSON.stringify({
      event: "reimport_cleanup_failed",
      key: rawKey,
      objects: keys,
      error: err instanceof Error ? err.message : String(err),
    }));
  }
}

// Réanalyse une ligne existante sur place. Seules les colonnes issues du parsing sont
// réécrites : id, thread_id, folder, is_read, direction et raw_key ne bougent jamais, donc
// les compteurs du thread non plus, et aucun thread ne peut se retrouver vide.
async function reparseInPlace(env: Env, rawKey: string, raw: ArrayBuffer, row: ExistingRow): Promise<void> {
  const msg = await parseEmail(raw, row.from_addr);
  // Un identifiant inventé change à chaque parsing : on garde celui déjà en base.
  const messageId = msg.messageIdSynthetic ? row.message_id : msg.messageId;

  if (messageId !== row.message_id) {
    const clash = await env.DB.prepare("SELECT id FROM messages WHERE message_id = ? AND id != ?")
      .bind(messageId, row.id).first<{ id: number }>();
    if (clash) throw new Error(`Message-ID déjà utilisé par le message #${clash.id}`);
  }

  const oldKeys = (await env.DB.prepare("SELECT r2_key FROM attachments WHERE message_id = ?")
    .bind(row.id).all<{ r2_key: string }>()).results.map((r) => r.r2_key);

  // R2 d'abord : les nouvelles pièces jointes existent avant la ligne qui les référence.
  const stored = await putAttachments(env, messageId, msg.attachments);
  const newKeys = stored.map((s) => s.r2Key);

  // Même correspondance colonnes <- message parsé que storeIncoming (src/ingest/store.ts) :
  // une ligne réanalysée doit porter exactement les valeurs qu'une ingestion neuve du même
  // brut produirait.
  const cols = parsedColumns(msg, messageId);

  try {
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE messages
            SET message_id = ?, in_reply_to = ?, from_addr = ?, from_name = ?, subject = ?,
                text_body = ?, html_body = ?, snippet = ?, received_at = ?, has_attachments = ?,
                parse_error = ?, body_truncated = ?
          WHERE id = ?`
      ).bind(
        cols.messageId, cols.inReplyTo, cols.fromAddr, cols.fromName, cols.subject,
        cols.textBody, cols.htmlBody, cols.snippet, cols.receivedAt, cols.hasAttachments,
        cols.parseError, cols.bodyTruncated, row.id,
      ),
      env.DB.prepare("DELETE FROM recipients WHERE message_id = ?").bind(row.id),
      ...recipientStatements(env.DB, row.id, msg),
      env.DB.prepare("DELETE FROM attachments WHERE message_id = ?").bind(row.id),
      ...attachmentStatements(env.DB, row.id, stored),
      // La date du message a pu changer : on recalcule celle du thread sur ses messages.
      env.DB.prepare(
        `UPDATE threads
            SET last_message_at = (SELECT MAX(received_at) FROM messages WHERE thread_id = threads.id)
          WHERE id = (SELECT thread_id FROM messages WHERE id = ?)`
      ).bind(row.id),
    ]);
  } catch (err) {
    // Lot annulé : la ligne pointe toujours vers les anciennes clés. On retire les objets
    // écrits pour rien ; une clé commune aux deux ensembles a été réécrite avec des octets
    // tirés du même brut, rien n'est perdu.
    await deleteQuietly(env, newKeys.filter((k) => !oldKeys.includes(k)), rawKey);
    throw err;
  }

  // Lot validé : plus rien ne référence les anciennes clés absentes du nouvel ensemble.
  await deleteQuietly(env, oldKeys.filter((k) => !newKeys.includes(k)), rawKey);
}

async function reimport(env: Env, rawKey: string): Promise<ReimportResult> {
  const obj = await env.MAIL.get(rawKey);
  if (!obj) return { key: rawKey, outcome: "not_found" };
  const raw = await obj.arrayBuffer();

  const rows = await env.DB.prepare(
    "SELECT id, message_id, from_addr FROM messages WHERE raw_key = ? AND direction = 'in' ORDER BY id"
  ).bind(rawKey).all<ExistingRow>();

  if (rows.results.length === 0) {
    // Orphelin : même chemin qu'un message qui arrive. Son écriture R2 est un no-op (clé
    // adressée par contenu, objet déjà présent). Aucune redirection n'est rejouée.
    const res = await storeIncoming(env, raw, { from: ORPHAN_ENVELOPE_FROM, to: "" });
    const ids = res.messageId === null ? [] : [res.messageId];
    return { key: rawKey, outcome: res.duplicate ? "duplicate" : "imported", messageIds: ids };
  }

  for (const row of rows.results) await reparseInPlace(env, rawKey, raw, row);
  return { key: rawKey, outcome: "reparsed", messageIds: rows.results.map((r) => r.id) };
}

// Point d'entrée unique du réimport. Ne lève jamais : un échec devient un résultat, pour
// qu'un message défaillant ne masque pas les autres clés du même lot.
export async function reimportKey(env: Env, rawKey: string, by: string): Promise<ReimportResult> {
  let result: ReimportResult;
  try {
    result = await reimport(env, rawKey);
  } catch (err) {
    result = { key: rawKey, outcome: "error", error: err instanceof Error ? err.message : String(err) };
  }
  console.log(JSON.stringify({ event: "reimport", ...result, by }));
  return result;
}
