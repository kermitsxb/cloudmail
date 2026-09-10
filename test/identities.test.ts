import { env, applyD1Migrations } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createIdentity,
  deleteIdentity,
  listIdentities,
  updateIdentity,
} from "../src/identities";

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

describe("listIdentities", () => {
  it("liste les identités par défaut d'abord, puis par ordre alphabétique", async () => {
    await env.DB.prepare(
      "INSERT INTO identities (address, display_name, is_default) VALUES ('b@example.com', 'B', 0), ('a@example.com', 'A', 1)"
    ).run();
    expect(await listIdentities(env.DB)).toEqual([
      { address: "a@example.com", displayName: "A", isDefault: true },
      { address: "b@example.com", displayName: "B", isDefault: false },
    ]);
  });
});

describe("createIdentity", () => {
  it("crée une identité et la relit", async () => {
    const created = await createIdentity(env.DB, { address: "thomas@example.com", displayName: "Thomas" });
    expect(created).toEqual({ address: "thomas@example.com", displayName: "Thomas", isDefault: false });
    expect(await listIdentities(env.DB)).toHaveLength(1);
  });

  it("accepte l'absence de nom affiché", async () => {
    const created = await createIdentity(env.DB, { address: "thomas@example.com", displayName: null });
    expect(created).toMatchObject({ displayName: null });
  });

  it("renvoie null sur une adresse déjà présente", async () => {
    await createIdentity(env.DB, { address: "thomas@example.com", displayName: "Thomas" });
    expect(await createIdentity(env.DB, { address: "thomas@example.com", displayName: "Autre" })).toBeNull();
    expect(await listIdentities(env.DB)).toHaveLength(1);
  });
});

describe("updateIdentity", () => {
  it("renomme une identité", async () => {
    await createIdentity(env.DB, { address: "thomas@example.com", displayName: "Thomas" });
    expect(await updateIdentity(env.DB, "thomas@example.com", { displayName: "Your Name" })).toBe(true);
    expect((await listIdentities(env.DB))[0].displayName).toBe("Your Name");
  });

  it("la définit comme identité par défaut, et retire le défaut des autres", async () => {
    await createIdentity(env.DB, { address: "a@example.com", displayName: "A" });
    await createIdentity(env.DB, { address: "b@example.com", displayName: "B" });
    await updateIdentity(env.DB, "a@example.com", { isDefault: true });
    expect(await updateIdentity(env.DB, "b@example.com", { isDefault: true })).toBe(true);

    const rows = await listIdentities(env.DB);
    expect(rows.find((r) => r.address === "a@example.com")?.isDefault).toBe(false);
    expect(rows.find((r) => r.address === "b@example.com")?.isDefault).toBe(true);
  });

  it("signale l'absence sur une adresse inconnue", async () => {
    expect(await updateIdentity(env.DB, "inconnu@example.com", { displayName: "X" })).toBe(false);
  });
});

describe("deleteIdentity", () => {
  it("supprime une identité", async () => {
    await createIdentity(env.DB, { address: "a@example.com", displayName: "A" });
    await createIdentity(env.DB, { address: "b@example.com", displayName: "B" });
    expect(await deleteIdentity(env.DB, "a@example.com")).toBe("ok");
    expect(await listIdentities(env.DB)).toHaveLength(1);
  });

  it("signale l'absence sur une adresse inconnue", async () => {
    await createIdentity(env.DB, { address: "a@example.com", displayName: "A" });
    expect(await deleteIdentity(env.DB, "inconnu@example.com")).toBe("not_found");
  });

  it("refuse de supprimer la dernière identité restante", async () => {
    await createIdentity(env.DB, { address: "a@example.com", displayName: "A" });
    expect(await deleteIdentity(env.DB, "a@example.com")).toBe("last");
    expect(await listIdentities(env.DB)).toHaveLength(1);
  });

  it("distingue la dernière identité restante d'une adresse inconnue quand la table n'a qu'une ligne", async () => {
    await createIdentity(env.DB, { address: "a@example.com", displayName: "A" });
    expect(await deleteIdentity(env.DB, "inconnu@example.com")).toBe("not_found");
  });
});
