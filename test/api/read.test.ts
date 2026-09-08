import { env, applyD1Migrations } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { listThreads, getThread, listIdentities } from "../../src/db/queries";
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
    env.DB.prepare("DELETE FROM attachments"),
    env.DB.prepare("DELETE FROM recipients"),
    env.DB.prepare("DELETE FROM messages"),
    env.DB.prepare("DELETE FROM threads"),
    env.DB.prepare("DELETE FROM identities"),
  ]);
});

const insertThread = async (id: number, subject: string, at: number) =>
  env.DB.prepare(
    "INSERT INTO threads (id, subject_norm, last_message_at, message_count, unread_count) VALUES (?, ?, ?, 1, 1)"
  ).bind(id, subject, at).run();

const insertMessage = async (
  id: number, threadId: number, over: Partial<{ subject: string; text: string; from: string; folder: string; at: number }> = {}
) =>
  env.DB.prepare(
    `INSERT INTO messages (id, thread_id, message_id, direction, folder, from_addr, subject, text_body, snippet, received_at, raw_key)
     VALUES (?, ?, ?, 'in', ?, ?, ?, ?, ?, ?, 'raw/x.eml')`
  ).bind(
    id, threadId, `<m${id}@x>`, over.folder ?? "inbox", over.from ?? "zoe@example.com",
    over.subject ?? "Facture", over.text ?? "corps du message", (over.text ?? "corps du message").slice(0, 200),
    over.at ?? 1757318400
  ).run();

describe("listThreads", () => {
  it("retourne les threads du dossier, du plus récent au plus ancien", async () => {
    await insertThread(1, "a", 100);
    await insertMessage(1, 1, { at: 100 });
    await insertThread(2, "b", 200);
    await insertMessage(2, 2, { at: 200 });

    const { threads } = await listThreads(env.DB, { folder: "inbox" });
    expect(threads.map((t) => t.id)).toEqual([2, 1]);
    expect(threads[0].unreadCount).toBe(1);
  });

  it("exclut les threads dont aucun message n'est dans le dossier", async () => {
    await insertThread(3, "c", 300);
    await insertMessage(3, 3, { folder: "trash" });
    const { threads } = await listThreads(env.DB, { folder: "inbox" });
    expect(threads).toHaveLength(0);
  });

  it("pagine par curseur", async () => {
    for (let i = 1; i <= 3; i++) {
      await insertThread(i, `t${i}`, i * 100);
      await insertMessage(i, i, { at: i * 100 });
    }
    const first = await listThreads(env.DB, { folder: "inbox", limit: 2 });
    expect(first.threads.map((t) => t.id)).toEqual([3, 2]);
    expect(first.cursor).not.toBeNull();
    const second = await listThreads(env.DB, { folder: "inbox", limit: 2, cursor: first.cursor! });
    expect(second.threads.map((t) => t.id)).toEqual([1]);
    expect(second.cursor).toBeNull();
  });

  it("le curseur pointe sur le dernier élément servi, pas sur la ligne sentinelle", async () => {
    for (let i = 1; i <= 3; i++) {
      await insertThread(i, `t${i}`, i * 100);
      await insertMessage(i, i, { at: i * 100 });
    }
    const first = await listThreads(env.DB, { folder: "inbox", limit: 2 });
    const decoded = atob(first.cursor!);
    // dernier élément de la page servie = thread 2 (at=200), pas thread 1 (sentinelle, at=100)
    expect(decoded).toBe("200:2");
  });

  it("filtre par recherche plein texte sans tenir compte des accents", async () => {
    await insertThread(1, "a", 100);
    await insertMessage(1, 1, { subject: "Réunion budget", text: "on parle du budget" });
    await insertThread(2, "b", 200);
    await insertMessage(2, 2, { subject: "Autre chose", text: "sans rapport" });

    const { threads } = await listThreads(env.DB, { folder: "inbox", q: "reunion" });
    expect(threads.map((t) => t.id)).toEqual([1]);
  });

  it("ne plante pas sur une requête contenant des caractères FTS spéciaux", async () => {
    await insertThread(1, "a", 100);
    await insertMessage(1, 1);
    await expect(listThreads(env.DB, { folder: "inbox", q: 'a" OR b*' })).resolves.toBeDefined();
  });

  it("ne plante pas et ne renvoie que le dossier attendu sur une requête avec OR/astérisque qui ne matche rien", async () => {
    await insertThread(1, "a", 100);
    await insertMessage(1, 1, { subject: "Facture", text: "corps du message" });
    await insertThread(2, "b", 200);
    await insertMessage(2, 2, { subject: "Autre", text: "contenu différent" });

    const { threads } = await listThreads(env.DB, { folder: "inbox", q: 'a" OR b*' });
    // le terme cité littéralement ne matche aucun texte réel : aucun résultat, pas d'élargissement
    expect(threads).toHaveLength(0);
  });

  it("ne plante pas sur une requête NEAR() et ne l'interprète pas comme opérateur", async () => {
    await insertThread(1, "a", 100);
    await insertMessage(1, 1, { subject: "Facture", text: "corps du message" });
    await expect(listThreads(env.DB, { folder: "inbox", q: "NEAR(x y)" })).resolves.toBeDefined();
  });

  it("une requête vide ou faite uniquement d'espaces ne filtre pas", async () => {
    await insertThread(1, "a", 100);
    await insertMessage(1, 1);
    const { threads } = await listThreads(env.DB, { folder: "inbox", q: "   " });
    expect(threads).toHaveLength(1);
  });

  it("un curseur corrompu ne fait pas lever la fonction", async () => {
    await insertThread(1, "a", 100);
    await insertMessage(1, 1, { at: 100 });
    await expect(listThreads(env.DB, { folder: "inbox", cursor: "!!!pas-du-base64!!!" })).resolves.toBeDefined();
  });
});

