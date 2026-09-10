import type { Env } from "../env";

export type SendRequest = {
  from: string;
  fromName?: string | null; // display_name de l'identité expéditrice (voir src/identities.ts)
  to: string[];
  cc?: string[];
  subject: string;
  text: string;
  html?: string;
  replyTo?: string;
  inReplyTo?: string; // Message-ID auquel on répond
  references?: string[];
  attachments?: { filename: string; mimeType: string; contentBase64: string }[];
};

export type SendResult = { delivered: string[]; queued: string[]; permanentBounces: string[] };

export const MAX_PAYLOAD_BYTES = 5 * 1024 * 1024;

export class SendError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "SendError";
  }
}

// Mesure conservatrice de la taille du message tel qu'il sera effectivement transmis à l'API.
//
// Le corps JSON envoyé à Cloudflare porte les pièces jointes encodées en base64 (voir
// `body.attachments` plus bas : `content: a.contentBase64`), pas leurs octets décodés. On
// mesure donc la longueur de la chaîne base64 telle quelle (`.length`, en caractères ASCII
// donc en octets une fois sérialisée) plutôt que de la décoder : c'est à la fois plus fidèle
// à ce qui part réellement sur le réseau, et plus conservateur que compter les octets décodés
// (une chaîne base64 pèse environ 4/3 des octets qu'elle encode, donc ce calcul majore
// systématiquement la taille réelle de la pièce jointe). Pour la limite de 5 MiB imposée par
// l'API sur le message complet, mieux vaut refuser un message légèrement trop gros que d'en
// laisser passer un que l'API rejettera de toute façon après l'appel réseau.
export function payloadSize(req: SendRequest): number {
  const body = new TextEncoder().encode(
    req.subject + req.text + (req.html ?? "") + req.to.join(",") + (req.cc ?? []).join(",")
  ).byteLength;
  const attachments = (req.attachments ?? []).reduce(
    (sum, a) => sum + a.contentBase64.length + a.filename.length,
    0
  );
  return body + attachments;
}

export async function sendEmail(env: Env, req: SendRequest): Promise<SendResult> {
  if (payloadSize(req) > MAX_PAYLOAD_BYTES) {
    throw new SendError("Le message dépasse la limite de 5 MiB", 413);
  }

  const headers: Record<string, string> = {};
  if (req.inReplyTo) headers["In-Reply-To"] = req.inReplyTo;
  if (req.references?.length) headers["References"] = req.references.join(" ");

  const body: Record<string, unknown> = {
    // Un nom affiché transforme `from` en objet : c'est ce qui manquait pour que les clients
    // de messagerie (Gmail, etc.) affichent autre chose que l'adresse brute de l'expéditeur.
    from: req.fromName ? { address: req.from, name: req.fromName } : req.from,
    to: req.to,
    subject: req.subject,
    text: req.text,
  };
  if (req.cc?.length) body.cc = req.cc;
  if (req.html) body.html = req.html;
  if (req.replyTo) body["reply-to"] = req.replyTo;
  if (Object.keys(headers).length) body.headers = headers;
  if (req.attachments?.length) {
    body.attachments = req.attachments.map((a) => ({
      filename: a.filename,
      content: a.contentBase64,
      type: a.mimeType,
    }));
  }

  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/email/sending/send`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${env.CF_API_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    }
  );

  const payload = (await res.json().catch(() => null)) as
    | { success?: boolean; result?: { delivered?: string[]; queued?: string[]; permanent_bounces?: string[] }; errors?: { message: string }[] }
    | null;

  // `payload` ne contient jamais le jeton d'autorisation (il vient de la réponse de l'API, pas
  // de la requête), donc ce message d'erreur — susceptible de remonter jusqu'au client HTTP —
  // ne peut pas exposer CF_API_TOKEN.
  if (!res.ok || payload?.success === false) {
    const message = payload?.errors?.map((e) => e.message).join(" ; ")
      ?? `L'API Email Sending a répondu ${res.status}`;
    throw new SendError(message, res.status);
  }

  return {
    delivered: payload?.result?.delivered ?? [],
    queued: payload?.result?.queued ?? [],
    permanentBounces: payload?.result?.permanent_bounces ?? [],
  };
}
