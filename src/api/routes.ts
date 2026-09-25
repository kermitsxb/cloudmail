import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../env";
import type { AccessIdentity } from "../auth/access";
import { getThread, listThreads } from "../db/queries";
import { moveToFolder, purgeMessage, setRead, storeOutgoing } from "../db/mutations";
import { sanitizeHtml } from "../html/sanitize";
import { MAX_PAYLOAD_BYTES, SendError, payloadSize, sendEmail, type SendRequest } from "../send/client";
import {
  CATCH_ALL,
  createForwardRule,
  deleteForwardRule,
  listForwardRules,
  setForwardRuleEnabled,
} from "../forwarding/rules";
import { RoutingUnavailableError, listVerifiedDestinations } from "../forwarding/destinations";
import { createIdentity, deleteIdentity, listIdentities, updateIdentity } from "../identities";
import { RAW_KEY_PATTERN, listOrphans, listParseErrors, reimportKey } from "../admin/reimport";

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
  message: "Provide isRead or folder",
});

const sendBody = z.object({
  from: z.string().email(),
  to: z.array(z.string().email()).min(1).max(20),
  cc: z.array(z.string().email()).max(20).optional(),
  subject: z.string().max(500),
  text: z.string(),
  html: z.string().optional(),
  inReplyTo: z.string().max(500).optional(),
  attachments: z.array(z.object({
    filename: z.string().max(200),
    mimeType: z.string().max(120),
    contentBase64: z.string(),
  })).max(10).optional(),
});

// Partie locale d'une adresse, ou la sentinelle '*' pour « toutes les adresses ».
// Le jeu de caractères est celui des adresses non citées du RFC 5322 : suffisant
// pour tout ce qui s'écrit en pratique, et assez restreint pour qu'aucune valeur
// acceptée ici ne puisse être confondue avec la sentinelle.
// Le message est un repli en anglais destiné au développeur ; l'interface affiche sa
// propre traduction à partir de la `reason` posée ici via `params`.
const INVALID_LOCAL_PART = { message: "Invalid local part", params: { reason: "invalid_local_part" } };

const forwardRuleBody = z.object({
  matchLocal: z
    .string()
    .trim()
    .max(64)
    .transform((v) => v.toLowerCase())
    .refine((v) => v === CATCH_ALL || /^[a-z0-9._%+-]+$/.test(v), INVALID_LOCAL_PART),
  destination: z.string().email(),
});

const forwardRulePatchBody = z.object({ enabled: z.boolean() });

// Même jeu de caractères que matchLocal ci-dessus, sans la sentinelle catch-all :
// une identité désigne toujours une adresse concrète, jamais « toutes les
// adresses ». Le domaine n'est pas saisi : il est imposé à MAIL_DOMAIN, la seule
// valeur pour laquelle l'API Cloudflare Email Sending accepte d'envoyer.
const identityBody = z.object({
  localPart: z
    .string()
    .trim()
    .max(64)
    .transform((v) => v.toLowerCase())
    .refine((v) => /^[a-z0-9._%+-]+$/.test(v), INVALID_LOCAL_PART),
  displayName: z.string().trim().max(200).optional(),
});

const identityPatchBody = z.object({
  displayName: z.string().trim().max(200).nullable().optional(),
  isDefault: z.boolean().optional(),
}).refine((b) => b.displayName !== undefined || b.isDefault !== undefined, {
  message: "Provide displayName or isDefault",
});

// Un lot de réimport reste petit : chaque clé coûte plusieurs sous-requêtes R2 et D1, et
// c'est le SPA qui enchaîne les lots pour une sélection plus grande.
const REIMPORT_MAX_KEYS = 10;

const orphansQuery = z.object({ cursor: z.string().min(1).max(1024).optional() });

const parseErrorsQuery = z.object({
  cursor: z.string().refine((v) => /^\d{1,15}$/.test(v), { message: "Invalid cursor" }).optional(),
});

