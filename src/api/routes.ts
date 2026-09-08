import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../env";
import type { AccessIdentity } from "../auth/access";
import { getThread, listIdentities, listThreads } from "../db/queries";
import { moveToFolder, purgeMessage, setRead } from "../db/mutations";
import { sanitizeHtml } from "../html/sanitize";

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
  // Non atomique entre les deux appels : quand isRead et folder sont fournis ensemble,
  // setRead et moveToFolder s'exécutent dans deux `batch` D1 indépendants. Un échec entre les
  // deux laisserait is_read appliqué sans le changement de dossier (ou l'inverse). Accepté pour
  // cette tâche (probabilité faible, effet borné à l'incohérence d'un seul message) ; à
  // regrouper dans une transaction unique si ça devient sensible.
  let ok = true;
  if (parsed.data.isRead !== undefined) ok = await setRead(c.env.DB, id, parsed.data.isRead);
  if (ok && parsed.data.folder !== undefined) ok = await moveToFolder(c.env.DB, id, parsed.data.folder);
  if (!ok) return c.json({ error: { code: "not_found", message: "Message introuvable" } }, 404);
  return c.json({ ok: true });
});

api.get("/messages/:id/body", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id)) {
    return c.json({ error: { code: "invalid_id", message: "Identifiant invalide" } }, 400);
  }

  const msg = await c.env.DB.prepare("SELECT html_body, text_body FROM messages WHERE id = ?")
    .bind(id)
    .first<{ html_body: string | null; text_body: string | null }>();
  if (!msg) return c.json({ error: { code: "not_found", message: "Message introuvable" } }, 404);
  if (!msg.html_body) {
    return c.json({ html: null, text: msg.text_body ?? "", hasRemoteImages: false });
  }

  const atts = await c.env.DB.prepare(
    "SELECT id, content_id FROM attachments WHERE message_id = ? AND content_id IS NOT NULL"
  ).bind(id).all<{ id: number; content_id: string }>();
  const cidMap = Object.fromEntries(atts.results.map((a) => [a.content_id, a.id]));

  // Tout sauf "allowed" bloque les images distantes — absence du paramètre comprise.
  const result = await sanitizeHtml(msg.html_body, {
    cidMap,
    blockRemoteImages: c.req.query("images") !== "allowed",
  });
  return c.json({ html: result.html, text: msg.text_body ?? "", hasRemoteImages: result.hasRemoteImages });
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

// Types autorisés à être servis avec leur Content-Type d'origine. Tout le reste (le
// mime_type provient de l'en-tête Content-Type de l'email, donc contrôlé par l'expéditeur)
// retombe sur application/octet-stream, en particulier text/html qui déclencherait un rendu
// actif si le navigateur naviguait vers cette URL.
const SAFE_INLINE_TYPES = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "text/plain",
]);

// Extrait le type de base (avant le premier ';', normalisé en minuscules) et le compare
// STRICTEMENT (égalité exacte, jamais includes()/regex sur la chaîne brute) à la liste
// blanche. Un attaquant qui ajoute des paramètres ("text/html; x=image/png"), joue sur la
// casse, ou insère des caractères de contrôle ne peut donc jamais se faire passer pour un
// type sûr : la valeur émise dans l'en-tête est toujours la constante canonique de la liste
// blanche, jamais la chaîne fournie par l'expéditeur.
function safeContentType(raw: string): string {
  const base = raw.split(";")[0]?.trim().toLowerCase() ?? "";
  return SAFE_INLINE_TYPES.has(base) ? base : "application/octet-stream";
}

// Construit un nom de fichier ASCII sûr pour le paramètre filename= d'un Content-Disposition
// (RFC 6266 exige une quoted-string ASCII). On remplace tout caractère de contrôle (y compris
// CR/LF, qui permettrait une injection d'en-tête HTTP), tout caractère non-ASCII, ainsi que
// les guillemets et antislashs (qui romphraient le parsing de la quoted-string), par "_".
// Le nom d'origine, lui, reste disponible en toute fidélité via le paramètre filename*
// (RFC 5987) où il est pourcent-encodé.
function safeAsciiFilename(name: string): string {
  const sanitized = Array.from(name)
    .map((ch) => {
      const code = ch.codePointAt(0) ?? 0;
      if (code < 0x20 || code === 0x7f || code > 0x7e) return "_";
      if (ch === '"' || ch === "\\") return "_";
      return ch;
    })
    .join("");
  return sanitized || "fichier";
}

function contentDispositionFor(filename: string): string {
  const name = filename || "fichier";
  const asciiName = safeAsciiFilename(name);
  const utf8Name = encodeURIComponent(name);
  return `attachment; filename="${asciiName}"; filename*=UTF-8''${utf8Name}`;
}

// Sert le contenu d'une pièce jointe depuis R2. Content-Disposition est TOUJOURS "attachment"
// (jamais "inline"), y compris pour les images. Ce n'est pas un problème pour l'affichage des
// images cid: réécrites par sanitizeHtml vers cette route : Content-Disposition ne s'applique
// qu'à une navigation de premier niveau (l'utilisateur ouvre l'URL directement, ou clique un
// lien <a>) ; une sous-ressource chargée via <img src="..."> à l'intérieur de l'iframe
// sandboxée du message est récupérée comme une image, pas comme un document, et le navigateur
// ignore Content-Disposition dans ce contexte pour la décoder et l'afficher normalement.
// "attachment" en revanche empêche bien un rendu HTML si quelqu'un ouvre l'URL de la pièce
// jointe dans un nouvel onglet ; combiné à X-Content-Type-Options: nosniff et au Content-Type
// forcé à application/octet-stream pour tout type non whitelisté, ceci empêche un fichier
// hostile nommé "facture.html" d'être exécuté comme page.
api.get("/attachments/:id", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id)) {
    return c.json({ error: { code: "invalid_id", message: "Identifiant invalide" } }, 400);
  }

  const att = await c.env.DB.prepare(
    "SELECT filename, mime_type, r2_key FROM attachments WHERE id = ?"
  ).bind(id).first<{ filename: string; mime_type: string; r2_key: string }>();
  if (!att) return c.json({ error: { code: "not_found", message: "Pièce jointe introuvable" } }, 404);

  const obj = await c.env.MAIL.get(att.r2_key);
  if (!obj) return c.json({ error: { code: "not_found", message: "Contenu introuvable" } }, 404);

  return new Response(obj.body, {
    headers: {
      "content-type": safeContentType(att.mime_type),
      "content-disposition": contentDispositionFor(att.filename),
      "x-content-type-options": "nosniff",
    },
  });
});

// Sert le .eml brut d'origine depuis R2, non assaini par nature (c'est le point d'entrée de
// tout le pipeline de sanitization). Content-Disposition: attachment garantit qu'il n'est
// jamais rendu par le navigateur, seulement téléchargé.
api.get("/messages/:id/raw", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id)) {
    return c.json({ error: { code: "invalid_id", message: "Identifiant invalide" } }, 400);
  }

  const msg = await c.env.DB.prepare("SELECT raw_key FROM messages WHERE id = ?")
    .bind(id).first<{ raw_key: string }>();
  if (!msg) return c.json({ error: { code: "not_found", message: "Message introuvable" } }, 404);

  const obj = await c.env.MAIL.get(msg.raw_key);
  if (!obj) return c.json({ error: { code: "not_found", message: "MIME brut introuvable" } }, 404);

  return new Response(obj.body, {
    headers: {
      "content-type": "message/rfc822",
      "content-disposition": `attachment; filename="message-${id}.eml"`,
      "x-content-type-options": "nosniff",
    },
  });
});
