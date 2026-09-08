import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../env";
import type { AccessIdentity } from "../auth/access";
import { getThread, listIdentities, listThreads } from "../db/queries";

export type ApiEnv = { Bindings: Env; Variables: { identity: AccessIdentity } };

const listQuery = z.object({
  folder: z.enum(["inbox", "sent", "trash"]).default("inbox"),
  q: z.string().max(200).optional(),
  cursor: z.string().max(200).optional(),
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
