import type { Env } from "../env";
import { RETAINED_FOLDERS_SQL } from "../db/folders";
import { purgeMessage } from "../db/mutations";

// Plafond par passage : le plan gratuit limite le temps CPU d'une invocation. Le reste
// part au passage suivant.
export const TRASH_PURGE_BATCH = 100;

const DAY = 86_400;

// Nombre de jours de conservation, ou null si la purge est désactivée. Une valeur absente
// ou illisible ne supprime jamais rien. String() couvre un nombre JSON posé dans
// wrangler.overrides.json.
export function retentionDays(env: { TRASH_RETENTION_DAYS?: unknown }): number | null {
  const raw = String(env.TRASH_RETENTION_DAYS ?? "").trim();
  if (!/^\d+$/.test(raw)) return null;
  const days = Number(raw);
  return days > 0 ? days : null;
}

export type TrashPurgeResult = { purged: number; failed: number; remaining: number };

// Purge les messages entrés en corbeille ou en spam avant now − days, les plus anciens
// d'abord, via purgeMessage : l'ordre R2 puis D1 est conservé, et un échec laisse la ligne en
// place pour le passage suivant. `now` en secondes.
export async function purgeExpiredTrash(
  env: Env,
  now: number,
  days: number,
  batch = TRASH_PURGE_BATCH,
): Promise<TrashPurgeResult> {
  const cutoff = now - days * DAY;
  // Corbeille et spam partagent la même rétention : trashed_at date l'entrée dans l'un ou l'autre.
  const expired = `FROM messages WHERE folder IN (${RETAINED_FOLDERS_SQL}) AND trashed_at IS NOT NULL AND trashed_at < ?`;

  const rows = await env.DB.prepare(`SELECT id ${expired} ORDER BY trashed_at, id LIMIT ?`)
    .bind(cutoff, batch).all<{ id: number }>();

  let purged = 0;
  let failed = 0;
  for (const { id } of rows.results) {
    try {
      // Les ids ont été sélectionnés une fois avant la boucle ; entre cette sélection et le
      // tour de boucle courant, l'utilisateur a pu restaurer ce message précis (ou le remettre
      // à la corbeille assez récemment). purgeMessage ne revérifie pas le dossier lui-même, donc
      // on revérifie ici, juste avant de purger, que le message est toujours un message expiré
      // de la corbeille ; sinon on le laisse de côté sans le compter ni comme purgé ni comme en
      // échec.
      const stillExpired = await env.DB
        .prepare(`SELECT 1 ${expired} AND id = ?`)
        .bind(cutoff, id)
        .first();
      if (!stillExpired) continue;

      if (await purgeMessage(env, id, cutoff)) purged++;
    } catch (err) {
      failed++;
      console.error(JSON.stringify({
        event: "maintenance_purge_failed",
        messageId: id,
        error: err instanceof Error ? err.message : String(err),
      }));
    }
  }

  const left = await env.DB.prepare(`SELECT COUNT(*) AS n ${expired}`).bind(cutoff).first<{ n: number }>();
  return { purged, failed, remaining: left?.n ?? 0 };
}
