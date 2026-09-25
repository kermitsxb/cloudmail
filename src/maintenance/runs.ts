import type { Env } from "../env";

export type MaintenanceTrigger = "cron" | "manual";

export type MaintenanceRun = {
  id: number;
  ranAt: number;
  trigger: MaintenanceTrigger;
  // null : purge non exécutée (vérification manuelle, ou rétention désactivée, ou échec).
  trashPurged: number | null;
  trashFailed: number | null;
  trashRemaining: number | null;
  // null : vérification en échec.
  orphansCount: number | null;
  orphansComplete: boolean | null;
  orphansSample: string[];
  error: string | null;
};

export type NewMaintenanceRun = Omit<MaintenanceRun, "id">;

export const MAINTENANCE_RUNS_KEPT = 30;

type Row = {
  id: number;
  ran_at: number;
  trigger: MaintenanceTrigger;
  trash_purged: number | null;
  trash_failed: number | null;
  trash_remaining: number | null;
  orphans_count: number | null;
  orphans_complete: number | null;
  orphans_sample: string | null;
  error: string | null;
};

const toRun = (r: Row): MaintenanceRun => ({
  id: r.id,
  ranAt: r.ran_at,
  trigger: r.trigger,
  trashPurged: r.trash_purged,
  trashFailed: r.trash_failed,
  trashRemaining: r.trash_remaining,
  orphansCount: r.orphans_count,
  orphansComplete: r.orphans_complete === null ? null : r.orphans_complete === 1,
  orphansSample: r.orphans_sample ? (JSON.parse(r.orphans_sample) as string[]) : [],
  error: r.error,
});

// Insère le passage et ne garde que les MAINTENANCE_RUNS_KEPT plus récents, en un lot.
export async function recordRun(env: Env, run: NewMaintenanceRun): Promise<MaintenanceRun> {
  const [inserted] = await env.DB.batch<Row>([
    env.DB.prepare(
      `INSERT INTO maintenance_runs
         (ran_at, trigger, trash_purged, trash_failed, trash_remaining,
          orphans_count, orphans_complete, orphans_sample, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       RETURNING *`
    ).bind(
      run.ranAt, run.trigger, run.trashPurged, run.trashFailed, run.trashRemaining,
      run.orphansCount, run.orphansComplete === null ? null : run.orphansComplete ? 1 : 0,
      JSON.stringify(run.orphansSample), run.error,
    ),
    env.DB.prepare(
      "DELETE FROM maintenance_runs WHERE id NOT IN (SELECT id FROM maintenance_runs ORDER BY id DESC LIMIT ?)"
    ).bind(MAINTENANCE_RUNS_KEPT),
  ]);
  return toRun(inserted.results[0]);
}

// lastRun : dernier passage planifié (ce qu'a fait la dernière nuit). lastCheck : dernière
// vérification des orphelins réussie, planifiée ou manuelle. Deux champs, car une
// vérification manuelle écrit une ligne sans colonnes de corbeille qui ne doit pas masquer
// la dernière purge. Sans la migration, « jamais passé » plutôt qu'une erreur.
export async function latestRuns(env: Env): Promise<{ lastRun: MaintenanceRun | null; lastCheck: MaintenanceRun | null }> {
  try {
    const [cron, check] = await env.DB.batch<Row>([
      env.DB.prepare("SELECT * FROM maintenance_runs WHERE trigger = 'cron' ORDER BY id DESC LIMIT 1"),
      env.DB.prepare("SELECT * FROM maintenance_runs WHERE orphans_count IS NOT NULL ORDER BY id DESC LIMIT 1"),
    ]);
    return {
      lastRun: cron.results[0] ? toRun(cron.results[0]) : null,
      lastCheck: check.results[0] ? toRun(check.results[0]) : null,
    };
  } catch (err) {
    if (err instanceof Error && err.message.includes("no such table")) return { lastRun: null, lastCheck: null };
    throw err;
  }
}
