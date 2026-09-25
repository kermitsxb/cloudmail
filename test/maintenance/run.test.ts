import { env, applyD1Migrations, createExecutionContext, createScheduledController, waitOnExecutionContext } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../../src/env";
import worker from "../../src/index";
import { runMaintenance, runOrphanCheck } from "../../src/maintenance/run";
import { MAINTENANCE_RUNS_KEPT, latestRuns, recordRun, type NewMaintenanceRun } from "../../src/maintenance/runs";

interface TestEnv {
  TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
}

const testEnv = env as unknown as TestEnv;
const workerEnv = env as unknown as Env;
const DAY = 86_400;
const NOW = 1_800_000_000;

beforeAll(async () => {
  await applyD1Migrations(env.DB, testEnv.TEST_MIGRATIONS);
});

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM maintenance_runs"),
    env.DB.prepare("DELETE FROM attachments"),
    env.DB.prepare("DELETE FROM recipients"),
    env.DB.prepare("DELETE FROM messages"),
    env.DB.prepare("DELETE FROM threads"),
  ]);
  let cursor: string | undefined;
  do {
    const page = await env.MAIL.list({ cursor });
    if (page.objects.length > 0) await env.MAIL.delete(page.objects.map((o) => o.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
});

const key = (n: number) => `raw/${String(n).padStart(64, "0")}.eml`;

let seq = 0;
const insertTrashed = async (trashedAt: number) => {
  seq++;
  await env.MAIL.put(key(1000 + seq), "Subject: x\r\n\r\ncorps\r\n");
  const thread = await env.DB.prepare("INSERT INTO threads (subject_norm, last_message_at) VALUES ('x', 0)").run();
  await env.DB.prepare(
    `INSERT INTO messages (thread_id, message_id, direction, folder, from_addr, received_at, raw_key, trashed_at)
     VALUES (?, ?, 'in', 'trash', 'zoe@example.com', 0, ?, ?)`
  ).bind(thread.meta.last_row_id, `<t${seq}@example.com>`, key(1000 + seq), trashedAt).run();
};

const blank = (over: Partial<NewMaintenanceRun> = {}): NewMaintenanceRun => ({
  ranAt: NOW, trigger: "cron", trashPurged: null, trashFailed: null, trashRemaining: null,
  orphansCount: null, orphansComplete: null, orphansSample: [], error: null, ...over,
});

// D1 dont prepare() lève pour les requêtes contenant `needle` ; le reste passe au vrai D1.
const failingDb = (needle: string) =>
  new Proxy(env.DB, {
    get(target, prop) {
      if (prop === "prepare") {
        return (sql: string) => {
          if (sql.includes(needle)) throw new Error("D1 indisponible");
          return target.prepare(sql);
        };
      }
      const value = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });

describe("runMaintenance", () => {
  it("purge la corbeille expirée, compte les orphelins et enregistre un passage cron", async () => {
    await insertTrashed(NOW - 31 * DAY);
    await env.MAIL.put(key(1), "Subject: orphelin\r\n\r\ncorps\r\n");

    const run = await runMaintenance(workerEnv, NOW);

    expect(run).toMatchObject({
      ranAt: NOW, trigger: "cron", trashPurged: 1, trashFailed: 0, trashRemaining: 0,
      orphansCount: 1, orphansComplete: true, orphansSample: [key(1)], error: null,
    });
    const { n } = (await env.DB.prepare("SELECT COUNT(*) AS n FROM maintenance_runs").first<{ n: number }>())!;
    expect(n).toBe(1);
  });

  it("ne purge rien quand la rétention est désactivée", async () => {
    await insertTrashed(NOW - 400 * DAY);

    const run = await runMaintenance({ ...workerEnv, TRASH_RETENTION_DAYS: "0" }, NOW);

    expect(run).toMatchObject({ trashPurged: null, orphansCount: 0, error: null });
    const { n } = (await env.DB.prepare("SELECT COUNT(*) AS n FROM messages").first<{ n: number }>())!;
    expect(n).toBe(1);
  });

  it("vérifie les orphelins même si la purge échoue", async () => {
    await env.MAIL.put(key(1), "Subject: orphelin\r\n\r\ncorps\r\n");

    const run = await runMaintenance({ ...workerEnv, DB: failingDb("trashed_at <") }, NOW);

    expect(run).toMatchObject({ trashPurged: null, orphansCount: 1 });
    expect(run?.error).toMatch(/^trash: /);
  });

  it("purge même si la vérification des orphelins échoue", async () => {
    await insertTrashed(NOW - 31 * DAY);
    const brokenMail = {
      list: async () => { throw new Error("R2 indisponible"); },
      delete: (keys: string | string[]) => env.MAIL.delete(keys),
    } as unknown as R2Bucket;

    const run = await runMaintenance({ ...workerEnv, MAIL: brokenMail }, NOW);

    expect(run).toMatchObject({ trashPurged: 1, orphansCount: null, orphansComplete: null });
    expect(run?.error).toMatch(/orphans: R2 indisponible/);
  });

  it("ne lève pas quand l'enregistrement échoue", async () => {
    const run = await runMaintenance({ ...workerEnv, DB: failingDb("maintenance_runs") }, NOW);
    expect(run).toBeNull();
  });
});

describe("runOrphanCheck", () => {
  it("n'exécute que la vérification et enregistre un passage manuel", async () => {
    await insertTrashed(NOW - 400 * DAY);

    const run = await runOrphanCheck(workerEnv, NOW);

    expect(run).toMatchObject({ trigger: "manual", trashPurged: null, orphansCount: 0 });
    const { n } = (await env.DB.prepare("SELECT COUNT(*) AS n FROM messages").first<{ n: number }>())!;
    expect(n).toBe(1);
  });
});

describe("recordRun / latestRuns", () => {
  it(`ne garde que les ${MAINTENANCE_RUNS_KEPT} derniers passages`, async () => {
    for (let i = 0; i < MAINTENANCE_RUNS_KEPT + 2; i++) await recordRun(workerEnv, blank({ ranAt: i }));
    const rows = await env.DB.prepare("SELECT ran_at FROM maintenance_runs ORDER BY id").all<{ ran_at: number }>();
    expect(rows.results).toHaveLength(MAINTENANCE_RUNS_KEPT);
    expect(rows.results[0].ran_at).toBe(2);
  });

  it("distingue le dernier passage planifié de la dernière vérification réussie", async () => {
    await recordRun(workerEnv, blank({ ranAt: 1, trigger: "cron", trashPurged: 4, orphansCount: 2, orphansComplete: true }));
    await recordRun(workerEnv, blank({ ranAt: 2, trigger: "manual", orphansCount: 0, orphansComplete: true }));
    await recordRun(workerEnv, blank({ ranAt: 3, trigger: "manual", error: "orphans: R2 indisponible" }));

    const { lastRun, lastCheck } = await latestRuns(workerEnv);

    expect(lastRun).toMatchObject({ ranAt: 1, trigger: "cron", trashPurged: 4 });
    expect(lastCheck).toMatchObject({ ranAt: 2, trigger: "manual", orphansCount: 0, orphansComplete: true });
  });

  it("renvoie null sans passage enregistré", async () => {
    expect(await latestRuns(workerEnv)).toEqual({ lastRun: null, lastCheck: null });
  });

  it("renvoie null si la migration n'est pas appliquée", async () => {
    const db = { batch: async () => { throw new Error("D1_ERROR: no such table: maintenance_runs: SQLITE_ERROR"); }, prepare: (sql: string) => env.DB.prepare(sql) } as unknown as D1Database;
    expect(await latestRuns({ ...workerEnv, DB: db })).toEqual({ lastRun: null, lastCheck: null });
  });
});

describe("scheduled()", () => {
  it("enregistre un passage à l'heure planifiée", async () => {
    const ctrl = createScheduledController({ scheduledTime: new Date(NOW * 1000), cron: "17 3 * * *" });
    const ctx = createExecutionContext();

    await worker.scheduled!(ctrl, workerEnv, ctx);
    await waitOnExecutionContext(ctx);

    const row = await env.DB.prepare("SELECT ran_at, trigger FROM maintenance_runs").first<{ ran_at: number; trigger: string }>();
    expect(row).toEqual({ ran_at: NOW, trigger: "cron" });
  });
});
