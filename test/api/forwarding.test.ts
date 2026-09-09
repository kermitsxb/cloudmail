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
  await env.DB.prepare("DELETE FROM forward_rules").run();
});

afterEach(() => vi.unstubAllGlobals());

const stubDestinations = (emails: string[]) =>
  vi.stubGlobal("fetch", async () =>
    Response.json({
      success: true,
      result: emails.map((email) => ({ email, verified: "2026-01-01T00:00:00Z" })),
    })
  );

const withEnv = () => ({
  ...env,
  DEV_BYPASS_AUTH: "1",
  CF_ACCOUNT_ID: "acc",
  CF_ROUTING_TOKEN: "tok",
  MAIL_DOMAIN: "example.com",
});

const req = (path: string, init?: RequestInit) =>
  app.request(`https://example.com${path}`, init ?? {}, withEnv());

const postRule = (body: unknown) =>
  req("/api/forwarding/rules", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe("GET /api/config", () => {
  it("expose le domaine de courrier", async () => {
    const res = await req("/api/config");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ mailDomain: "example.com" });
  });
});

describe("POST /api/forwarding/rules", () => {
  it("crée une règle sur une destination vérifiée", async () => {
    stubDestinations(["gmail@exemple.com"]);
    const res = await postRule({ matchLocal: "contact", destination: "gmail@exemple.com" });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ matchLocal: "contact", enabled: true });
  });

  it("normalise la partie locale en minuscules", async () => {
    stubDestinations(["gmail@exemple.com"]);
    const res = await postRule({ matchLocal: "  Contact  ", destination: "gmail@exemple.com" });
    expect(await res.json()).toMatchObject({ matchLocal: "contact" });
  });

  it("accepte la sentinelle catch-all", async () => {
    stubDestinations(["gmail@exemple.com"]);
    const res = await postRule({ matchLocal: "*", destination: "gmail@exemple.com" });
    expect(res.status).toBe(201);
  });

  it("refuse une partie locale invalide", async () => {
    stubDestinations(["gmail@exemple.com"]);
    const res = await postRule({ matchLocal: "a b@c", destination: "gmail@exemple.com" });
    expect(res.status).toBe(400);
    expect((await res.json() as { error: { code: string } }).error.code).toBe("invalid_body");
  });

  it("renvoie un message d'erreur français lisible, pas un dump JSON de zod", async () => {
    stubDestinations(["gmail@exemple.com"]);
    const res = await postRule({ matchLocal: "contact", destination: "pas-un-email" });
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message.startsWith("[{")).toBe(false);
    expect(body.error.message).toContain("Requête invalide");
  });

  it("garde le message écrit à la main pour une partie locale invalide", async () => {
    stubDestinations(["gmail@exemple.com"]);
    const res = await postRule({ matchLocal: "a b", destination: "gmail@exemple.com" });
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toBe("Partie locale invalide");
  });

  it("refuse une destination non vérifiée", async () => {
    stubDestinations(["gmail@exemple.com"]);
    const res = await postRule({ matchLocal: "contact", destination: "typo@exmple.com" });
    expect(res.status).toBe(400);
    expect((await res.json() as { error: { code: string } }).error.code).toBe("unverified_destination");
  });

  it("refuse un doublon", async () => {
    stubDestinations(["gmail@exemple.com"]);
    await postRule({ matchLocal: "contact", destination: "gmail@exemple.com" });
    const res = await postRule({ matchLocal: "contact", destination: "gmail@exemple.com" });
    expect(res.status).toBe(409);
    expect((await res.json() as { error: { code: string } }).error.code).toBe("duplicate_rule");
  });

  it("répond 503 quand la liste des destinations est inaccessible", async () => {
    vi.stubGlobal("fetch", async () => Response.json({ success: false }, { status: 403 }));
    const res = await postRule({ matchLocal: "contact", destination: "gmail@exemple.com" });
    expect(res.status).toBe(503);
    expect((await res.json() as { error: { code: string } }).error.code).toBe("routing_unavailable");
  });
});

describe("GET /api/forwarding/rules", () => {
  it("liste les règles, catch-all en tête", async () => {
    stubDestinations(["a@exemple.com"]);
    await postRule({ matchLocal: "contact", destination: "a@exemple.com" });
    await postRule({ matchLocal: "*", destination: "a@exemple.com" });
    const rules = (await (await req("/api/forwarding/rules")).json()) as { matchLocal: string }[];
    expect(rules.map((r) => r.matchLocal)).toEqual(["*", "contact"]);
  });
});

describe("PATCH et DELETE /api/forwarding/rules/:id", () => {
  const create = async () => {
    stubDestinations(["a@exemple.com"]);
    const res = await postRule({ matchLocal: "contact", destination: "a@exemple.com" });
    return (await res.json()) as { id: number };
  };

  it("désactive une règle", async () => {
    const rule = await create();
    const res = await req(`/api/forwarding/rules/${rule.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    expect(res.status).toBe(200);
    const rules = (await (await req("/api/forwarding/rules")).json()) as { enabled: boolean }[];
    expect(rules[0].enabled).toBe(false);
  });

  it("supprime une règle", async () => {
    const rule = await create();
    expect((await req(`/api/forwarding/rules/${rule.id}`, { method: "DELETE" })).status).toBe(200);
    expect(await (await req("/api/forwarding/rules")).json()).toEqual([]);
  });

  it("répond 404 sur un identifiant inconnu", async () => {
    expect((await req("/api/forwarding/rules/999", { method: "DELETE" })).status).toBe(404);
  });

  it("répond 400 sur un identifiant non numérique", async () => {
    expect((await req("/api/forwarding/rules/abc", { method: "DELETE" })).status).toBe(400);
  });

  it("PATCH renvoie aussi un message d'erreur français, pas un dump JSON de zod", async () => {
    const rule = await create();
    const res = await req(`/api/forwarding/rules/${rule.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: "pas-un-booleen" }),
    });
    const body = (await res.json()) as { error: { message: string } };
    expect(res.status).toBe(400);
    expect(body.error.message.startsWith("[{")).toBe(false);
    expect(body.error.message).toContain("Requête invalide");
  });
});

describe("GET /api/forwarding/destinations", () => {
  it("ne renvoie que les destinations vérifiées", async () => {
    vi.stubGlobal("fetch", async () =>
      Response.json({
        success: true,
        result: [
          { email: "ok@exemple.com", verified: "2026-01-01T00:00:00Z" },
          { email: "attente@exemple.com", verified: null },
        ],
      })
    );
    const res = await req("/api/forwarding/destinations");
    expect(await res.json()).toEqual({ destinations: ["ok@exemple.com"] });
  });

  it("répond 503 plutôt qu'une liste vide quand le token manque", async () => {
    const res = await app.request(
      "https://example.com/api/forwarding/destinations",
      {},
      { ...env, DEV_BYPASS_AUTH: "1", CF_ACCOUNT_ID: "acc", CF_ROUTING_TOKEN: "" },
    );
    expect(res.status).toBe(503);
  });
});

describe("frontière Access", () => {
  it("refuse les routes de redirection sans jeton", async () => {
    const res = await app.request("https://example.com/api/forwarding/rules", {}, env);
    expect(res.status).toBe(401);
  });
});
