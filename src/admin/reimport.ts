import type { Env } from "../env";

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
