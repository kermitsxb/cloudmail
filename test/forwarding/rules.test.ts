import { env, applyD1Migrations } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { CATCH_ALL, localPart, matchingDestinations } from "../../src/forwarding/rules";

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
    const matches = await matchingDestinations(env.DB, "contact@planigramme.fr");
    expect(matches).toEqual([{ ruleIds: [expect.any(Number)], destination: "a@exemple.com" }]);
  });

  it("retient la règle catch-all pour n'importe quelle adresse", async () => {
    await addRule(CATCH_ALL, "a@exemple.com");
    const matches = await matchingDestinations(env.DB, "nimportequoi@planigramme.fr");
    expect(matches.map((m) => m.destination)).toEqual(["a@exemple.com"]);
  });

  it("cumule règle nominative et catch-all", async () => {
    await addRule(CATCH_ALL, "archive@exemple.com");
    await addRule("thomas", "gmail@exemple.com");
    const matches = await matchingDestinations(env.DB, "thomas@planigramme.fr");
    expect(matches.map((m) => m.destination).sort()).toEqual([
      "archive@exemple.com",
      "gmail@exemple.com",
    ]);
  });

  it("dédoublonne les destinations identiques en conservant les deux règles", async () => {
    await addRule(CATCH_ALL, "gmail@exemple.com");
    await addRule("thomas", "GMAIL@exemple.com");
    const matches = await matchingDestinations(env.DB, "thomas@planigramme.fr");
    expect(matches).toHaveLength(1);
    expect(matches[0].ruleIds).toHaveLength(2);
  });

  it("ignore les règles désactivées", async () => {
    await addRule("thomas", "a@exemple.com", 0);
    expect(await matchingDestinations(env.DB, "thomas@planigramme.fr")).toEqual([]);
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
