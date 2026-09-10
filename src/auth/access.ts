import { createRemoteJWKSet, jwtVerify } from "jose";
import type { MiddlewareHandler } from "hono";
import type { Env } from "../env";

export type AccessIdentity = { email: string };

const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function jwksFor(teamDomain: string) {
  const url = `https://${teamDomain}/cdn-cgi/access/certs`;
  let set = jwksCache.get(url);
  if (!set) {
    set = createRemoteJWKSet(new URL(url), { cacheMaxAge: 3600_000 });
    jwksCache.set(url, set);
  }
  return set;
}

// Les trois variables d'identité Access arrivent au Worker sous forme de secrets
// (voir la mise en service du README) : ALLOWED_EMAILS porte une adresse
// personnelle et n'a donc rien à faire dans un dépôt public. Un secret non posé
// vaut `undefined` et non la chaîne vide — sans cette garde, la lecture des
// adresses autorisées lèverait un TypeError, qui remonterait en « 500 Erreur
// interne » et ferait chercher un bug là où il n'y a qu'une configuration
// incomplète. On refuse donc explicitement, et le message dit quoi poser.
//
// Le cas ALLOWED_EMAILS vide est traité comme absent, et non comme « aucune
// adresse autorisée » : les deux refusent tout de toute façon, mais le message
// oriente vers la bonne cause.
function requireAccessConfig(env: Env): void {
  const manquants = (["ACCESS_TEAM_DOMAIN", "ACCESS_AUD", "ALLOWED_EMAILS"] as const).filter(
    (k) => !env[k]?.trim()
  );
  if (manquants.length > 0) {
    throw new Error(
      `configuration Access incomplète : ${manquants.join(", ")} non posé(s) sur le Worker`
    );
  }
}

export async function verifyAccessJwt(env: Env, token: string): Promise<AccessIdentity> {
  requireAccessConfig(env);
  const { payload } = await jwtVerify(token, jwksFor(env.ACCESS_TEAM_DOMAIN), {
    issuer: `https://${env.ACCESS_TEAM_DOMAIN}`,
    audience: env.ACCESS_AUD,
  });
  const email = String(payload.email ?? "").toLowerCase();
  const allowed = env.ALLOWED_EMAILS.split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  if (!email || !allowed.includes(email)) {
    throw new Error(`email non autorisé : ${email || "(absent)"}`);
  }
  return { email };
}

function tokenFromCookie(cookieHeader: string | null): string | undefined {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    if (name === "CF_Authorization") {
      return part.slice(eq + 1).trim();
    }
  }
  return undefined;
}

export function requireAccess(): MiddlewareHandler<{
  Bindings: Env;
  Variables: { identity: AccessIdentity };
}> {
  return async (c, next) => {
    if (c.env.DEV_BYPASS_AUTH === "1") {
      c.set("identity", { email: "dev@localhost" });
      return next();
    }
    const token = c.req.header("Cf-Access-Jwt-Assertion") ?? tokenFromCookie(c.req.raw.headers.get("cookie"));
    if (!token) {
      return c.json({ error: { code: "unauthenticated", message: "Jeton Access absent" } }, 401);
    }
    try {
      c.set("identity", await verifyAccessJwt(c.env, token));
    } catch (err) {
      return c.json(
        { error: { code: "unauthenticated", message: err instanceof Error ? err.message : "Jeton invalide" } },
        401
      );
    }
    return next();
  };
}
