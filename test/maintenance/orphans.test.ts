import { env, applyD1Migrations } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../../src/env";
import { checkOrphans } from "../../src/maintenance/orphans";

interface TestEnv {
  TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
}

const testEnv = env as unknown as TestEnv;
const workerEnv = env as unknown as Env;

beforeAll(async () => {
  await applyD1Migrations(env.DB, testEnv.TEST_MIGRATIONS);
});

beforeEach(async () => {
  await env.DB.batch([env.DB.prepare("DELETE FROM messages"), env.DB.prepare("DELETE FROM threads")]);
  let cursor: string | undefined;
  do {
    const page = await env.MAIL.list({ cursor });
    if (page.objects.length > 0) await env.MAIL.delete(page.objects.map((o) => o.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
});

const key = (n: number) => `raw/${String(n).padStart(64, "0")}.eml`;
const putRaw = async (n: number) => env.MAIL.put(key(n), `Subject: ${n}\r\n\r\ncorps\r\n`);

const insertKnown = async (n: number) => {
  const thread = await env.DB.prepare(
    "INSERT INTO threads (subject_norm, last_message_at) VALUES ('x', 0)"
  ).run();
  await env.DB.prepare(
    `INSERT INTO messages (thread_id, message_id, direction, folder, from_addr, received_at, raw_key)
     VALUES (?, ?, 'in', 'inbox', 'zoe@example.com', 0, ?)`
  ).bind(thread.meta.last_row_id, `<k${n}@example.com>`, key(n)).run();
};

describe("checkOrphans", () => {
  it("compte les bruts sans ligne D1 sur toutes les pages", async () => {
    for (let n = 1; n <= 5; n++) await putRaw(n);
    await insertKnown(3);

    const res = await checkOrphans(workerEnv, { pageSize: 2 });

    expect(res).toEqual({ count: 4, complete: true, sample: [key(1), key(2), key(4), key(5)] });
  });

  it("signale une vérification partielle quand le plafond de pages est atteint", async () => {
    for (let n = 1; n <= 5; n++) await putRaw(n);

    const res = await checkOrphans(workerEnv, { pageSize: 2, maxPages: 2 });

    expect(res).toEqual({ count: 4, complete: false, sample: [key(1), key(2), key(3), key(4)] });
  });

  it("limite l'échantillon à 20 clés", async () => {
    for (let n = 1; n <= 25; n++) await putRaw(n);

    const res = await checkOrphans(workerEnv);

    expect(res.count).toBe(25);
    expect(res.sample).toHaveLength(20);
  });

  it("renvoie zéro sur un stockage vide", async () => {
    expect(await checkOrphans(workerEnv)).toEqual({ count: 0, complete: true, sample: [] });
  });
});