const reimportBody = z.object({
  keys: z.array(z.string()).min(1).max(REIMPORT_MAX_KEYS).refine(
    (keys) => keys.every((k) => RAW_KEY_PATTERN.test(k)),
    { message: "Invalid key: only raw incoming messages (raw/<sha256>.eml) can be re-imported" },
  ),
});

// Erreur de validation renvoyée au client. Le `message` est un repli en anglais,
// destiné au développeur : l'interface affiche sa propre traduction à partir du
// `code` et, quand elle existe, de la `reason` — posée via `params` sur les
// `.refine()` qu'un utilisateur peut déclencher depuis un formulaire. Les issues
// `custom` portent un message rédigé ici même, plus précis qu'une formulation
// générique par chemin de champ : on les préfère dès qu'il en existe une.
const isCustomIssue = (issue: z.core.$ZodIssue): issue is z.core.$ZodIssueCustom => issue.code === "custom";

const validationError = (error: z.ZodError): { message: string; reason?: string } => {
  const custom = error.issues.filter(isCustomIssue);
  // Un seul `reason` est retenu : à ce jour, au plus un `.refine()` exposant une
  // raison au client existe par schéma, donc le premier trouvé est le bon.
  const reason = custom
    .map((issue) => issue.params?.reason)
    .find((r): r is string => typeof r === "string");
  const message = custom.length > 0
    ? custom.map((issue) => issue.message).join("; ")
    : `Invalid request: check ${error.issues.map((issue) => issue.path.join(".") || "the request body").join(", ")}.`;
  return reason ? { message, reason } : { message };
};

// Réponse 503 commune aux deux routes qui interrogent la liste des destinations
// vérifiées : elles doivent réagir de façon identique à une panne côté API
// Cloudflare Email Routing (« inconnu », pas une liste vide ni une erreur 500).
const routingUnavailableResponse = () =>
  Response.json({
    error: {
      code: "routing_unavailable",
      message: "Could not read the verified destinations of the Cloudflare account",
    },
  }, { status: 503 });

// Une panne R2 ou D1 pendant un listage d'administration : « je ne sais pas », pas une liste
// vide qui ferait croire qu'il n'y a aucun orphelin. Le détail part dans les logs.
const storageUnavailableResponse = (path: string, err: unknown) => {
  console.error(JSON.stringify({
    event: "admin_listing_failed",
    path,
    error: err instanceof Error ? err.message : String(err),
  }));
  return Response.json({
    error: {
      code: "storage_unavailable",
      message: "Could not read message storage. Try again in a moment.",
    },
  }, { status: 503 });
};

// Récupère la liste des destinations vérifiées, ou la réponse 503 à renvoyer si
// l'API Cloudflare est inaccessible. Toute autre exception continue de remonter
// (elle sera traitée par le gestionnaire d'erreurs global, en 500).
async function listVerifiedDestinationsOrResponse(env: Env): Promise<string[] | Response> {
  try {
    return await listVerifiedDestinations(env);
  } catch (err) {
    if (err instanceof RoutingUnavailableError) return routingUnavailableResponse();
    throw err;
  }
}

export const api = new Hono<ApiEnv>();

api.get("/threads", async (c) => {
  const parsed = listQuery.safeParse(c.req.query());
  if (!parsed.success) {
    return c.json({ error: { code: "invalid_query", ...validationError(parsed.error) } }, 400);
  }
  return c.json(await listThreads(c.env.DB, parsed.data));
});

api.get("/threads/:id", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id)) return c.json({ error: { code: "invalid_id", message: "Invalid ID" } }, 400);
  const thread = await getThread(c.env.DB, id);
  if (!thread) return c.json({ error: { code: "not_found", message: "Thread not found" } }, 404);
  return c.json(thread);
});

api.get("/identities", async (c) => c.json(await listIdentities(c.env.DB)));

