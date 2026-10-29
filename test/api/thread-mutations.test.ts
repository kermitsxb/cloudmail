import { env, applyD1Migrations } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { moveToFolder, purgeThread, restoreThread, trashThread } from "../../src/db/mutations";
import { app } from "../../src/index";
import type { Env } from "../../src/env";

interface TestEnv {
  DB: D1Database;
  TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
}

const testEnv = env as unknown as TestEnv;
const workerEnv = env as unknown as Env;

beforeAll(async () => {
  await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
});

// Thread 1 : deux messages reçus non lus et un message envoyé. Thread 2 : un message témoin
// qui ne doit jamais bouger.
beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM purge_claims"),
    env.DB.prepare("DELETE FROM attachments"),
    env.DB.prepare("DELETE FROM recipients"),
    env.DB.prepare("DELETE FROM messages"),
    env.DB.prepare("DELETE FROM threads"),
  ]);
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO threads (id, subject_norm, last_message_at, message_count, unread_count) VALUES (1, 'x', 100, 3, 2)"
    ),
    env.DB.prepare(
      "INSERT INTO threads (id, subject_norm, last_message_at, message_count, unread_count) VALUES (2, 'y', 100, 1, 1)"
    ),
  ]);
  for (const [id, thread, direction, folder, isRead] of [
    [1, 1, "in", "inbox", 0],
    [2, 1, "in", "inbox", 0],
    [3, 1, "out", "sent", 1],
    [4, 2, "in", "inbox", 0],
  ] as const) {
    await env.DB.prepare(
      `INSERT INTO messages (id, thread_id, message_id, direction, folder, from_addr, subject, received_at, raw_key, is_read)
       VALUES (?, ?, ?, ?, ?, 'a@example.com', 'x', 100, ?, ?)`
    ).bind(id, thread, `<m${id}@example.com>`, direction, folder, `raw/m${id}.eml`, isRead).run();
    await env.MAIL.put(`raw/m${id}.eml`, "brut");
  }
});

const folders = async () =>
  Object.fromEntries(
    (await env.DB.prepare("SELECT id, folder FROM messages ORDER BY id").all<{ id: number; folder: string }>())
      .results.map((m) => [m.id, m.folder]),
  );
const counters = (id: number) =>
  env.DB.prepare("SELECT message_count, unread_count FROM threads WHERE id = ?").bind(id)
    .first<{ message_count: number; unread_count: number }>();

describe("trashThread", () => {
  it("met à la corbeille tous les messages de la conversation, et eux seuls", async () => {
    expect(await trashThread(env.DB, 1)).toBe(true);
    expect(await folders()).toEqual({ 1: "trash", 2: "trash", 3: "trash", 4: "inbox" });
    expect(await counters(1)).toMatchObject({ message_count: 0, unread_count: 0 });
    expect(await counters(2)).toMatchObject({ message_count: 1, unread_count: 1 });
  });

  it("ne compte pas deux fois un message déjà à la corbeille", async () => {
    await moveToFolder(env.DB, 1, "trash");
    expect(await trashThread(env.DB, 1)).toBe(true);
    expect(await counters(1)).toMatchObject({ message_count: 0, unread_count: 0 });
  });

  it("retourne false pour une conversation inexistante", async () => {
    expect(await trashThread(env.DB, 999)).toBe(false);
  });
});

describe("restoreThread", () => {
  it("restaure chaque message vers son dossier d'origine selon sa direction", async () => {
    await trashThread(env.DB, 1);
    expect(await restoreThread(env.DB, 1)).toBe(true);
    expect(await folders()).toEqual({ 1: "inbox", 2: "inbox", 3: "sent", 4: "inbox" });
    expect(await counters(1)).toMatchObject({ message_count: 3, unread_count: 2 });
  });

  it("retourne false pour une conversation inexistante", async () => {
    expect(await restoreThread(env.DB, 999)).toBe(false);
  });
});

describe("purgeThread", () => {
  it("purge les messages à la corbeille de la conversation et supprime le thread vidé", async () => {
    await trashThread(env.DB, 1);
    expect(await purgeThread(workerEnv, 1)).toBe(true);
    expect(await folders()).toEqual({ 4: "inbox" });
    expect(await env.DB.prepare("SELECT id FROM threads WHERE id = 1").first()).toBeNull();
    for (const id of [1, 2, 3]) expect(await env.MAIL.get(`raw/m${id}.eml`)).toBeNull();
    expect(await env.MAIL.get("raw/m4.eml")).not.toBeNull();
  });

  it("ne purge pas les messages de la conversation encore hors corbeille", async () => {
    await moveToFolder(env.DB, 1, "trash");
    expect(await purgeThread(workerEnv, 1)).toBe(true);
    expect(await folders()).toEqual({ 2: "inbox", 3: "sent", 4: "inbox" });
    expect(await env.MAIL.get("raw/m2.eml")).not.toBeNull();
    expect(await counters(1)).toMatchObject({ message_count: 2, unread_count: 1 });
  });

  it("retourne false pour une conversation inexistante", async () => {
    expect(await purgeThread(workerEnv, 999)).toBe(false);
  });
});

describe("routes /api/threads/:id", () => {
  const request = (path: string, init: RequestInit, bypass = true) =>
    app.request(`https://example.com${path}`, init, { ...env, DEV_BYPASS_AUTH: bypass ? "1" : undefined });
  const patch = (path: string, body: unknown, bypass = true) =>
    request(path, { method: "PATCH", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }, bypass);

  it("met la conversation à la corbeille via PATCH { trashed: true }", async () => {
    const res = await patch("/api/threads/1", { trashed: true });
    expect(res.status).toBe(200);
    expect(await folders()).toMatchObject({ 1: "trash", 2: "trash", 3: "trash" });
  });

  it("restaure la conversation via PATCH { trashed: false }", async () => {
    await trashThread(env.DB, 1);
    const res = await patch("/api/threads/1", { trashed: false });
    expect(res.status).toBe(200);
    expect(await folders()).toMatchObject({ 1: "inbox", 2: "inbox", 3: "sent" });
  });

  it("purge la conversation via DELETE", async () => {
    await trashThread(env.DB, 1);
    const res = await request("/api/threads/1", { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(await folders()).toEqual({ 4: "inbox" });
  });

  it("répond 409 quand une purge réserve un message de la conversation", async () => {
    await env.DB.prepare(
      "INSERT INTO purge_claims (raw_key, message_id, claimed_at) VALUES ('raw/m1.eml', 1, unixepoch())"
    ).run();
    const res = await patch("/api/threads/1", { trashed: true });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: { code: "purge_in_progress" } });
  });

  it("répond 400 pour un corps invalide", async () => {
    expect((await patch("/api/threads/1", {})).status).toBe(400);
    expect((await patch("/api/threads/1", { trashed: "oui" })).status).toBe(400);
  });

  it("répond 400 pour un identifiant non numérique", async () => {
    expect((await patch("/api/threads/abc", { trashed: true })).status).toBe(400);
    expect((await request("/api/threads/abc", { method: "DELETE" })).status).toBe(400);
  });

  it("répond 404 pour une conversation inexistante", async () => {
    expect((await patch("/api/threads/999", { trashed: true })).status).toBe(404);
    expect((await request("/api/threads/999", { method: "DELETE" })).status).toBe(404);
  });

  it("répond 401 sans jeton", async () => {
    expect((await patch("/api/threads/1", { trashed: true }, false)).status).toBe(401);
    expect((await request("/api/threads/1", { method: "DELETE" }, false)).status).toBe(401);
  });
});
