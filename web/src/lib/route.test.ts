import { describe, expect, it } from "vitest";
import { parseRoute, routePath } from "./route";

describe("parseRoute", () => {
  it("ouvre la boîte de réception à la racine", () => {
    expect(parseRoute("/")).toEqual({ folder: "inbox", threadId: null });
  });

  it("lit le dossier seul", () => {
    expect(parseRoute("/sent")).toEqual({ folder: "sent", threadId: null });
    expect(parseRoute("/trash/")).toEqual({ folder: "trash", threadId: null });
  });

  it("lit le dossier et la conversation", () => {
    expect(parseRoute("/inbox/42")).toEqual({ folder: "inbox", threadId: 42 });
    expect(parseRoute("/trash/7")).toEqual({ folder: "trash", threadId: 7 });
  });

  it("retombe sur la boîte de réception pour un chemin inconnu", () => {
    expect(parseRoute("/spam/3")).toEqual({ folder: "inbox", threadId: null });
    expect(parseRoute("/nimporte/quoi/ici")).toEqual({ folder: "inbox", threadId: null });
  });

  it("ignore un identifiant de conversation invalide", () => {
    expect(parseRoute("/inbox/abc")).toEqual({ folder: "inbox", threadId: null });
    expect(parseRoute("/inbox/0")).toEqual({ folder: "inbox", threadId: null });
    expect(parseRoute("/inbox/-1")).toEqual({ folder: "inbox", threadId: null });
    expect(parseRoute("/inbox/1.5")).toEqual({ folder: "inbox", threadId: null });
  });
});

describe("routePath", () => {
  it("construit le chemin d'un dossier", () => {
    expect(routePath({ folder: "sent", threadId: null })).toBe("/sent");
  });

  it("construit le chemin d'une conversation", () => {
    expect(routePath({ folder: "inbox", threadId: 42 })).toBe("/inbox/42");
  });

  it("fait l'aller-retour avec parseRoute", () => {
    const route = { folder: "trash", threadId: 9 };
    expect(parseRoute(routePath(route))).toEqual(route);
  });
});
