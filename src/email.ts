import type { Env } from "./env";
import { storeIncoming } from "./ingest/store";
import { matchingDestinations, recordAttempts, type AttemptResult } from "./forwarding/rules";

// Borne de temps d'un appel à `message.forward()`. Elle n'existe pas pour la
// performance mais pour l'invariant le plus fort du projet : « aucun message
// reçu n'est perdu ». Le forward précède la seule écriture durable du message
// (R2 puis D1), parce que `message.raw` est un flux à usage unique. Les
// try/catch rendent la branche étanche aux exceptions, mais pas à un forward qui
// ne rend jamais la main : sans borne, il consommerait tout le temps alloué au
// handler et le message finirait sans objet R2 ni ligne D1 — pire que n'importe
// quel échec de redirection.
//
// Dix secondes : un forward Email Routing qui aboutit répond en une fraction de
// seconde, donc cette valeur ne peut pas couper une tentative saine. Elle reste
// assez basse pour qu'une ou deux destinations bloquées laissent au handler de
// quoi archiver, dans un budget d'exécution de l'ordre de la trentaine de
// secondes.
export const FORWARD_TIMEOUT_MS = 10_000;

// `message.forward()` borné dans le temps. Le dépassement est converti en
// exception, donc traité par l'appelant exactement comme un refus de
// destination : statut d'erreur sur la règle, log, destination suivante.
async function forwardWithTimeout(
  message: ForwardableEmailMessage,
  destination: string,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    await Promise.race([
      message.forward(destination),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Délai dépassé (${FORWARD_TIMEOUT_MS} ms) : la redirection n'a pas abouti`)),
          FORWARD_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    // Sans cette annulation, un forward rapide laisserait derrière lui un timer
    // en vol qui retiendrait le handler jusqu'à son échéance.
    clearTimeout(timer);
  }
}

// Applique les règles de redirection. Entièrement encapsulée dans son propre
// try/catch : une redirection est un service rendu en plus de l'archivage, jamais
// une condition de celui-ci. Un échec ici — D1 indisponible, destination
// dé-vérifiée — ne doit pas coûter l'archivage du message.
async function applyForwardRules(message: ForwardableEmailMessage, env: Env): Promise<void> {
  try {
    const matches = await matchingDestinations(env.DB, message.to);
    if (matches.length === 0) return;

    const results: AttemptResult[] = [];
    for (const match of matches) {
      try {
        await forwardWithTimeout(message, match.destination);
        results.push({ ruleIds: match.ruleIds, status: "ok" });
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        console.error(JSON.stringify({
          event: "forward_failed",
          to: message.to,
          destination: match.destination,
          error,
        }));
        results.push({ ruleIds: match.ruleIds, status: "error", error });
      }
    }
    await recordAttempts(env.DB, results, Date.now());
  } catch (err) {
    console.error(JSON.stringify({
      event: "forward_rules_failed",
      to: message.to,
      error: err instanceof Error ? err.message : String(err),
    }));
  }
}

export async function handleEmail(message: ForwardableEmailMessage, env: Env): Promise<void> {
  // Les redirections passent AVANT l'archivage : `message.raw` est un
  // ReadableStream à usage unique, et on ne veut pas dépendre de son état après
  // consommation par storeIncoming.
  await applyForwardRules(message, env);

  try {
    const raw = await new Response(message.raw).arrayBuffer();
    const res = await storeIncoming(env, raw, { from: message.from, to: message.to });
    console.log(JSON.stringify({ event: "email_stored", ...res, from: message.from }));
  } catch (err) {
    // On n'appelle jamais setReject : un rejet renverrait un bounce à l'expéditeur.
    // Cette route est le seul endroit du projet où avaler une erreur est le
    // comportement voulu.
    console.error(JSON.stringify({
      event: "email_failed",
      from: message.from,
      to: message.to,
      error: err instanceof Error ? err.message : String(err),
    }));
  }
}
