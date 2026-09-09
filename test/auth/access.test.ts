import { SELF, env } from "cloudflare:test";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { app } from "../../src/index";
import { verifyAccessJwt } from "../../src/auth/access";

let priv: CryptoKey;
let jwks: string;

beforeAll(async () => {
  const pair = await generateKeyPair("RS256", { extractable: true });
  priv = pair.privateKey;
  const jwk = await exportJWK(pair.publicKey);
  jwks = JSON.stringify({ keys: [{ ...jwk, kid: "k1", alg: "RS256" }] });
  vi.stubGlobal("fetch", async (input: RequestInfo) =>
    String(input).includes("/cdn-cgi/access/certs")
      ? new Response(jwks, { headers: { "content-type": "application/json" } })
      : new Response("nope", { status: 404 })
  );
});

const testEnv = () => ({
  ...env,
  ACCESS_TEAM_DOMAIN: "acme.cloudflareaccess.com",
  ACCESS_AUD: "aud-123",
  ALLOWED_EMAILS: "vous@example.com",
  DEV_BYPASS_AUTH: undefined,
});

const token = async (over: { email?: string; aud?: string; exp?: string } = {}) =>
  new SignJWT({ email: over.email ?? "vous@example.com" })
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setIssuer("https://acme.cloudflareaccess.com")
    .setAudience(over.aud ?? "aud-123")
    .setIssuedAt()
    .setExpirationTime(over.exp ?? "1h")
    .sign(priv);

describe("verifyAccessJwt", () => {
  it("accepte un jeton valide et retourne l'email", async () => {
    const id = await verifyAccessJwt(testEnv(), await token());
    expect(id.email).toBe("vous@example.com");
  });

  it("refuse une audience incorrecte", async () => {
    await expect(verifyAccessJwt(testEnv(), await token({ aud: "autre" }))).rejects.toThrow();
  });

  it("refuse un jeton expiré", async () => {
    await expect(verifyAccessJwt(testEnv(), await token({ exp: "-1h" }))).rejects.toThrow();
  });

  it("refuse un email non autorisé", async () => {
    await expect(verifyAccessJwt(testEnv(), await token({ email: "intrus@example.com" }))).rejects.toThrow(
      /non autorisé/
    );
  });

  it("refuse un jeton bidon", async () => {
    await expect(verifyAccessJwt(testEnv(), "pas.un.jwt")).rejects.toThrow();
  });
});

describe("environnement de test", () => {
  it("n'active jamais DEV_BYPASS_AUTH globalement", () => {
    // `.dev.vars` (local, ignoré par git) pose DEV_BYPASS_AUTH=1 pour `wrangler dev`.
    // vitest.config.ts le neutralise par un binding explicite : sans cela, les tests
    // de la frontière Access ci-dessous passeraient à côté de ce qu'ils vérifient.
    expect(env.DEV_BYPASS_AUTH || "").not.toBe("1");
  });
});

describe("middleware", () => {
  it("répond 401 sans en-tête Access", async () => {
    const res = await SELF.fetch("https://example.com/api/identities");
    expect(res.status).toBe(401);
  });

  it("répond 401 au format uniforme { error: { code, message } }", async () => {
    const res = await SELF.fetch("https://example.com/api/identities");
    expect(res.status).toBe(401);
    const body = await res.json<{ error: { code: string; message: string } }>();
    expect(body.error).toBeDefined();
    expect(typeof body.error.code).toBe("string");
    expect(typeof body.error.message).toBe("string");
  });

  it("accepte un jeton valide via l'en-tête Cf-Access-Jwt-Assertion", async () => {
    const res = await app.request(
      "https://example.com/api/identities",
      { headers: { "Cf-Access-Jwt-Assertion": await token() } },
      testEnv()
    );
    expect(res.status).not.toBe(401);
  });

  it("accepte un jeton valide via le cookie CF_Authorization", async () => {
    const res = await app.request(
      "https://example.com/api/identities",
      { headers: { cookie: `CF_Authorization=${await token()}` } },
      testEnv()
    );
    expect(res.status).not.toBe(401);
  });

  it("ignore un cookie dont le nom se termine seulement par CF_Authorization", async () => {
    const res = await app.request(
      "https://example.com/api/identities",
      { headers: { cookie: `XCF_Authorization=${await token()}` } },
      testEnv()
    );
    expect(res.status).toBe(401);
  });

  it("ne divulgue pas de donnée sur la sonde publique /healthz", async () => {
    const res = await SELF.fetch("https://example.com/healthz");
    expect(res.status).toBe(200);
  });
});
