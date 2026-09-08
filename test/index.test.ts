import { env } from "cloudflare:test";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { app, securityHeaders } from "../src/index";
// Import brut (résolu au build, sans dépendre du système de fichiers hôte dans
// l'environnement workerd des tests) : garantit qu'une suppression accidentelle de
// web/public/_headers, ou de ses en-têtes, fait échouer la suite.
// @ts-expect-error -- import Vite "?raw" : pas de types dédiés, contenu = string
import headersFile from "../web/public/_headers?raw";

describe("middleware securityHeaders (src/index.ts)", () => {
  const buildApp = () => {
    const app = new Hono();
    app.use("*", securityHeaders());
    app.get("/html", (c) => c.html("<p>bonjour</p>"));
    app.get("/json", (c) => c.json({ ok: true }));
    return app;
  };

  it("pose la CSP et les en-têtes de sécurité sur une réponse HTML générée par le Worker", async () => {
    const res = await buildApp().request("/html");
    expect(res.headers.get("content-security-policy")).toContain("default-src 'self'");
    expect(res.headers.get("content-security-policy")).toContain("img-src 'self' data: https:");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
  });

  it("ne pose aucun de ces en-têtes sur une réponse JSON", async () => {
    const res = await buildApp().request("/json");
    expect(res.headers.get("content-security-policy")).toBeNull();
    expect(res.headers.get("x-content-type-options")).toBeNull();
    expect(res.headers.get("referrer-policy")).toBeNull();
  });
});

describe("web/public/_headers (couvre le document du SPA, hors-Worker)", () => {
  it("contient une règle /* avec la CSP, nosniff et referrer-policy", () => {
    expect(headersFile).toMatch(/^\/\*\s*$/m);
    expect(headersFile).toContain("Content-Security-Policy:");
    expect(headersFile).toContain("default-src 'self'");
    expect(headersFile).toContain("img-src 'self' data: https:");
    expect(headersFile).toContain("X-Content-Type-Options: nosniff");
    expect(headersFile).toContain("Referrer-Policy: no-referrer");
  });
});

describe("app.onError (contrat d'erreur uniforme)", () => {
  afterEach(() => vi.restoreAllMocks());

  // Régression : sans onError, toute exception non rattrapée dans une route renvoyait
  // « Internal Server Error » en texte brut, alors que tout le reste de l'API répond
  // { error: { code, message } }.
  it("renvoie la forme standard { error: { code, message } } en 500", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    // Binding DB retiré : la route lève à la première utilisation de c.env.DB.
    const res = await app.request(
      "https://example.com/api/identities",
      {},
      { ...env, DB: undefined, DEV_BYPASS_AUTH: "1" },
    );

    expect(res.status).toBe(500);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = await res.json<{ error: { code: string; message: string } }>();
    expect(body.error.code).toBe("internal_error");
    expect(body.error.message).toBe("Erreur interne");
  });

  it("ne divulgue pas le détail interne de l'exception", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await app.request(
      "https://example.com/api/identities",
      {},
      { ...env, DB: undefined, DEV_BYPASS_AUTH: "1" },
    );
    const text = JSON.stringify(await res.json());
    expect(text).not.toMatch(/prepare|undefined|TypeError/);
  });
});
