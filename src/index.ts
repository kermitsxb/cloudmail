import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
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
//
// IMPORTANT : ce middleware NE couvre PAS le document du SPA (index.html) ni ses
// assets. `wrangler.jsonc` sert ces réponses directement depuis le binding ASSETS
// (`run_worker_first` ne liste que "/api/*" et "/healthz"), donc elles ne traversent
// jamais ce code — la garde `content-type: text/html` ci-dessous ne matche alors
// jamais rien. Les mêmes en-têtes sont donc dupliqués dans `web/public/_headers`
// (recopié tel quel dans `web/dist` par Vite), qui est la seule couche qui atteint
// réellement le document SPA. Ce middleware reste une défense en profondeur gratuite
// pour toute réponse HTML que le Worker générerait lui-même.
export const securityHeaders = (): MiddlewareHandler<{ Bindings: Env }> => async (c, next) => {
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
};

app.use("*", securityHeaders());

app.use("/api/*", requireAccess());

app.route("/api", api);

// Contrat d'erreur uniforme : toute exception non rattrapée dans une route renverrait
// sinon un « 500 Internal Server Error » en texte brut, alors que tout le reste de l'API
// répond { error: { code, message } }. Le détail interne (message d'exception, pile) n'est
// pas divulgué au client — il part dans les logs du Worker, seule surface de diagnostic.
app.onError((err, c) => {
  console.error(JSON.stringify({
    event: "unhandled_error",
    path: new URL(c.req.url).pathname,
    error: err instanceof Error ? err.message : String(err),
  }));
  return c.json({ error: { code: "internal_error", message: "Erreur interne" } }, 500);
});

export { app };

export default {
  fetch: app.fetch,
  email: handleEmail,
} satisfies ExportedHandler<Env>;
