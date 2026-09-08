import type { Env } from "../env";

export async function setRead(db: D1Database, messageId: number, isRead: boolean): Promise<boolean> {
  const row = await db
    .prepare("SELECT thread_id, folder, is_read FROM messages WHERE id = ?")
    .bind(messageId)
    .first<{ thread_id: number; folder: string; is_read: number }>();
  if (!row) return false;
  if (Boolean(row.is_read) === isRead) return true;

  const statements = [db.prepare("UPDATE messages SET is_read = ? WHERE id = ?").bind(isRead ? 1 : 0, messageId)];

  // Le compteur de non-lus du thread ne reflète que les messages hors corbeille : un message
  // à la corbeille ne doit jamais faire varier unread_count, sous peine de désynchroniser le
  // compteur (cf. moveToFolder, qui a déjà ajusté unread_count au moment de la mise à la corbeille).
  if (row.folder !== "trash") {
    statements.push(
      db.prepare("UPDATE threads SET unread_count = MAX(0, unread_count + ?) WHERE id = ?")
        .bind(isRead ? -1 : 1, row.thread_id)
    );
  }

  await db.batch(statements);
  return true;
}

export async function moveToFolder(
  db: D1Database,
  messageId: number,
  folder: "inbox" | "sent" | "trash",
): Promise<boolean> {
  const row = await db
    .prepare("SELECT thread_id, folder, is_read FROM messages WHERE id = ?")
    .bind(messageId)
    .first<{ thread_id: number; folder: string; is_read: number }>();
  if (!row) return false;
  if (row.folder === folder) return true;

  const wasTrash = row.folder === "trash";
  const goingToTrash = folder === "trash";

  const statements = [db.prepare("UPDATE messages SET folder = ? WHERE id = ?").bind(folder, messageId)];

  // message_count et unread_count ne comptabilisent que les messages hors corbeille. Un
  // aller-retour inbox <-> sent (les deux hors corbeille) ne doit donc toucher aucun des deux
  // compteurs ; seule une entrée ou sortie de la corbeille les fait varier.
  if (wasTrash !== goingToTrash) {
    const delta = goingToTrash ? -1 : 1;
    const unreadDelta = row.is_read ? 0 : delta;
    statements.push(
      db.prepare(
        `UPDATE threads
            SET message_count = MAX(0, message_count + ?),
                unread_count = MAX(0, unread_count + ?)
          WHERE id = ?`
      ).bind(delta, unreadDelta, row.thread_id)
    );
  }

  await db.batch(statements);
  return true;
}

export async function purgeMessage(env: Env, messageId: number): Promise<boolean> {
  const row = await env.DB
    .prepare("SELECT thread_id, folder, is_read, raw_key FROM messages WHERE id = ?")
    .bind(messageId)
    .first<{ thread_id: number; folder: string; is_read: number; raw_key: string }>();
  if (!row) return false;

  const atts = await env.DB
    .prepare("SELECT r2_key FROM attachments WHERE message_id = ?")
    .bind(messageId)
    .all<{ r2_key: string }>();

  // Ordre volontaire (retour sur décision) : on supprime d'abord les objets R2, puis la ligne
  // D1. `R2Bucket#delete` est idempotent — répéter l'appel sur des clés déjà absentes ne fait
  // rien — donc une purge interrompue après la suppression R2 mais avant la suppression D1 se
  // rejoue simplement jusqu'au bout : la ligne D1 encore présente sert d'adresse pour ce rejeu.
  // Si la suppression R2 échoue, on s'arrête sans toucher D1, pour ne jamais perdre l'adresse
  // (raw_key/r2_key) du contenu qu'on n'a pas réussi à supprimer.
  // L'ordre inverse (D1 avant R2) a été essayé puis rejeté : une fois la ligne messages
  // supprimée, `raw_key` et `attachments.r2_key` disparaissent avec elle, et un objet R2
  // orphelin résultant d'un échec R2 après coup n'est alors plus retrouvable qu'en balayant
  // tout le bucket à la recherche de clés sans ligne correspondante — un échec silencieux et
  // définitif sur du contenu de message potentiellement sensible. Le résidu temporaire de
  // l'ordre retenu (une ligne D1 qui référence des objets déjà supprimés, le temps d'un rejeu)
  // est au contraire visible (404 sur la pièce jointe ou le brut) et réparable en relançant la
  // purge.
  const keys = [row.raw_key, ...atts.results.map((a) => a.r2_key)];
  await env.MAIL.delete(keys);

  // Un message déjà à la corbeille a déjà été retiré de message_count/unread_count par
  // moveToFolder : ne pas les décrémenter une seconde fois ici.
  const statements = [
    env.DB.prepare("DELETE FROM attachments WHERE message_id = ?").bind(messageId),
    env.DB.prepare("DELETE FROM recipients WHERE message_id = ?").bind(messageId),
    env.DB.prepare("DELETE FROM messages WHERE id = ?").bind(messageId),
  ];
  if (row.folder !== "trash") {
    statements.push(
      env.DB.prepare(
        `UPDATE threads
            SET message_count = MAX(0, message_count - 1),
                unread_count = MAX(0, unread_count - ?)
          WHERE id = ?`
      ).bind(row.is_read ? 0 : 1, row.thread_id)
    );
  }
  await env.DB.batch(statements);

  const remaining = await env.DB
    .prepare("SELECT COUNT(*) AS n FROM messages WHERE thread_id = ?")
    .bind(row.thread_id)
    .first<{ n: number }>();
  if ((remaining?.n ?? 0) === 0) {
    await env.DB.prepare("DELETE FROM threads WHERE id = ?").bind(row.thread_id).run();
  }

  // Une clé de brut adressée par contenu (raw/<sha256>.eml) pourrait en théorie être partagée
  // par deux messages aux octets strictement identiques ; l'unicité de messages.message_id
  // rend ce cas quasi impossible en pratique (il faudrait deux Message-Id différents pour un
  // corps d'e-mail rigoureusement identique). On ne construit pas de comptage de références
  // pour ce cas résiduel.
  return true;
}
