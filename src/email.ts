import type { Env } from "./env";
import { parseEmail } from "./ingest/parse";
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
  let timer: ReturnType<typeof setTimeout> | undefined;
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

export async function reparse(env: Env, rawKey: string, envelopeFrom: string): Promise<void> {
  const obj = await env.MAIL.get(rawKey);
  if (!obj) throw new Error(`objet R2 introuvable : ${rawKey}`);
  const raw = await obj.arrayBuffer();
  const parsed = await parseEmail(raw, envelopeFrom);

  // On supprime la ligne D1 existante avant de rappeler storeIncoming, pour
  // que sa vérification d'idempotence (basée sur message_id) ne se contente
  // pas de renvoyer l'ancienne ligne sans rejouer le parsing. storeIncoming
  // recalculera le même rawKey adressé par contenu (mêmes octets => même
  // clé) : la ré-écriture R2 est un no-op, cohérente avec le brut déjà en
  // place.
  //
  // Écart par rapport au brief : celui-ci se contentait d'un
  // `DELETE FROM messages WHERE message_id = ?` suivi d'un rappel de
  // storeIncoming. Or storeIncoming incrémente inconditionnellement
  // message_count/unread_count du thread à chaque insertion — un simple
  // DELETE laisse ces compteurs déjà incrémentés par l'ingestion d'origine,
  // et le rappel de storeIncoming les incrémente une seconde fois : rejouer
  // un message une fois suffit à gonfler durablement ses compteurs de
  // thread. On compense donc ici en décrémentant le thread concerné avant
  // suppression, symétriquement à ce que storeIncoming va réappliquer.
  const existing = await env.DB.prepare(
    "SELECT id, thread_id, is_read FROM messages WHERE message_id = ?"
  ).bind(parsed.messageId).first<{ id: number; thread_id: number; is_read: number }>();

  if (existing) {
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE threads
           SET message_count = MAX(0, message_count - 1),
               unread_count = MAX(0, unread_count - ?)
         WHERE id = ?`
      ).bind(existing.is_read ? 0 : 1, existing.thread_id),
      env.DB.prepare("DELETE FROM messages WHERE id = ?").bind(existing.id),
    ]);
  }

  await storeIncoming(env, raw, { from: envelopeFrom, to: "" });
}