api.post("/identities", async (c) => {
  const parsed = identityBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: { code: "invalid_body", ...validationError(parsed.error) } }, 400);
  }

  const address = `${parsed.data.localPart}@${c.env.MAIL_DOMAIN}`;
  const identity = await createIdentity(c.env.DB, { address, displayName: parsed.data.displayName ?? null });
  if (!identity) {
    return c.json({
      error: { code: "duplicate_identity", message: "Identity already exists" },
    }, 409);
  }
  return c.json(identity, 201);
});

api.patch("/identities/:address", async (c) => {
  const parsed = identityPatchBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: { code: "invalid_body", ...validationError(parsed.error) } }, 400);
  }
  const found = await updateIdentity(c.env.DB, c.req.param("address"), parsed.data);
  if (!found) {
    return c.json({ error: { code: "not_found", message: "Identity not found" } }, 404);
  }
  return c.json({ ok: true });
});

api.delete("/identities/:address", async (c) => {
  const result = await deleteIdentity(c.env.DB, c.req.param("address"));
  if (result === "not_found") {
    return c.json({ error: { code: "not_found", message: "Identity not found" } }, 404);
  }
  if (result === "last") {
    return c.json({
      error: { code: "last_identity", message: "Cannot delete the last remaining identity" },
    }, 409);
  }
  return c.json({ ok: true });
});

// Envoie un email via l'API Cloudflare Email Sending puis, seulement si l'envoi a réussi,
// stocke une copie du message dans le dossier "sent". Le CF_API_TOKEN utilisé par sendEmail
// n'apparaît jamais ici : ni dans les logs (aucun log n'est émis sur ce chemin), ni dans les
// réponses d'erreur (SendError ne porte que le message renvoyé par l'API Cloudflare elle-même).
api.post("/messages", async (c) => {
  const parsed = sendBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: { code: "invalid_body", message: parsed.error.issues[0].message } }, 400);
  }

  // L'expéditeur doit être une identité connue : un `from` arbitraire est refusé avant tout
  // appel réseau, donc avant toute consommation du quota d'envoi. On récupère au passage son
  // display_name, pour que l'email envoyé porte "Nom <adresse>" plutôt que l'adresse seule.
  const identity = await c.env.DB.prepare("SELECT display_name FROM identities WHERE address = ?")
    .bind(parsed.data.from).first<{ display_name: string | null }>();
  if (!identity) {
    return c.json({ error: { code: "unknown_sender", message: "Unknown sender" } }, 400);
  }

  // Reconstitue la chaîne References à partir du message parent, quand il est connu localement.
  let references: string[] | undefined;
  if (parsed.data.inReplyTo) {
    const parent = await c.env.DB.prepare("SELECT message_id FROM messages WHERE message_id = ?")
      .bind(parsed.data.inReplyTo).first<{ message_id: string }>();
    if (parent) references = [parent.message_id];
  }

  const req: SendRequest = { ...parsed.data, fromName: identity.display_name, references };
  // Vérifié aussi côté client (sendEmail) : le refus explicite ici avec le code 413 donne un
  // statut HTTP clair à l'appelant, avant même de tenter l'appel réseau.
  if (payloadSize(req) > MAX_PAYLOAD_BYTES) {
    return c.json({ error: { code: "too_large", message: "Message exceeds 5 MiB" } }, 413);
  }

  let result;
  try {
    result = await sendEmail(c.env, req);
  } catch (err) {
    const status = err instanceof SendError ? err.status : 502;
    return c.json(
      { error: { code: "send_failed", message: err instanceof Error ? err.message : "Send failed" } },
      status as 400 | 413 | 429 | 502
    );
  }

  // Le message n'est stocké en "sent" qu'ici, après confirmation de l'envoi : un envoi en
  // échec (branche catch ci-dessus, ou le refus 413/400 plus haut) ne laisse aucune trace en
  // base.
  const messageId = `<${crypto.randomUUID()}@${c.env.MAIL_DOMAIN}>`;
  const id = await storeOutgoing(c.env, req, messageId);
  return c.json({ id, ...result });
});

