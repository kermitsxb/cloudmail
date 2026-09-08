import { env, applyD1Migrations } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

interface TestEnv {
  DB: D1Database;
  TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
}

const testEnv = env as unknown as TestEnv;

beforeAll(async () => {
  await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
});

describe("schéma", () => {
  it("indexe automatiquement les messages dans FTS", async () => {
    await env.DB.prepare(
      `INSERT INTO threads (id, subject_norm, last_message_at) VALUES (1, 'facture', 1757318400)`
    ).run();
    await env.DB.prepare(
      `INSERT INTO messages (id, thread_id, message_id, direction, folder, from_addr, subject, text_body, received_at, raw_key)
       VALUES (1, 1, '<a@x>', 'in', 'inbox', 'zoe@example.com', 'Facture de septembre', 'Voici la facture réglée', 1757318400, 'raw/a.eml')`
    ).run();

    const hit = await env.DB.prepare(
      `SELECT m.id FROM messages_fts f JOIN messages m ON m.id = f.rowid WHERE messages_fts MATCH ?`
    ).bind("facture").first<{ id: number }>();
    expect(hit?.id).toBe(1);
  });

  it("ignore les accents dans la recherche", async () => {
    const hit = await env.DB.prepare(
      `SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?`
    ).bind("reglee").first();
    expect(hit).not.toBeNull();
  });

  it("retire le message de FTS quand il est supprimé", async () => {
    await env.DB.prepare(`DELETE FROM messages WHERE id = 1`).run();
    const hit = await env.DB.prepare(
      `SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?`
    ).bind("facture").first();
    expect(hit).toBeNull();
  });

  it("refuse deux messages avec le même Message-ID", async () => {
    await env.DB.prepare(
      `INSERT INTO messages (thread_id, message_id, direction, folder, from_addr, received_at, raw_key)
       VALUES (1, '<dup@x>', 'in', 'inbox', 'a@b.c', 1, 'raw/d.eml')`
    ).run();
    const res = await env.DB.prepare(
      `INSERT OR IGNORE INTO messages (thread_id, message_id, direction, folder, from_addr, received_at, raw_key)
       VALUES (1, '<dup@x>', 'in', 'inbox', 'a@b.c', 1, 'raw/d.eml')`
    ).run();
    expect(res.meta.changes).toBe(0);
  });

  it("supprime les destinataires et pièces jointes en cascade", async () => {
    const { meta } = await env.DB.prepare(
      `INSERT INTO messages (thread_id, message_id, direction, folder, from_addr, received_at, raw_key)
       VALUES (1, '<casc@x>', 'in', 'inbox', 'a@b.c', 1, 'raw/c.eml')`
    ).run();
    const id = meta.last_row_id;
    await env.DB.prepare(
      `INSERT INTO recipients (message_id, kind, address) VALUES (?, 'to', 'x@y.z')`
    ).bind(id).run();
    await env.DB.prepare(`DELETE FROM messages WHERE id = ?`).bind(id).run();
    const left = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM recipients WHERE message_id = ?`
    ).bind(id).first<{ n: number }>();
    expect(left?.n).toBe(0);
  });
});
