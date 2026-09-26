// Verdicts SPF, DKIM et DMARC posés par le MX de Cloudflare sur chaque message reçu.
//
// Règle de confiance : un MTA ajoute ses en-têtes en tête du message, donc celui de Cloudflare
// est au-dessus de tout ce que l'expéditeur a pu écrire. On ne lit que le PREMIER
// Authentication-Results, et seulement si son identifiant est exactement mx.cloudflare.net.
// Un expéditeur qui glisse « Authentication-Results: mx.cloudflare.net; dmarc=pass » se
// retrouve sous celui de Cloudflare et n'est jamais lu.

export type AuthVerdict = "pass" | "fail" | "softfail" | "neutral" | "none" | "temperror" | "permerror";

export type AuthResults = {
  spf: AuthVerdict | null;
  dkim: AuthVerdict | null;
  dmarc: AuthVerdict | null;
  spamScore: number | null;
};

export const NO_AUTH: AuthResults = Object.freeze({ spf: null, dkim: null, dmarc: null, spamScore: null });

const TRUSTED_AUTHSERV_ID = "mx.cloudflare.net";

const VERDICTS = new Set<string>(["pass", "fail", "softfail", "neutral", "none", "temperror", "permerror"]);

type Clause = { method: string; result: string; props: string };

// Retire les commentaires entre parenthèses (RFC 5322, imbrication comprise) : ils contiennent
// librement « ; » et « = », qui fausseraient le découpage.
const stripComments = (value: string): string => {
  let depth = 0;
  let out = "";
  for (const ch of value) {
    if (ch === "(") depth++;
    else if (ch === ")" && depth > 0) depth--;
    else if (depth === 0) out += ch;
  }
  return out;
};

const toVerdict = (result: string | undefined): AuthVerdict | null =>
  result && VERDICTS.has(result) ? (result as AuthVerdict) : null;

function parseClauses(value: string): { authservId: string; clauses: Clause[] } {
  const [head = "", ...rest] = stripComments(value).replace(/\s+/g, " ").split(";");
  const authservId = head.trim().split(" ")[0]?.toLowerCase() ?? "";
  const clauses: Clause[] = [];
  for (const part of rest) {
    const m = /^\s*([a-z0-9-]+)\s*=\s*([a-z0-9-]+)(.*)$/i.exec(part);
    if (m) clauses.push({ method: m[1].toLowerCase(), result: m[2].toLowerCase(), props: m[3].toLowerCase() });
  }
  return { authservId, clauses };
}

function spamScoreOf(headers: { key: string; value: string }[]): number | null {
  const raw = headers.find((h) => h.key === "x-cf-spamh-score")?.value.trim() ?? "";
  return /^-?\d+$/.test(raw) ? Number(raw) : null;
}

export function parseAuthentication(headers: { key: string; value: string }[]): AuthResults {
  const spamScore = spamScoreOf(headers);
  const first = headers.find((h) => h.key === "authentication-results");
  if (!first) return { ...NO_AUTH, spamScore };

  const { authservId, clauses } = parseClauses(first.value);
  if (authservId !== TRUSTED_AUTHSERV_ID) return { ...NO_AUTH, spamScore };

  const of = (method: string) => clauses.filter((c) => c.method === method);
  const spf = of("spf");
  const dkim = of("dkim");

  return {
    // Deux résultats SPF possibles (HELO et MAIL FROM) : seul celui de MAIL FROM compte.
    spf: toVerdict((spf.find((c) => c.props.includes("smtp.mailfrom=")) ?? spf[0])?.result),
    // Plusieurs signatures possibles : une seule valide suffit.
    dkim: toVerdict(dkim.some((c) => c.result === "pass") ? "pass" : dkim[0]?.result),
    dmarc: toVerdict(of("dmarc")[0]?.result),
    spamScore,
  };
}
