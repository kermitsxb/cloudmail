import { env, applyD1Migrations } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  CATCH_ALL,
  createForwardRule,
  deleteForwardRule,
  listForwardRules,
  localPart,
  matchingDestinations,
  recordAttempts,
  setForwardRuleEnabled,
} from "../../src/forwarding/rules";

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

const addRule = (matchLocal: string, destination: string, enabled = 1) =>
  env.DB.prepare(
    "INSERT INTO forward_rules (match_local, destination, enabled, created_at) VALUES (?, ?, ?, 0)"
  ).bind(matchLocal, destination, enabled).run();

describe("localPart", () => {
  it("extrait la partie locale en minuscules", () => {
    expect(localPart("Contact@Planigramme.fr")).toBe("contact");
  });

  it("coupe sur la dernière arobase", () => {
    expect(localPart('"a@b"@example.com')).toBe('"a@b"');
  });

  it("renvoie null sans partie locale exploitable", () => {
    expect(localPart("pas-une-adresse")).toBeNull();
    expect(localPart("@example.com")).toBeNull();
  });
});

describe("matchingDestinations", () => {
  it("retient la règle nominative", async () => {
    await addRule("contact", "a@exemple.com");
    const matches = await matchingDestinations(env.DB, "contact@example.com");
    expect(matches).toEqual([{ ruleIds: [expect.any(Number)], destination: "a@exemple.com" }]);
  });

  it("retient la règle catch-all pour n'importe quelle adresse", async () => {
    await addRule(CATCH_ALL, "a@exemple.com");
    const matches = await matchingDestinations(env.DB, "nimportequoi@example.com");
    expect(matches.map((m) => m.destination)).toEqual(["a@exemple.com"]);
  });

  it("cumule règle nominative et catch-all", async () => {
    await addRule(CATCH_ALL, "archive@exemple.com");
    await addRule("thomas", "gmail@exemple.com");
    const matches = await matchingDestinations(env.DB, "thomas@example.com");
    expect(matches.map((m) => m.destination).sort()).toEqual([
      "archive@exemple.com",
      "gmail@exemple.com",
    ]);
  });

  it("dédoublonne les destinations identiques en conservant les deux règles", async () => {
    await addRule(CATCH_ALL, "gmail@exemple.com");
    await addRule("thomas", "GMAIL@exemple.com");
    const matches = await matchingDestinations(env.DB, "thomas@example.com");
    expect(matches).toHaveLength(1);
    expect(matches[0].ruleIds).toHaveLength(2);
  });

  it("ignore les règles désactivées", async () => {
    await addRule("thomas", "a@exemple.com", 0);
    expect(await matchingDestinations(env.DB, "thomas@example.com")).toEqual([]);
  });

  it("compare la partie locale sans tenir compte de la casse", async () => {
    await addRule("thomas", "a@exemple.com");
    const matches = await matchingDestinations(env.DB, "Thomas@Planigramme.fr");
    expect(matches).toHaveLength(1);
  });

  it("n'applique que le catch-all si l'adresse est inexploitable", async () => {
    await addRule(CATCH_ALL, "a@exemple.com");
    await addRule("thomas", "b@exemple.com");
    const matches = await matchingDestinations(env.DB, "adresse-cassee");
    expect(matches.map((m) => m.destination)).toEqual(["a@exemple.com"]);
  });
});

