import { env, applyD1Migrations } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { app } from "../../src/index";

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
  let cursor: string | undefined;
  do {
    const page = await env.MAIL.list({ cursor });
    if (page.objects.length > 0) await env.MAIL.delete(page.objects.map((o) => o.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
});

const withEnv = (over: Record<string, unknown> = {}) => ({ ...env, DEV_BYPASS_AUTH: "1", MAIL_DOMAIN: "example.com", ...over });

const req = (path: string, init?: RequestInit, over?: Record<string, unknown>) =>
  app.request(`https://example.com${path}`, init ?? {}, withEnv(over));

const postReimport = (body: unknown) =>
  req("/api/admin/reimport", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const key = (c: string) => `raw/${c.repeat(64)}.eml`;

const loadBytes = (name: string): ArrayBuffer => {
  const binary = atob(testEnv.TEST_FIXTURES[name]);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
};

describe("accès", () => {
  it("refuse les routes d'administration sans jeton Access", async () => {
    const res = await app.request("https://example.com/api/admin/orphans", {}, { ...env, DEV_BYPASS_AUTH: "" });
    expect(res.status).toBe(401);
  });
});

describe("GET /api/admin/orphans", () => {
  it("renvoie les orphelins et le curseur", async () => {
    await env.MAIL.put(key("a"), loadBytes("simple.eml"));
    const res = await req("/api/admin/orphans");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ orphans: [{ key: key("a") }], cursor: null });
  });

  it("refuse un curseur démesuré", async () => {
    const res = await req(`/api/admin/orphans?cursor=${"x".repeat(2000)}`);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: "invalid_query" } });
  });

  it("répond 503 quand R2 est indisponible", async () => {
    const brokenMail = { list: async () => { throw new Error("r2 down"); } };
    const res = await req("/api/admin/orphans", {}, { MAIL: brokenMail });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: { code: "storage_unavailable" } });
  });
});

describe("GET /api/admin/parse-errors", () => {
  it("refuse un curseur non numérique", async () => {
    const res = await req("/api/admin/parse-errors?cursor=abc");
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: "invalid_query", message: "Invalid cursor" } });
  });

  it("renvoie une liste vide quand aucun message n'est en erreur", async () => {
    const res = await req("/api/admin/parse-errors");
    expect(await res.json()).toEqual({ messages: [], cursor: null });
  });
});

describe("POST /api/admin/reimport", () => {
  it.each([
    ["une liste vide", { keys: [] }],
    ["plus de dix clés", { keys: Array.from({ length: 11 }, (_, i) => key(i.toString(16))) }],
    ["une clé de message envoyé", { keys: ["sent/<a@example.com>"] }],
    ["une clé de pièce jointe", { keys: ["att/a-example.com/0-data.csv"] }],
    ["un chemin détourné", { keys: ["raw/../att/x.eml"] }],
    ["un corps absent", null],
  ])("refuse %s", async (_label, body) => {
    const res = await postReimport(body);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: "invalid_body" } });
  });

  it("répond 200 avec un résultat par clé, même quand certaines échouent", async () => {
    await env.MAIL.put(key("a"), loadBytes("simple.eml"));

    const res = await postReimport({ keys: [key("a"), key("b"), key("a")] });

    expect(res.status).toBe(200);
    const body = await res.json() as { results: { key: string; outcome: string }[] };
    expect(body.results.map((r) => [r.key, r.outcome])).toEqual([
      [key("a"), "imported"],
      [key("b"), "not_found"],
    ]);
  });
});
