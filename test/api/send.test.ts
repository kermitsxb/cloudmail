import { env, applyD1Migrations } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { app } from "../../src/index";
import { getThread } from "../../src/db/queries";

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
    env.DB.prepare("DELETE FROM attachments"),
    env.DB.prepare("DELETE FROM recipients"),
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

describe("POST /api/messages — pièces jointes du message envoyé", () => {
  // Régression : has_attachments passait à 1 d'après req.attachments.length, mais aucune
  // ligne `attachments` n'était insérée et aucun octet n'était écrit dans R2. La liste des
  // conversations affichait donc un trombone pour une conversation qui n'en montrait aucune
  // une fois ouverte, et l'utilisateur n'avait aucune copie de ce qu'il avait envoyé.
  it("persiste la ligne, l'objet R2, et les renvoie via getThread", async () => {
    ok();
    const res = await post({
      ...valid,
      attachments: [
        { filename: "rapport final.pdf", mimeType: "application/pdf", contentBase64: btoa("%PDF-1.7") },
      ],
    });
    expect(res.status).toBe(200);
    const { id } = await res.json<{ id: number }>();

    const att = await env.DB.prepare(
      "SELECT filename, mime_type, size, r2_key FROM attachments WHERE message_id = ?"
    ).bind(id).first<{ filename: string; mime_type: string; size: number; r2_key: string }>();
    expect(att).toMatchObject({ filename: "rapport final.pdf", mime_type: "application/pdf", size: 8 });
    expect(att?.r2_key).toMatch(/^att\/sent-[A-Za-z0-9._-]+\/0-rapport-final.pdf$/);

    const obj = await env.MAIL.get(att!.r2_key);
    expect(obj).not.toBeNull();
    expect(new TextDecoder().decode(await obj!.arrayBuffer())).toBe("%PDF-1.7");

    const threadId = (await env.DB.prepare("SELECT thread_id FROM messages WHERE id = ?")
      .bind(id).first<{ thread_id: number }>())!.thread_id;
    const thread = await getThread(env.DB, threadId);
    expect(thread?.messages[0].attachments).toEqual([
      { id: expect.any(Number), filename: "rapport final.pdf", mimeType: "application/pdf", size: 8 },
    ]);
  });
});