describe("recordAttempts", () => {
  const readRule = (id: number) =>
    env.DB.prepare(
      "SELECT last_attempt_at, last_status, last_error FROM forward_rules WHERE id = ?"
    ).bind(id).first<{ last_attempt_at: number; last_status: string; last_error: string | null }>();

  it("marque une règle servie avec succès", async () => {
    const { meta } = await addRule("thomas", "a@exemple.com");
    const id = meta.last_row_id;
    await recordAttempts(env.DB, [{ ruleIds: [id], status: "ok" }], 1700000000000);
    expect(await readRule(id)).toMatchObject({
      last_attempt_at: 1700000000000,
      last_status: "ok",
      last_error: null,
    });
  });

  it("enregistre l'erreur sur toutes les règles d'une destination en échec", async () => {
    const a = (await addRule(CATCH_ALL, "x@exemple.com")).meta.last_row_id;
    const b = (await addRule("thomas", "x@exemple.com")).meta.last_row_id;
    await recordAttempts(
      env.DB,
      [{ ruleIds: [a, b], status: "error", error: "destination non vérifiée" }],
      42,
    );
    expect(await readRule(a)).toMatchObject({ last_status: "error", last_error: "destination non vérifiée" });
    expect(await readRule(b)).toMatchObject({ last_status: "error", last_error: "destination non vérifiée" });
  });

  it("efface l'erreur précédente quand la tentative réussit", async () => {
    const id = (await addRule("thomas", "a@exemple.com")).meta.last_row_id;
    await recordAttempts(env.DB, [{ ruleIds: [id], status: "error", error: "boom" }], 1);
    await recordAttempts(env.DB, [{ ruleIds: [id], status: "ok" }], 2);
    expect(await readRule(id)).toMatchObject({ last_status: "ok", last_error: null });
  });

  it("tronque un message d'erreur trop long", async () => {
    const id = (await addRule("thomas", "a@exemple.com")).meta.last_row_id;
    await recordAttempts(env.DB, [{ ruleIds: [id], status: "error", error: "x".repeat(900) }], 1);
    const row = await readRule(id);
    expect(row?.last_error).toHaveLength(500);
  });

  it("ne fait rien sur une liste vide", async () => {
    await expect(recordAttempts(env.DB, [], 1)).resolves.toBeUndefined();
  });
});

describe("CRUD des règles", () => {
  it("crée une règle et la relit", async () => {
    const created = await createForwardRule(
      env.DB,
      { matchLocal: "contact", destination: "a@exemple.com" },
      1700000000000,
    );
    expect(created).toMatchObject({
      matchLocal: "contact",
      destination: "a@exemple.com",
      enabled: true,
      createdAt: 1700000000000,
      lastStatus: null,
    });
    expect(await listForwardRules(env.DB)).toHaveLength(1);
  });

  it("renvoie null sur un couple (source, destination) déjà présent", async () => {
    await createForwardRule(env.DB, { matchLocal: "contact", destination: "a@exemple.com" }, 1);
    const again = await createForwardRule(
      env.DB,
      { matchLocal: "contact", destination: "a@exemple.com" },
      2,
    );
    expect(again).toBeNull();
    expect(await listForwardRules(env.DB)).toHaveLength(1);
  });

  it("autorise deux règles catch-all vers des destinations différentes", async () => {
    await createForwardRule(env.DB, { matchLocal: CATCH_ALL, destination: "a@exemple.com" }, 1);
    await createForwardRule(env.DB, { matchLocal: CATCH_ALL, destination: "b@exemple.com" }, 2);
    expect(await listForwardRules(env.DB)).toHaveLength(2);
  });

  it("refuse une seconde règle catch-all identique", async () => {
    await createForwardRule(env.DB, { matchLocal: CATCH_ALL, destination: "a@exemple.com" }, 1);
    expect(
      await createForwardRule(env.DB, { matchLocal: CATCH_ALL, destination: "a@exemple.com" }, 2)
    ).toBeNull();
  });

  it("désactive puis réactive une règle", async () => {
    const rule = await createForwardRule(env.DB, { matchLocal: "contact", destination: "a@exemple.com" }, 1);
    expect(await setForwardRuleEnabled(env.DB, rule!.id, false)).toBe(true);
    expect((await listForwardRules(env.DB))[0].enabled).toBe(false);
    await setForwardRuleEnabled(env.DB, rule!.id, true);
    expect((await listForwardRules(env.DB))[0].enabled).toBe(true);
  });

  it("supprime une règle", async () => {
    const rule = await createForwardRule(env.DB, { matchLocal: "contact", destination: "a@exemple.com" }, 1);
    expect(await deleteForwardRule(env.DB, rule!.id)).toBe(true);
    expect(await listForwardRules(env.DB)).toEqual([]);
  });

  it("signale l'absence sur un identifiant inconnu", async () => {
    expect(await setForwardRuleEnabled(env.DB, 999, false)).toBe(false);
    expect(await deleteForwardRule(env.DB, 999)).toBe(false);
  });
});
