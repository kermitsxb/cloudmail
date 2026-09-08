import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../env";
import type { AccessIdentity } from "../auth/access";
import { getThread, listIdentities, listThreads } from "../db/queries";
import { moveToFolder, purgeMessage, setRead } from "../db/mutations";

export type ApiEnv = { Bindings: Env; Variables: { identity: AccessIdentity } };

const listQuery = z.object({
  folder: z.enum(["inbox", "sent", "trash"]).default("inbox"),
  q: z.string().max(200).optional(),
  cursor: z.string().max(200).optional(),
});

// Les trois dossiers sont acceptés ici, pas seulement inbox/trash comme l'écrivait le brief
// initial : restaurer un message envoyé depuis la corbeille doit pouvoir le renvoyer vers
// "sent", pas systématiquement vers "inbox". C'est le front qui choisit le dossier de
// restauration selon la direction (in/out) du message.
const patchBody = z.object({
  isRead: z.boolean().optional(),
  folder: z.enum(["inbox", "sent", "trash"]).optional(),
}).refine((b) => b.isRead !== undefined || b.folder !== undefined, {
  message: "Fournir isRead ou folder",
});

export const api = new Hono<ApiEnv>();

api.get("/threads", async (c) => {
  const parsed = listQuery.safeParse(c.req.query());
  if (!parsed.success) {
    return c.json({ error: { code: "invalid_query", message: parsed.error.message } }, 400);
  }
  return c.json(await listThreads(c.env.DB, parsed.data));
});

api.get("/threads/:id", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id)) return c.json({ error: { code: "invalid_id", message: "Identifiant invalide" } }, 400);
  const thread = await getThread(c.env.DB, id);
  if (!thread) return c.json({ error: { code: "not_found", message: "Thread introuvable" } }, 404);
  return c.json(thread);
});

api.get("/identities", async (c) => c.json(await listIdentities(c.env.DB)));

api.patch("/messages/:id", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id)) {
    return c.json({ error: { code: "invalid_id", message: "Identifiant invalide" } }, 400);
  }
  const parsed = patchBody.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    return c.json({ error: { code: "invalid_body", message: parsed.error.message } }, 400);
  }
  let ok = true;
  if (parsed.data.isRead !== undefined) ok = await setRead(c.env.DB, id, parsed.data.isRead);
  if (ok && parsed.data.folder !== undefined) ok = await moveToFolder(c.env.DB, id, parsed.data.folder);
  if (!ok) return c.json({ error: { code: "not_found", message: "Message introuvable" } }, 404);
  return c.json({ ok: true });
});

api.delete("/messages/:id", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id)) {
    return c.json({ error: { code: "invalid_id", message: "Identifiant invalide" } }, 400);
  }
  const ok = await purgeMessage(c.env, id);
  if (!ok) return c.json({ error: { code: "not_found", message: "Message introuvable" } }, 404);
  return c.json({ ok: true });
});
