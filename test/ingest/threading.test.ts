import { env, applyD1Migrations } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resolveThread } from "../../src/ingest/threading";
import type { ParsedMessage } from "../../src/ingest/parse";

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
  ]);
});

const msg = (over: Partial<ParsedMessage>): ParsedMessage => ({
  messageId: "<m1@x>", inReplyTo: null, references: [],
  from: { address: "zoe@example.com", name: null },
  to: [{ address: "thomas@planigramme.fr", name: null }],
  cc: [], replyTo: [], subject: "Facture", text: "", html: null,
  date: 1757318400, attachments: [], parseError: false, ...over,
});

const seed = async (messageId: string, subject: string, threadId: number, at = 1757318400) => {
  await env.DB.prepare(
    `INSERT OR IGNORE INTO threads (id, subject_norm, last_message_at) VALUES (?, ?, ?)`
  ).bind(threadId, subject, at).run();
  await env.DB.prepare(
    `INSERT INTO messages (thread_id, message_id, direction, folder, from_addr, subject, received_at, raw_key)
     VALUES (?, ?, 'in', 'inbox', 'zoe@example.com', ?, ?, 'raw/x.eml')`
  ).bind(threadId, messageId, subject, at).run();
  await env.DB.prepare(
    `INSERT INTO recipients (message_id, kind, address)
     VALUES ((SELECT id FROM messages WHERE message_id = ?), 'to', 'thomas@planigramme.fr')`
  ).bind(messageId).run();
};

describe("resolveThread", () => {
  it("crée un thread quand rien ne correspond", async () => {
    const r = await resolveThread(env.DB, msg({}), ["zoe@example.com"]);
    expect(r.created).toBe(true);
    const t = await env.DB.prepare("SELECT subject_norm FROM threads WHERE id = ?")
      .bind(r.threadId).first<{ subject_norm: string }>();
    expect(t?.subject_norm).toBe("facture");
  });

  // Régression : la requête de rattrapage par sujet liait 2 + 2 × participants paramètres,
  // alors que D1 en plafonne 100 par requête. Un message à 60 participants (liste de
  // diffusion, longue chaîne en répondre-à-tous) faisait donc lever resolveThread — et avec
  // elle storeIncoming, dont l'erreur est avalée par handleEmail : le message n'existait plus
  // que dans R2, sans ligne D1.
  const manyParticipants = (n: number) =>
    Array.from({ length: n }, (_, i) => `p${i}@example.com`);

  it("supporte 60 participants sans dépasser la limite de paramètres liés D1", async () => {
    const r = await resolveThread(env.DB, msg({}), manyParticipants(60));
    expect(r.created).toBe(true);
  });

  it("rattache par sujet même avec 60 participants", async () => {
    await seed("<parent@x>", "facture", 11);
    const r = await resolveThread(
      env.DB,
      msg({ messageId: "<m3@x>", subject: "Re: Facture" }),
      [...manyParticipants(60), "zoe@example.com"],
    );
    expect(r).toEqual({ threadId: 11, created: false });
  });

  it("rattache via In-Reply-To", async () => {
    await seed("<parent@x>", "facture", 7);
    const r = await resolveThread(env.DB, msg({ messageId: "<m2@x>", inReplyTo: "<parent@x>" }), []);
    expect(r).toEqual({ threadId: 7, created: false });
  });

  it("rattache via References en partant du plus récent", async () => {
    await seed("<ancien@x>", "facture", 3);
    await seed("<recent@x>", "facture", 4);
    const r = await resolveThread(
      env.DB,
      msg({ messageId: "<m3@x>", references: ["<ancien@x>", "<recent@x>"] }),
      []
    );
    expect(r.threadId).toBe(4);
  });

  it("rattache par sujet normalisé et participant commun", async () => {
    await seed("<p@x>", "facture", 9);
    const r = await resolveThread(
      env.DB,
      msg({ messageId: "<m4@x>", subject: "Re: Facture" }),
      ["zoe@example.com"]
    );
    expect(r.threadId).toBe(9);
  });

  it("ne rattache pas par sujet au-delà de 30 jours", async () => {
    const vieux = 1757318400 - 31 * 86400;
    await seed("<vieux@x>", "facture", 11, vieux);
    const r = await resolveThread(env.DB, msg({ messageId: "<m5@x>", subject: "Re: Facture" }), ["zoe@example.com"]);
    expect(r.created).toBe(true);
    expect(r.threadId).not.toBe(11);
  });

  it("ne rattache pas par sujet sans participant commun", async () => {
    await seed("<p2@x>", "facture", 13);
    const r = await resolveThread(env.DB, msg({ messageId: "<m6@x>", subject: "Facture" }), ["inconnu@ailleurs.com"]);
    expect(r.created).toBe(true);
  });

  it("crée un thread pour un sujet vide plutôt que de tout regrouper", async () => {
    await seed("<p3@x>", "", 15);
    const r = await resolveThread(env.DB, msg({ messageId: "<m7@x>", subject: "" }), ["zoe@example.com"]);
    expect(r.created).toBe(true);
  });
});
