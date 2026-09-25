import { env, applyD1Migrations } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../../src/env";
import { purgeExpiredTrash, retentionDays } from "../../src/maintenance/trash";

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

let seq = 0;
// Un message avec son thread et son brut R2 (sauf clé sent/…, qui n'a jamais d'objet).
const insertMessage = async (opts: { folder: "inbox" | "sent" | "trash"; trashedAt: number | null; rawKey?: string }) => {
  seq++;
  const rawKey = opts.rawKey ?? `raw/${String(seq).padStart(64, "0")}.eml`;
  if (rawKey.startsWith("raw/")) await env.MAIL.put(rawKey, `Subject: ${seq}\r\n\r\ncorps\r\n`);
  const thread = await env.DB.prepare(
    "INSERT INTO threads (subject_norm, last_message_at, message_count, unread_count) VALUES ('x', 0, 0, 0)"
  ).run();
  const res = await env.DB.prepare(
    `INSERT INTO messages (thread_id, message_id, direction, folder, from_addr, received_at, raw_key, trashed_at)
     VALUES (?, ?, 'in', ?, 'zoe@example.com', 0, ?, ?)`
  ).bind(thread.meta.last_row_id, `<m${seq}@example.com>`, opts.folder, rawKey, opts.trashedAt).run();
  return { id: Number(res.meta.last_row_id), rawKey };
};

const exists = async (id: number) =>
  (await env.DB.prepare("SELECT id FROM messages WHERE id = ?").bind(id).first()) !== null;

describe("retentionDays", () => {
  it("lit un nombre de jours positif", () => {
    expect(retentionDays({ TRASH_RETENTION_DAYS: "30" })).toBe(30);
    expect(retentionDays({ TRASH_RETENTION_DAYS: " 7 " })).toBe(7);
  });

  it("accepte un nombre JSON posé dans wrangler.overrides.json", () => {
    expect(retentionDays({ TRASH_RETENTION_DAYS: 30 })).toBe(30);
  });

  it("désactive la purge pour 0, vide, absent ou invalide", () => {
    for (const value of ["0", "", "abc", "-5", "1.5", undefined]) {
      expect(retentionDays({ TRASH_RETENTION_DAYS: value })).toBeNull();
    }
  });
});

describe("purgeExpiredTrash", () => {
  it("purge un message à la corbeille depuis plus de N jours, pas les autres", async () => {
    const old = await insertMessage({ folder: "trash", trashedAt: NOW - 31 * DAY });
    const recent = await insertMessage({ folder: "trash", trashedAt: NOW - 29 * DAY });
    const inbox = await insertMessage({ folder: "inbox", trashedAt: null });
    const undated = await insertMessage({ folder: "trash", trashedAt: null });

    expect(await purgeExpiredTrash(workerEnv, NOW, 30)).toEqual({ purged: 1, failed: 0, remaining: 0 });

    expect(await exists(old.id)).toBe(false);
    expect(await env.MAIL.head(old.rawKey)).toBeNull();
    expect(await exists(recent.id)).toBe(true);
    expect(await exists(inbox.id)).toBe(true);
    expect(await exists(undated.id)).toBe(true);
  });

  it("purge un message envoyé dont le brut n'existe pas dans R2", async () => {
    const sent = await insertMessage({ folder: "trash", trashedAt: NOW - 31 * DAY, rawKey: "sent/42" });
    expect(await purgeExpiredTrash(workerEnv, NOW, 30)).toEqual({ purged: 1, failed: 0, remaining: 0 });
    expect(await exists(sent.id)).toBe(false);
  });

  it("s'arrête au plafond et compte ce qui reste", async () => {
    for (let i = 0; i < 3; i++) await insertMessage({ folder: "trash", trashedAt: NOW - 40 * DAY + i });
    expect(await purgeExpiredTrash(workerEnv, NOW, 30, 2)).toEqual({ purged: 2, failed: 0, remaining: 1 });
  });

  it("purge les plus anciens d'abord", async () => {
    const newer = await insertMessage({ folder: "trash", trashedAt: NOW - 35 * DAY });
    const older = await insertMessage({ folder: "trash", trashedAt: NOW - 50 * DAY });
    await purgeExpiredTrash(workerEnv, NOW, 30, 1);
    expect(await exists(older.id)).toBe(false);
    expect(await exists(newer.id)).toBe(true);
  });

  it("continue après l'échec d'un message et le garde pour le prochain passage", async () => {
    const bad = await insertMessage({ folder: "trash", trashedAt: NOW - 40 * DAY });
    const good = await insertMessage({ folder: "trash", trashedAt: NOW - 39 * DAY });
    const brokenMail = {
      delete: async (keys: string | string[]) => {
        const list = Array.isArray(keys) ? keys : [keys];
        if (list.includes(bad.rawKey)) throw new Error("R2 indisponible");
        return env.MAIL.delete(list);
      },
    } as unknown as R2Bucket;

    const res = await purgeExpiredTrash({ ...workerEnv, MAIL: brokenMail }, NOW, 30);

    expect(res).toEqual({ purged: 1, failed: 1, remaining: 1 });
    expect(await exists(bad.id)).toBe(true);
    expect(await exists(good.id)).toBe(false);
  });
});
