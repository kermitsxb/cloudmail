import type { Env } from "../env";
import { checkOrphans } from "./orphans";
import { recordRun, type MaintenanceRun, type MaintenanceTrigger, type NewMaintenanceRun } from "./runs";
import { purgeExpiredTrash, retentionDays } from "./trash";

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

const blankRun = (now: number, trigger: MaintenanceTrigger): NewMaintenanceRun => ({
  ranAt: now, trigger, trashPurged: null, trashFailed: null, trashRemaining: null,
  orphansCount: null, orphansComplete: null, orphansSample: [], error: null,
});

async function trashStep(env: Env, now: number, run: NewMaintenanceRun, errors: string[]): Promise<void> {
  const days = retentionDays(env);
  if (days === null) {
    console.log(JSON.stringify({ event: "maintenance_trash_disabled", value: env.TRASH_RETENTION_DAYS ?? null }));
    return;
  }
  try {
    const res = await purgeExpiredTrash(env, now, days);
    run.trashPurged = res.purged;
    run.trashFailed = res.failed;
    run.trashRemaining = res.remaining;
  } catch (err) {
    errors.push(`trash: ${errorMessage(err)}`);
  }
}

async function orphanStep(env: Env, run: NewMaintenanceRun, errors: string[]): Promise<void> {
  try {
    const res = await checkOrphans(env);
    run.orphansCount = res.count;
    run.orphansComplete = res.complete;
    run.orphansSample = res.sample;
  } catch (err) {
    errors.push(`orphans: ${errorMessage(err)}`);
  }
}

// Enregistre le passage et écrit une ligne de log, même si l'enregistrement échoue.
async function finish(env: Env, run: NewMaintenanceRun, errors: string[]): Promise<MaintenanceRun | null> {
  run.error = errors.length > 0 ? errors.join("; ") : null;
  let recorded: MaintenanceRun | null = null;
  let recordError: string | null = null;
  try {
    recorded = await recordRun(env, run);
  } catch (err) {
    recordError = errorMessage(err);
  }
  const line = JSON.stringify({
    event: "maintenance",
    trigger: run.trigger,
    trashPurged: run.trashPurged,
    trashFailed: run.trashFailed,
    trashRemaining: run.trashRemaining,
    orphansCount: run.orphansCount,
    orphansComplete: run.orphansComplete,
    error: run.error,
    recordError,
  });
  if (run.error || recordError) console.error(line);
  else console.log(line);
  return recorded;
}

// Passage planifié : purge de la corbeille puis vérification des orphelins, chacune
// rattrapant ses propres erreurs. Ne lève jamais ; null si le passage n'a pas pu être
// enregistré (la ligne de log part quand même). `now` en secondes.
export async function runMaintenance(env: Env, now: number): Promise<MaintenanceRun | null> {
  const run = blankRun(now, "cron");
  const errors: string[] = [];
  await trashStep(env, now, run, errors);
  await orphanStep(env, run, errors);
  return finish(env, run, errors);
}

// Vérification à la demande depuis la vue Maintenance : jamais de purge.
export async function runOrphanCheck(env: Env, now: number): Promise<MaintenanceRun | null> {
  const run = blankRun(now, "manual");
  const errors: string[] = [];
  await orphanStep(env, run, errors);
  return finish(env, run, errors);
}
