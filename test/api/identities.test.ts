import { env, applyD1Migrations } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
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
  await env.DB.prepare("DELETE FROM identities").run();
});

const withEnv = () => ({ ...env, DEV_BYPASS_AUTH: "1", MAIL_DOMAIN: "example.com" });

const req = (path: string, init?: RequestInit) =>
  app.request(`https://example.com${path}`, init ?? {}, withEnv());

const postIdentity = (body: unknown) =>
  req("/api/identities", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const patchIdentity = (address: string, body: unknown) =>
  req(`/api/identities/${encodeURIComponent(address)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe("POST /api/identities", () => {
  it("crée une identité sur le domaine de courrier configuré", async () => {
    const res = await postIdentity({ localPart: "thomas", displayName: "Your Name" });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({
      address: "thomas@example.com",
      displayName: "Your Name",
      isDefault: false,
    });
  });

  it("normalise la partie locale en minuscules", async () => {
    const res = await postIdentity({ localPart: "  Thomas  ", displayName: "Thomas" });
    expect(await res.json()).toMatchObject({ address: "thomas@example.com" });
  });

  it("accepte l'absence de nom affiché", async () => {
    const res = await postIdentity({ localPart: "thomas" });
    expect(await res.json()).toMatchObject({ displayName: null });
  });

  it("refuse une partie locale invalide", async () => {
    const res = await postIdentity({ localPart: "a b@c" });
    expect(res.status).toBe(400);
    expect((await res.json() as { error: { code: string } }).error.code).toBe("invalid_body");
  });

  it("refuse un doublon", async () => {
    await postIdentity({ localPart: "thomas" });
    const res = await postIdentity({ localPart: "thomas" });
    expect(res.status).toBe(409);
    expect((await res.json() as { error: { code: string } }).error.code).toBe("duplicate_identity");
  });
});

describe("GET /api/identities", () => {
  it("liste les identités, celle par défaut en tête", async () => {
    await postIdentity({ localPart: "b", displayName: "B" });
    await postIdentity({ localPart: "a", displayName: "A" });
    await patchIdentity("a@example.com", { isDefault: true });
    const identities = (await (await req("/api/identities")).json()) as { address: string }[];
    expect(identities.map((i) => i.address)).toEqual(["a@example.com", "b@example.com"]);
  });
});

describe("PATCH /api/identities/:address", () => {
  it("renomme une identité", async () => {
    await postIdentity({ localPart: "thomas", displayName: "Thomas" });
    const res = await patchIdentity("thomas@example.com", { displayName: "Your Name" });
    expect(res.status).toBe(200);
    const identities = (await (await req("/api/identities")).json()) as { displayName: string }[];
    expect(identities[0].displayName).toBe("Your Name");
  });

  it("la définit comme identité par défaut", async () => {
    await postIdentity({ localPart: "thomas", displayName: "Thomas" });
    const res = await patchIdentity("thomas@example.com", { isDefault: true });
    expect(res.status).toBe(200);
    const identities = (await (await req("/api/identities")).json()) as { isDefault: boolean }[];
    expect(identities[0].isDefault).toBe(true);
  });

  it("répond 404 sur une adresse inconnue", async () => {
    expect((await patchIdentity("inconnu@example.com", { isDefault: true })).status).toBe(404);
  });

  it("répond 400 sans displayName ni isDefault", async () => {
    await postIdentity({ localPart: "thomas" });
    const res = await patchIdentity("thomas@example.com", {});
    expect(res.status).toBe(400);
  });
});

describe("DELETE /api/identities/:address", () => {
  it("supprime une identité", async () => {
    await postIdentity({ localPart: "a" });
    await postIdentity({ localPart: "b" });
    expect((await req("/api/identities/a@example.com", { method: "DELETE" })).status).toBe(200);
    const identities = (await (await req("/api/identities")).json()) as { address: string }[];
    expect(identities).toEqual([{ address: "b@example.com", displayName: null, isDefault: false }]);
  });

  it("répond 404 sur une adresse inconnue", async () => {
    await postIdentity({ localPart: "a" });
    expect((await req("/api/identities/inconnu@example.com", { method: "DELETE" })).status).toBe(404);
  });

  it("refuse de supprimer la dernière identité restante", async () => {
    await postIdentity({ localPart: "a" });
    const res = await req("/api/identities/a@example.com", { method: "DELETE" });
    expect(res.status).toBe(409);
    expect((await res.json() as { error: { code: string } }).error.code).toBe("last_identity");
  });
});

describe("frontière Access", () => {
  it("refuse les routes d'identités sans jeton", async () => {
    const res = await app.request("https://example.com/api/identities", {}, env);
    expect(res.status).toBe(401);
  });
});