api.patch("/messages/:id", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id)) {
    return c.json({ error: { code: "invalid_id", message: "Invalid ID" } }, 400);
  }
  const parsed = patchBody.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    return c.json({ error: { code: "invalid_body", ...validationError(parsed.error) } }, 400);
  }
  // Non atomique entre les deux appels : quand isRead et folder sont fournis ensemble,
  // setRead et moveToFolder s'exécutent dans deux `batch` D1 indépendants. Un échec entre les
  // deux laisserait is_read appliqué sans le changement de dossier (ou l'inverse). Accepté pour
  // cette tâche (probabilité faible, effet borné à l'incohérence d'un seul message) ; à
  // regrouper dans une transaction unique si ça devient sensible.
  let ok = true;
  if (parsed.data.isRead !== undefined) ok = await setRead(c.env.DB, id, parsed.data.isRead);
  if (ok && parsed.data.folder !== undefined) ok = await moveToFolder(c.env.DB, id, parsed.data.folder);
  if (!ok) return c.json({ error: { code: "not_found", message: "Message not found" } }, 404);
  return c.json({ ok: true });
});

api.get("/messages/:id/body", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id)) {
    return c.json({ error: { code: "invalid_id", message: "Invalid ID" } }, 400);
  }

  const msg = await c.env.DB.prepare("SELECT html_body, text_body FROM messages WHERE id = ?")
    .bind(id)
    .first<{ html_body: string | null; text_body: string | null }>();
  if (!msg) return c.json({ error: { code: "not_found", message: "Message not found" } }, 404);
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
    return c.json({ error: { code: "invalid_id", message: "Invalid ID" } }, 400);
  }
  const ok = await purgeMessage(c.env, id);
  if (!ok) return c.json({ error: { code: "not_found", message: "Message not found" } }, 404);
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

// Le nom de fichier vient de l'expéditeur et n'a aucune borne de longueur en MIME. Sans
// plafond ici, un nom de 50 000 caractères produit un Content-Disposition d'environ 150 Ko
// une fois pourcent-encodé (encodeURIComponent peut tripler la taille), au-delà de ce que
// les serveurs et navigateurs acceptent comme en-tête : la pièce jointe devient
// définitivement intéléchargeable. On tronque donc AVANT les deux encodages.
const MAX_FILENAME_CHARS = 200;

function contentDispositionFor(filename: string): string {
  const name = (filename || "fichier").slice(0, MAX_FILENAME_CHARS);
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
    return c.json({ error: { code: "invalid_id", message: "Invalid ID" } }, 400);
  }

  const att = await c.env.DB.prepare(
    "SELECT filename, mime_type, r2_key FROM attachments WHERE id = ?"
  ).bind(id).first<{ filename: string; mime_type: string; r2_key: string }>();
  if (!att) return c.json({ error: { code: "not_found", message: "Attachment not found" } }, 404);

  const obj = await c.env.MAIL.get(att.r2_key);
  if (!obj) return c.json({ error: { code: "not_found", message: "Attachment content not found" } }, 404);

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
    return c.json({ error: { code: "invalid_id", message: "Invalid ID" } }, 400);
  }

  const msg = await c.env.DB.prepare("SELECT raw_key FROM messages WHERE id = ?")
    .bind(id).first<{ raw_key: string }>();
  if (!msg) return c.json({ error: { code: "not_found", message: "Message not found" } }, 404);

  const obj = await c.env.MAIL.get(msg.raw_key);
  if (!obj) return c.json({ error: { code: "not_found", message: "Raw MIME not found" } }, 404);

  return new Response(obj.body, {
    headers: {
      "content-type": "message/rfc822",
      "content-disposition": `attachment; filename="message-${id}.eml"`,
      "x-content-type-options": "nosniff",
    },
  });
});

api.get("/config", (c) => c.json({ mailDomain: c.env.MAIL_DOMAIN }));

