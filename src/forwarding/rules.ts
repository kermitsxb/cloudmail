export const CATCH_ALL = "*";

export type ForwardRule = {
  id: number;
  matchLocal: string;
  destination: string;
  enabled: boolean;
  createdAt: number;
  lastAttemptAt: number | null;
  lastStatus: "ok" | "error" | null;
  lastError: string | null;
};

// Une destination à servir, et les règles qui l'ont demandée. Le tableau
// `ruleIds` en porte plusieurs quand des règles distinctes pointent vers la même
// adresse : on n'envoie alors qu'une copie, mais chaque règle reçoit son statut.
export type Match = { ruleIds: number[]; destination: string };

// Partie locale normalisée d'une adresse, ou null si l'adresse n'en a pas
// d'exploitable. On coupe sur la DERNIÈRE arobase : une partie locale citée peut
// légalement en contenir une (`"a@b"@example.com`), le domaine jamais.
export function localPart(address: string): string | null {
  const at = address.lastIndexOf("@");
  if (at <= 0) return null;
  return address.slice(0, at).toLowerCase();
}

export async function matchingDestinations(db: D1Database, to: string): Promise<Match[]> {
  const local = localPart(to);
  const { results } = await db
    .prepare(
      `SELECT id, destination FROM forward_rules
        WHERE enabled = 1 AND (match_local = ? OR match_local = ?)
        ORDER BY id`
    )
    // Quand l'adresse n'a pas de partie locale exploitable, les deux paramètres
    // valent '*' : seules les règles catch-all s'appliquent.
    .bind(CATCH_ALL, local ?? CATCH_ALL)
    .all<{ id: number; destination: string }>();

  const byDestination = new Map<string, Match>();
  for (const row of results) {
    const key = row.destination.toLowerCase();
    const existing = byDestination.get(key);
    if (existing) existing.ruleIds.push(row.id);
    else byDestination.set(key, { ruleIds: [row.id], destination: row.destination });
  }
  return [...byDestination.values()];
}

export type AttemptResult = { ruleIds: number[]; status: "ok" | "error"; error?: string };

// Borne de stockage du message d'erreur. Les erreurs de l'API Cloudflare sont
// courtes ; la borne existe pour qu'une exception inattendue et volumineuse ne
// fasse pas grossir indéfiniment une ligne relue à chaque affichage de l'UI.
const MAX_ERROR_CHARS = 500;

export async function recordAttempts(
  db: D1Database,
  results: AttemptResult[],
  now: number,
): Promise<void> {
  const statements = results.flatMap((r) =>
    r.ruleIds.map((id) =>
      db
        .prepare(
          `UPDATE forward_rules
              SET last_attempt_at = ?, last_status = ?, last_error = ?
            WHERE id = ?`
        )
        .bind(
          now,
          r.status,
          r.status === "error" ? (r.error ?? "Erreur inconnue").slice(0, MAX_ERROR_CHARS) : null,
          id,
        )
    )
  );
  // db.batch() rejette un tableau vide : on sort avant plutôt que de laisser
  // remonter une erreur pour un cas parfaitement normal (aucune règle ne matche).
  if (statements.length === 0) return;
  await db.batch(statements);
}

type ForwardRuleRow = {
  id: number;
  match_local: string;
  destination: string;
  enabled: number;
  created_at: number;
  last_attempt_at: number | null;
  last_status: "ok" | "error" | null;
  last_error: string | null;
};

const toForwardRule = (row: ForwardRuleRow): ForwardRule => ({
  id: row.id,
  matchLocal: row.match_local,
  destination: row.destination,
  enabled: row.enabled === 1,
  createdAt: row.created_at,
  lastAttemptAt: row.last_attempt_at,
  lastStatus: row.last_status,
  lastError: row.last_error,
});

const SELECT_COLUMNS =
  "id, match_local, destination, enabled, created_at, last_attempt_at, last_status, last_error";

export async function listForwardRules(db: D1Database): Promise<ForwardRule[]> {
  // Les catch-all d'abord, puis l'ordre alphabétique : l'interface liste ainsi la
  // règle la plus large en tête, ce qui reflète la sémantique cumulative.
  const { results } = await db
    .prepare(
      `SELECT ${SELECT_COLUMNS} FROM forward_rules
        ORDER BY (match_local = '*') DESC, match_local, destination`
    )
    .all<ForwardRuleRow>();
  return results.map(toForwardRule);
}

export async function createForwardRule(
  db: D1Database,
  input: { matchLocal: string; destination: string },
  now: number,
): Promise<ForwardRule | null> {
  // On s'appuie sur l'index unique plutôt que sur un SELECT préalable : deux
  // requêtes concurrentes passeraient toutes les deux la vérification, l'index
  // est la seule garantie réelle.
  const row = await db
    .prepare(
      `INSERT INTO forward_rules (match_local, destination, enabled, created_at)
       VALUES (?, ?, 1, ?)
       ON CONFLICT (match_local, destination) DO NOTHING
       RETURNING ${SELECT_COLUMNS}`
    )
    .bind(input.matchLocal, input.destination, now)
    .first<ForwardRuleRow>();
  return row ? toForwardRule(row) : null;
}

export async function setForwardRuleEnabled(
  db: D1Database,
  id: number,
  enabled: boolean,
): Promise<boolean> {
  const { meta } = await db
    .prepare("UPDATE forward_rules SET enabled = ? WHERE id = ?")
    .bind(enabled ? 1 : 0, id)
    .run();
  return meta.changes > 0;
}

export async function deleteForwardRule(db: D1Database, id: number): Promise<boolean> {
  const { meta } = await db.prepare("DELETE FROM forward_rules WHERE id = ?").bind(id).run();
  return meta.changes > 0;
}
