import { env, applyD1Migrations } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { app } from "../../src/index";

interface TestEnv {
  TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
}

const testEnv = env as unknown as TestEnv;

beforeAll(async () => {
  await applyD1Migrations(env.DB, testEnv.TEST_MIGRATIONS);
});

beforeEach(async () => {
  await env.DB.batch([env.DB.prepare("DELETE FROM maintenance_runs"), env.DB.prepare("DELETE FROM messages")]);
  let cursor: string | undefined;
  do {
    const page = await env.MAIL.list({ cursor });
    if (page.objects.length > 0) await env.MAIL.delete(page.objects.map((o) => o.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
});

const req = (path: string, init?: RequestInit, over: Record<string, unknown> = {}) =>
  app.request(`https://example.com${path}`, init ?? {}, { ...env, DEV_BYPASS_AUTH: "1", ...over });

const brokenMail = { list: async () => { throw new Error("R2 indisponible"); } };

describe("accès", () => {
  it("refuse les routes de maintenance sans jeton Access", async () => {
    const res = await app.request("https://example.com/api/admin/maintenance", {}, { ...env, DEV_BYPASS_AUTH: "" });
    expect(res.status).toBe(401);
  });
});

describe("GET /api/admin/maintenance", () => {
  it("renvoie la rétention et aucun passage sur une base neuve", async () => {
    const res = await req("/api/admin/maintenance");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ retentionDays: 30, lastRun: null, lastCheck: null });
  });

  it("indique une purge désactivée", async () => {
    const res = await req("/api/admin/maintenance", {}, { TRASH_RETENTION_DAYS: "0" });
    expect(await res.json()).toMatchObject({ retentionDays: null });
  });

  it("renvoie 503 si D1 est indisponible", async () => {
    const brokenDb = { batch: async () => { throw new Error("D1 indisponible"); } };
    const res = await req("/api/admin/maintenance", {}, { DB: brokenDb });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: { code: "storage_unavailable" } });
  });
});

describe("POST /api/admin/maintenance/orphan-check", () => {
  it("vérifie les orphelins et l'expose comme dernière vérification", async () => {
    await env.MAIL.put(`raw/${"a".repeat(64)}.eml`, "Subject: x\r\n\r\ncorps\r\n");

    const res = await req("/api/admin/maintenance/orphan-check", { method: "POST" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ trigger: "manual", orphansCount: 1, orphansComplete: true, trashPurged: null });

    const status = await (await req("/api/admin/maintenance")).json();
    expect(status).toMatchObject({ lastRun: null, lastCheck: { orphansCount: 1 } });
  });

  it("renvoie 503 si la vérification échoue, sans masquer la précédente", async () => {
    await req("/api/admin/maintenance/orphan-check", { method: "POST" });

    const res = await req("/api/admin/maintenance/orphan-check", { method: "POST" }, { MAIL: brokenMail });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: { code: "storage_unavailable" } });

    const status = await (await req("/api/admin/maintenance")).json();
    expect(status).toMatchObject({ lastCheck: { orphansCount: 0 } });
  });
});
