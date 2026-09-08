import { Hono } from "hono";
import type { Env } from "./env";
import { handleEmail } from "./email";
import { requireAccess } from "./auth/access";
import { api } from "./api/routes";

const app = new Hono<{ Bindings: Env }>();

app.get("/healthz", (c) => c.json({ ok: true }));

app.use("/api/*", requireAccess());

app.route("/api", api);

export { app };

export default {
  fetch: app.fetch,
  email: handleEmail,
} satisfies ExportedHandler<Env>;
