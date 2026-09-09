import type { Env } from "../env";

// Distingue « la liste des destinations est inconnue » de « le compte n'a aucune
// destination ». Les deux se traduiraient par un tableau vide, alors que l'UI doit
// les présenter différemment : un problème de configuration n'est pas un état vide.
export class RoutingUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RoutingUnavailableError";
  }
}

type AddressRow = { email: string; verified: string | null };

export async function listVerifiedDestinations(env: Env): Promise<string[]> {
  if (!env.CF_ACCOUNT_ID || !env.CF_ROUTING_TOKEN) {
    throw new RoutingUnavailableError(
      "CF_ACCOUNT_ID ou CF_ROUTING_TOKEN n'est pas configuré sur ce Worker"
    );
  }

  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/email/routing/addresses?per_page=50`,
    { headers: { Authorization: `Bearer ${env.CF_ROUTING_TOKEN}` } }
  );

  const body = (await res.json().catch(() => null)) as
    | { success?: boolean; result?: AddressRow[] }
    | null;

  if (!res.ok || !body?.success || !Array.isArray(body.result)) {
    throw new RoutingUnavailableError(`API Cloudflare Email Routing : statut ${res.status}`);
  }

  // `verified` porte la date de confirmation, ou null tant que le lien reçu par
  // mail n'a pas été cliqué. Seules les adresses confirmées sont acceptées par
  // message.forward().
  return body.result.filter((a) => a.verified).map((a) => a.email);
}
