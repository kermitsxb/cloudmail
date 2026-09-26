import { env, applyD1Migrations } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

type Migrations = Parameters<typeof applyD1Migrations>[1];
interface TestEnv {
  MIGRATION_DB: D1Database;
  TEST_MIGRATIONS: Migrations;
}

const testEnv = env as unknown as TestEnv;
const db = testEnv.MIGRATION_DB;

// Données posées sur un schéma 0005, puis migration 0006 : on vérifie que la reconstruction
// de messages ne perd ni destinataires ni pièces jointes (piège du DROP TABLE qui déclenche
// ON DELETE CASCADE), et que l'index FTS reste utilisable.
beforeAll(async () => {
  const all = testEnv.TEST_MIGRATIONS;
  const upTo0005 = all.filter((m) => m.name < "0006");
  expect(upTo0005.length).toBe(5);
  await applyD1Migrations(db, upTo0005);

  await db.batch([
    db.prepare("INSERT INTO threads (id, subject_norm, last_message_at, message_count, unread_count) VALUES (1, 'facture', 100, 2, 1)"),
    db.prepare(
      `INSERT INTO messages (id, thread_id, message_id, direction, folder, from_addr, from_name, subject, text_body,
                             snippet, received_at, is_read, has_attachments, raw_key, trashed_at)
       VALUES (1, 1, '<a@example.com>', 'in', 'inbox', 'zoe@example.com', 'Zoé', 'Facture de septembre',
               'Voici la facture réglée', 'Voici', 100, 0, 1, 'raw/a.eml', NULL)`
    ),
    db.prepare(
      `INSERT INTO messages (id, thread_id, message_id, direction, folder, from_addr, subject, received_at, is_read, raw_key, trashed_at)
       VALUES (2, 1, '<b@example.com>', 'in', 'trash', 'zoe@example.com', 'Relance', 90, 1, 'raw/b.eml', 555)`
    ),
    db.prepare(
      `INSERT INTO messages (id, thread_id, message_id, direction, folder, from_addr, subject, received_at, is_read, raw_key)
       VALUES (3, 1, '<c@example.com>', 'out', 'sent', 'you@example.com', 'Re: Facture', 110, 1, 'sent/<c@example.com>')`
    ),
    db.prepare("INSERT INTO recipients (id, message_id, kind, address, name) VALUES (10, 1, 'to', 'you@example.com', NULL)"),
    db.prepare("INSERT INTO recipients (id, message_id, kind, address, name) VALUES (11, 1, 'cc', 'bob@example.com', 'Bob')"),
    db.prepare("INSERT INTO recipients (id, message_id, kind, address, name) VALUES (12, 3, 'to', 'zoe@example.com', NULL)"),
    db.prepare(
      `INSERT INTO attachments (id, message_id, filename, mime_type, size, content_id, r2_key)
       VALUES (20, 1, 'facture.pdf', 'application/pdf', 1234, NULL, 'att/a/0-facture.pdf')`
    ),
    db.prepare("INSERT INTO purge_claims (raw_key, message_id, claimed_at) VALUES ('raw/b.eml', 2, 777)"),
  ]);

  await applyD1Migrations(db, all);
});

const count = async (table: string) =>
  (await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>())?.n;

describe("migration 0006", () => {
  it("conserve toutes les lignes et leurs identifiants", async () => {
    expect(await count("messages")).toBe(3);
    expect(await count("recipients")).toBe(3);
    expect(await count("attachments")).toBe(1);
    expect(await count("purge_claims")).toBe(1);
    const m2 = await db.prepare("SELECT folder, trashed_at, is_read FROM messages WHERE id = 2")
      .first<{ folder: string; trashed_at: number; is_read: number }>();
    expect(m2).toEqual({ folder: "trash", trashed_at: 555, is_read: 1 });
    const att = await db.prepare("SELECT message_id, r2_key FROM attachments WHERE id = 20")
      .first<{ message_id: number; r2_key: string }>();
    expect(att).toEqual({ message_id: 1, r2_key: "att/a/0-facture.pdf" });
  });

  it("ajoute les colonnes de verdict, vides pour les messages existants", async () => {
    const m = await db.prepare("SELECT auth_spf, auth_dkim, auth_dmarc, spam_score FROM messages WHERE id = 1")
      .first();
    expect(m).toEqual({ auth_spf: null, auth_dkim: null, auth_dmarc: null, spam_score: null });
  });

  it("accepte le dossier spam et refuse un dossier inconnu", async () => {
    await db.prepare("UPDATE messages SET folder = 'spam' WHERE id = 1").run();
    await expect(db.prepare("UPDATE messages SET folder = 'junk' WHERE id = 1").run()).rejects.toThrow();
    await db.prepare("UPDATE messages SET folder = 'inbox' WHERE id = 1").run();
  });

  it("garde l'index de recherche valide et ses triggers actifs", async () => {
    const hit = await db.prepare(
      "SELECT m.id FROM messages_fts f JOIN messages m ON m.id = f.rowid WHERE messages_fts MATCH ?"
    ).bind("reglee").first<{ id: number }>();
    expect(hit?.id).toBe(1);

    await db.prepare("UPDATE messages SET subject = 'Devis' WHERE id = 3").run();
    const updated = await db.prepare("SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?").bind("devis").first();
    expect(updated).not.toBeNull();
  });

  it("rattache les tables enfants à la nouvelle table messages", async () => {
    const sql = await db.prepare("SELECT sql FROM sqlite_master WHERE name = 'recipients'").first<{ sql: string }>();
    expect(sql?.sql).toMatch(/REFERENCES "?messages"?\s*\(id\)/);
    expect(sql?.sql).not.toMatch(/messages_new/);
    await expect(
      db.prepare("INSERT INTO recipients (message_id, kind, address) VALUES (999, 'to', 'x@example.com')").run()
    ).rejects.toThrow();
  });

  it("supprime en cascade les destinataires et pièces jointes", async () => {
    await db.prepare("DELETE FROM messages WHERE id = 1").run();
    expect(await count("recipients")).toBe(1);
    expect(await count("attachments")).toBe(0);
    const gone = await db.prepare("SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?").bind("reglee").first();
    expect(gone).toBeNull();
  });

  it("recrée tous les index", async () => {
    const rows = await db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_%'")
      .all<{ name: string }>();
    expect(rows.results.map((r) => r.name).sort()).toEqual([
      "idx_attachments_message",
      "idx_forward_rules_match",
      "idx_forward_rules_pair",
      "idx_messages_folder",
      "idx_messages_in_reply_to",
      "idx_messages_raw_key",
      "idx_messages_thread",
      "idx_messages_trashed_at",
      "idx_recipients_address",
      "idx_recipients_message",
      "idx_threads_last",
    ]);
  });
});
