import type { Env } from "./env";
import { parseEmail } from "./ingest/parse";
import { storeIncoming } from "./ingest/store";

export async function handleEmail(message: ForwardableEmailMessage, env: Env): Promise<void> {
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
