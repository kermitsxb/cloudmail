import { env, applyD1Migrations } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { app } from "../../src/index";

interface TestEnv {
  DB: D1Database;
  TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
}

const testEnv = env as unknown as TestEnv;

beforeAll(async () => {
  await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
});

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM messages"),
    env.DB.prepare("DELETE FROM threads"),
    env.DB.prepare("DELETE FROM identities"),
  ]);
  await env.DB.prepare(
    "INSERT INTO identities (address, display_name, is_default) VALUES ('thomas@example.com', 'Thomas', 1)"
  ).run();
});

afterEach(() => vi.unstubAllGlobals());

const ok = () =>
  vi.stubGlobal("fetch", async () =>
    Response.json({ success: true, result: { delivered: ["zoe@example.com"], queued: [], permanent_bounces: [] } })
  );

const post = (body: unknown) =>
  app.request(
    "https://example.com/api/messages",
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
    { ...env, DEV_BYPASS_AUTH: "1", CF_ACCOUNT_ID: "acc", CF_API_TOKEN: "tok" },
  );

const valid = {
  from: "thomas@example.com",
  to: ["zoe@example.com"],
  subject: "Bonjour",
  text: "Salut",
};

describe("POST /api/messages", () => {
  it("envoie et stocke une copie dans le dossier sent", async () => {
    ok();
    const res = await post(valid);
    expect(res.status).toBe(200);

    const m = await env.DB.prepare(
      "SELECT direction, folder, from_addr, subject, is_read FROM messages"
    ).first<Record<string, unknown>>();
    expect(m).toMatchObject({
      direction: "out", folder: "sent", from_addr: "thomas@example.com", subject: "Bonjour", is_read: 1,
    });
  });

  it("refuse un expéditeur qui n'est pas une identité connue", async () => {
    ok();
    const res = await post({ ...valid, from: "usurpateur@ailleurs.com" });
    expect(res.status).toBe(400);
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM messages").first<{ n: number }>();
    expect(n?.n).toBe(0);
  });

  it("ne stocke rien si l'API d'envoi échoue", async () => {
    vi.stubGlobal("fetch", async () => new Response("boom", { status: 429 }));
    const res = await post(valid);
    expect(res.status).toBe(429);
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM messages").first<{ n: number }>();
    expect(n?.n).toBe(0);
  });

  it("refuse un destinataire mal formé", async () => {
    ok();
    expect((await post({ ...valid, to: ["pas-une-adresse"] })).status).toBe(400);
  });

  it("refuse un message au-delà de 5 MiB", async () => {
    ok();
    const res = await post({ ...valid, text: "x".repeat(6 * 1024 * 1024) });
    expect(res.status).toBe(413);
  });

  it("rattache la réponse au thread du message parent", async () => {
    ok();
    await env.DB.prepare("INSERT INTO threads (id, subject_norm, last_message_at, message_count) VALUES (5, 'bonjour', 100, 1)").run();
    await env.DB.prepare(
      `INSERT INTO messages (id, thread_id, message_id, direction, folder, from_addr, subject, received_at, raw_key)
       VALUES (1, 5, '<parent@x>', 'in', 'inbox', 'zoe@example.com', 'Bonjour', 100, 'raw/p.eml')`
    ).run();

    await post({ ...valid, subject: "Re: Bonjour", inReplyTo: "<parent@x>" });
    const m = await env.DB.prepare("SELECT thread_id FROM messages WHERE direction = 'out'")
      .first<{ thread_id: number }>();
    expect(m?.thread_id).toBe(5);
  });

  it("remonte les bounces permanents au client", async () => {
    vi.stubGlobal("fetch", async () =>
      Response.json({ success: true, result: { delivered: [], queued: [], permanent_bounces: ["zoe@example.com"] } })
    );
    const res = await post(valid);
    expect(await res.json()).toMatchObject({ permanentBounces: ["zoe@example.com"] });
  });
});
