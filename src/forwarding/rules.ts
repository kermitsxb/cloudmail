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
