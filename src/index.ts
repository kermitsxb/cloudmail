import { Hono } from "hono";
import type { Env } from "./env";
import { handleEmail } from "./email";
import { requireAccess } from "./auth/access";
import { api } from "./api/routes";

const app = new Hono<{ Bindings: Env }>();

app.get("/healthz", (c) => c.json({ ok: true }));

// CSP applicative : seconde barrière après l'assainissement du HTML des emails côté
// Worker (voir src/api/routes.ts) et le sandbox="" de l'iframe côté front. Le SPA ne
// charge que ses propres scripts/styles ; l'iframe de corps de message est en srcDoc
// (donc "self" pour frame-src) et peut charger des images distantes une fois que
// l'utilisateur a explicitement choisi de les afficher — d'où img-src élargi à https:.
app.use("*", async (c, next) => {
  await next();
  if (c.res.headers.get("content-type")?.includes("text/html")) {
    c.res.headers.set(
      "content-security-policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
        "img-src 'self' data: https:; frame-src 'self'; connect-src 'self'; " +
        "object-src 'none'; base-uri 'none'; form-action 'none'",
    );
    c.res.headers.set("x-content-type-options", "nosniff");
    c.res.headers.set("referrer-policy", "no-referrer");
  }
});

app.use("/api/*", requireAccess());

app.route("/api", api);

export { app };

export default {
  fetch: app.fetch,
  email: handleEmail,
} satisfies ExportedHandler<Env>;