api.get("/forwarding/rules", async (c) => c.json(await listForwardRules(c.env.DB)));

api.post("/forwarding/rules", async (c) => {
  const parsed = forwardRuleBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: { code: "invalid_body", ...validationError(parsed.error) } }, 400);
  }

  // La liste fermée côté interface est un confort, pas une garantie : on
  // revalide ici, car une destination non vérifiée ferait échouer le forward
  // silencieusement, longtemps après la création de la règle.
  const destinations = await listVerifiedDestinationsOrResponse(c.env);
  if (destinations instanceof Response) return destinations;

  const destination = parsed.data.destination;
  if (!destinations.some((d) => d.toLowerCase() === destination.toLowerCase())) {
    return c.json({
      error: {
        code: "unverified_destination",
        message: `${destination} is not a verified destination on your Cloudflare account`,
      },
    }, 400);
  }

  const rule = await createForwardRule(c.env.DB, parsed.data, Date.now());
  if (!rule) {
    return c.json({
      error: { code: "duplicate_rule", message: "Forwarding rule already exists" },
    }, 409);
  }
  return c.json(rule, 201);
});

api.patch("/forwarding/rules/:id", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id)) {
    return c.json({ error: { code: "invalid_id", message: "Invalid ID" } }, 400);
  }
  const parsed = forwardRulePatchBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: { code: "invalid_body", ...validationError(parsed.error) } }, 400);
  }
  const found = await setForwardRuleEnabled(c.env.DB, id, parsed.data.enabled);
  if (!found) {
    return c.json({ error: { code: "not_found", message: "Forwarding rule not found" } }, 404);
  }
  return c.json({ ok: true });
});

api.delete("/forwarding/rules/:id", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id)) {
    return c.json({ error: { code: "invalid_id", message: "Invalid ID" } }, 400);
  }
  const found = await deleteForwardRule(c.env.DB, id);
  if (!found) {
    return c.json({ error: { code: "not_found", message: "Forwarding rule not found" } }, 404);
  }
  return c.json({ ok: true });
});

// 503 et non une liste vide : « je ne sais pas » ne doit pas se lire comme
// « le compte n'a aucune destination », l'interface les affiche différemment.
api.get("/forwarding/destinations", async (c) => {
  const destinations = await listVerifiedDestinationsOrResponse(c.env);
  if (destinations instanceof Response) return destinations;
  return c.json({ destinations });
});

api.get("/admin/orphans", async (c) => {
  const parsed = orphansQuery.safeParse(c.req.query());
  if (!parsed.success) {
    return c.json({ error: { code: "invalid_query", ...validationError(parsed.error) } }, 400);
  }
  try {
    return c.json(await listOrphans(c.env, { cursor: parsed.data.cursor }));
  } catch (err) {
    return storageUnavailableResponse("/admin/orphans", err);
  }
});

api.get("/admin/parse-errors", async (c) => {
  const parsed = parseErrorsQuery.safeParse(c.req.query());
  if (!parsed.success) {
    return c.json({ error: { code: "invalid_query", ...validationError(parsed.error) } }, 400);
  }
  const cursor = parsed.data.cursor === undefined ? undefined : Number(parsed.data.cursor);
  try {
    return c.json(await listParseErrors(c.env, { cursor }));
  } catch (err) {
    return storageUnavailableResponse("/admin/parse-errors", err);
  }
});

// Réimporte des bruts un par un, dans l'ordre de la requête. 200 même si certaines clés
// échouent : chaque clé porte son propre résultat (voir reimportKey).
api.post("/admin/reimport", async (c) => {
  const parsed = reimportBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: { code: "invalid_body", ...validationError(parsed.error) } }, 400);
  }
  const by = c.get("identity").email;
  const results = [];
  for (const key of new Set(parsed.data.keys)) results.push(await reimportKey(c.env, key, by));
  return c.json({ results });
});