describe("getThread", () => {
  it("retourne les messages avec destinataires et pièces jointes", async () => {
    await insertThread(1, "facture", 100);
    await insertMessage(1, 1, { subject: "Facture" });
    await env.DB.prepare("INSERT INTO recipients (message_id, kind, address, name) VALUES (1, 'to', 'thomas@planigramme.fr', 'Thomas')").run();
    await env.DB.prepare("INSERT INTO attachments (id, message_id, filename, mime_type, size, r2_key) VALUES (1, 1, 'f.pdf', 'application/pdf', 42, 'att/x/0-f.pdf')").run();

    const t = await getThread(env.DB, 1);
    expect(t?.subject).toBe("Facture");
    expect(t?.messages[0].to).toEqual([{ address: "thomas@planigramme.fr", name: "Thomas" }]);
    expect(t?.messages[0].attachments).toEqual([{ id: 1, filename: "f.pdf", mimeType: "application/pdf", size: 42 }]);
  });

  it("retourne null pour un thread inexistant", async () => {
    expect(await getThread(env.DB, 999)).toBeNull();
  });
});

describe("listIdentities", () => {
  it("retourne l'identité par défaut en premier", async () => {
    await env.DB.prepare("INSERT INTO identities (address, display_name, is_default) VALUES ('b@planigramme.fr', 'B', 0), ('a@planigramme.fr', 'A', 1)").run();
    const ids = await listIdentities(env.DB);
    expect(ids[0]).toEqual({ address: "a@planigramme.fr", displayName: "A", isDefault: true });
  });
});

describe("routes /api", () => {
  it("répond 401 sans jeton sur GET /api/threads", async () => {
    const res = await app.request("https://example.com/api/threads", {}, { ...env, DEV_BYPASS_AUTH: undefined });
    expect(res.status).toBe(401);
  });

  it("répond 200 avec DEV_BYPASS_AUTH sur GET /api/threads", async () => {
    await insertThread(1, "a", 100);
    await insertMessage(1, 1, { at: 100 });
    const res = await app.request("https://example.com/api/threads?folder=inbox", {}, { ...env, DEV_BYPASS_AUTH: "1" });
    expect(res.status).toBe(200);
    const body = await res.json<{ threads: unknown[] }>();
    expect(body.threads).toHaveLength(1);
  });

  it("répond 404 pour un thread inexistant via GET /api/threads/:id", async () => {
    const res = await app.request("https://example.com/api/threads/999", {}, { ...env, DEV_BYPASS_AUTH: "1" });
    expect(res.status).toBe(404);
  });

  it("répond 400 pour un id non numérique via GET /api/threads/:id", async () => {
    const res = await app.request("https://example.com/api/threads/abc", {}, { ...env, DEV_BYPASS_AUTH: "1" });
    expect(res.status).toBe(400);
  });

  it("répond 200 sur GET /api/identities", async () => {
    await env.DB.prepare("INSERT INTO identities (address, display_name, is_default) VALUES ('a@planigramme.fr', 'A', 1)").run();
    const res = await app.request("https://example.com/api/identities", {}, { ...env, DEV_BYPASS_AUTH: "1" });
    expect(res.status).toBe(200);
  });
});
