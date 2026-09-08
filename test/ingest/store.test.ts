import { env, applyD1Migrations } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { storeIncoming } from "../../src/ingest/store";

interface TestEnv {
  TEST_FIXTURES: Record<string, string>;
  TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
}

const testEnv = env as unknown as TestEnv;

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
});

const load = async (name: string): Promise<ArrayBuffer> => {
  const b64 = testEnv.TEST_FIXTURES[name];
  if (!b64) throw new Error(`fixture introuvable: ${name}`);
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
};

const envelope = { from: "zoe@example.com", to: "thomas@planigramme.fr" };

describe("storeIncoming", () => {
  it("écrit le MIME brut dans R2 et le message dans D1", async () => {
    const res = await storeIncoming(env, await load("simple.eml"), envelope);
    expect(res.duplicate).toBe(false);
    expect(res.rawKey).toBe("raw/simple-1-example.com.eml");

    const obj = await env.MAIL.get(res.rawKey);
    expect(obj).not.toBeNull();

    const m = await env.DB.prepare(
      "SELECT subject, from_addr, folder, direction, snippet, is_read, has_attachments FROM messages WHERE id = ?"
    ).bind(res.messageId).first<Record<string, unknown>>();
    expect(m).toMatchObject({
      subject: "Facture réglée",
      from_addr: "zoe@example.com",
      folder: "inbox",
      direction: "in",
      is_read: 0,
      has_attachments: 0,
    });
    expect(m?.snippet).toContain("la facture est réglée");
  });

  it("enregistre les destinataires To et Cc", async () => {
    const res = await storeIncoming(env, await load("multipart.eml"), envelope);
    const rows = await env.DB.prepare(
      "SELECT kind, address FROM recipients WHERE message_id = ? ORDER BY kind, address"
    ).bind(res.messageId).all<{ kind: string; address: string }>();
    expect(rows.results).toEqual([
      { kind: "cc", address: "chef@example.com" },
      { kind: "to", address: "autre@planigramme.fr" },
      { kind: "to", address: "thomas@planigramme.fr" },
    ]);
  });

  it("extrait les pièces jointes vers R2", async () => {
    const res = await storeIncoming(env, await load("attachment.eml"), envelope);
    const att = await env.DB.prepare(
      "SELECT filename, mime_type, size, r2_key FROM attachments WHERE message_id = ?"
    ).bind(res.messageId).first<{ filename: string; mime_type: string; size: number; r2_key: string }>();
    expect(att?.filename).toBe("data.csv");
    expect(att?.r2_key).toBe("att/att-1-example.com/0-data.csv");
    const obj = await env.MAIL.get(att!.r2_key);
    expect(await obj?.text()).toBe("a,b,c\n1,2,3\n");

    const m = await env.DB.prepare("SELECT has_attachments FROM messages WHERE id = ?")
      .bind(res.messageId).first<{ has_attachments: number }>();
    expect(m?.has_attachments).toBe(1);
  });

  it("est idempotent sur le Message-ID", async () => {
    const raw = await load("simple.eml");
    await storeIncoming(env, raw, envelope);
    const second = await storeIncoming(env, raw, envelope);
    expect(second.duplicate).toBe(true);
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM messages").first<{ n: number }>();
    expect(n?.n).toBe(1);
  });

  it("met à jour les compteurs du thread", async () => {
    const res = await storeIncoming(env, await load("simple.eml"), envelope);
    const t = await env.DB.prepare(
      "SELECT message_count, unread_count, last_message_at FROM threads WHERE id = (SELECT thread_id FROM messages WHERE id = ?)"
    ).bind(res.messageId).first<{ message_count: number; unread_count: number; last_message_at: number }>();
    expect(t).toMatchObject({ message_count: 1, unread_count: 1 });
    expect(t?.last_message_at).toBe(1788854400); // 2026-09-08T10:00:00+02:00
  });

  it("stocke quand même un message illisible avec parse_error", async () => {
    const res = await storeIncoming(env, await load("malformed.eml"), envelope);
    const m = await env.DB.prepare("SELECT parse_error, from_addr, raw_key FROM messages WHERE id = ?")
      .bind(res.messageId).first<{ parse_error: number; from_addr: string; raw_key: string }>();
    expect(m?.parse_error).toBe(1);
    expect(m?.from_addr).toBe("zoe@example.com");
    const obj = await env.MAIL.get(m!.raw_key);
    expect(obj).not.toBeNull();
  });

  it("écrit le brut dans R2 même si l'insertion D1 échoue", async () => {
    const broken = { ...env, DB: { prepare: () => { throw new Error("d1 down"); } } } as unknown as typeof env;
    await expect(storeIncoming(broken, await load("simple.eml"), envelope)).rejects.toThrow();
    const obj = await env.MAIL.get("raw/simple-1-example.com.eml");
    expect(obj).not.toBeNull();
  });
});
