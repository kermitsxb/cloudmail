export type ThreadSummary = {
  id: number; subject: string; snippet: string; lastMessageAt: number;
  messageCount: number; unreadCount: number; participants: string[]; hasAttachments: boolean;
};
export type MessageDetail = {
  id: number; messageId: string; direction: "in" | "out"; folder: string;
  from: { address: string; name: string | null };
  to: { address: string; name: string | null }[];
  cc: { address: string; name: string | null }[];
  subject: string; text: string; html: string | null;
  receivedAt: number; isRead: boolean; parseError: boolean; bodyTruncated: boolean;
  attachments: { id: number; filename: string; mimeType: string; size: number }[];
};
export type ThreadDetail = { id: number; subject: string; messages: MessageDetail[] };

const encodeCursor = (at: number, id: number) => btoa(`${at}:${id}`).replace(/=+$/, "");

// Un curseur fabriqué ou corrompu ne doit jamais faire lever la fonction : on retourne
// null pour signaler "pas de curseur exploitable", ce qui revient à ignorer le filtre de
// pagination plutôt que de planter la requête.
const decodeCursor = (c: string): [number, number] | null => {
  try {
    const [atStr, idStr] = atob(c).split(":");
    const at = Number(atStr);
    const id = Number(idStr);
    if (!Number.isFinite(at) || !Number.isFinite(id)) return null;
    return [at, id];
  } catch {
    return null;
  }
};

// FTS5 interprète guillemets, astérisques et opérateurs (OR, NEAR, AND, NOT) : on cite
// chaque terme et on retire les guillemets internes pour empêcher toute injection de
// syntaxe FTS5 (opérateurs booléens, préfixes, NEAR()...).
const ftsQuery = (q: string): string =>
  q.split(/\s+/).filter(Boolean).map((t) => `"${t.replace(/"/g, "")}"`).join(" ");

export async function listThreads(
  db: D1Database,
  opts: { folder: string; q?: string; cursor?: string; limit?: number },
): Promise<{ threads: ThreadSummary[]; cursor: string | null }> {
  const limit = Math.min(opts.limit ?? 30, 100);
  const params: unknown[] = [opts.folder];
  let where = `EXISTS (SELECT 1 FROM messages m WHERE m.thread_id = t.id AND m.folder = ?)`;

  if (opts.q && opts.q.trim()) {
    where += ` AND EXISTS (
      SELECT 1 FROM messages_fts f JOIN messages m2 ON m2.id = f.rowid
      WHERE m2.thread_id = t.id AND m2.folder = ? AND messages_fts MATCH ?
    )`;
    params.push(opts.folder, ftsQuery(opts.q));
  }

  if (opts.cursor) {
    const decoded = decodeCursor(opts.cursor);
    if (decoded) {
      const [at, id] = decoded;
      where += ` AND (t.last_message_at < ? OR (t.last_message_at = ? AND t.id < ?))`;
      params.push(at, at, id);
    }
    // curseur illisible : on l'ignore silencieusement (équivalent à la première page)
  }

  const rows = await db.prepare(
    `SELECT t.id, t.last_message_at, t.message_count, t.unread_count,
            (SELECT subject FROM messages WHERE thread_id = t.id ORDER BY received_at DESC LIMIT 1) AS subject,
            (SELECT snippet FROM messages WHERE thread_id = t.id ORDER BY received_at DESC LIMIT 1) AS snippet,
            (SELECT GROUP_CONCAT(DISTINCT from_addr) FROM messages WHERE thread_id = t.id) AS participants,
            (SELECT MAX(has_attachments) FROM messages WHERE thread_id = t.id) AS has_attachments
     FROM threads t
     WHERE ${where}
     ORDER BY t.last_message_at DESC, t.id DESC
     LIMIT ?`
  ).bind(...params, limit + 1).all<Record<string, never>>();

  const all = rows.results as unknown as {
    id: number; last_message_at: number; message_count: number; unread_count: number;
    subject: string | null; snippet: string | null; participants: string | null; has_attachments: number | null;
  }[];
  const page = all.slice(0, limit);
  const last = page[page.length - 1];

  return {
    threads: page.map((r) => ({
      id: r.id,
      subject: r.subject ?? "(sans objet)",
      snippet: r.snippet ?? "",
      lastMessageAt: r.last_message_at,
      messageCount: r.message_count,
      unreadCount: r.unread_count,
      participants: (r.participants ?? "").split(",").filter(Boolean),
      hasAttachments: Boolean(r.has_attachments),
    })),
    cursor: all.length > limit && last ? encodeCursor(last.last_message_at, last.id) : null,
  };
}

export async function getThread(db: D1Database, id: number): Promise<ThreadDetail | null> {
  const messages = await db.prepare(
    `SELECT id, message_id, direction, folder, from_addr, from_name, subject, text_body, html_body,
            received_at, is_read, parse_error, body_truncated
     FROM messages WHERE thread_id = ? ORDER BY received_at ASC`
  ).bind(id).all<{
    id: number; message_id: string; direction: "in" | "out"; folder: string;
    from_addr: string; from_name: string | null; subject: string | null;
    text_body: string | null; html_body: string | null;
    received_at: number; is_read: number; parse_error: number; body_truncated: number;
  }>();
  if (messages.results.length === 0) return null;

  // Jointure sur thread_id plutôt qu'un IN (?, ?, ...) énumérant chaque message : D1
  // plafonne à 100 les paramètres liés par requête, donc l'ancienne forme rendait tout fil
  // de plus de 100 messages définitivement inouvrable (erreur systématique sur
  // GET /api/threads/:id). Ici la requête lie un seul paramètre, quelle que soit la taille
  // du fil.
  const recipients = await db.prepare(
    `SELECT r.message_id, r.kind, r.address, r.name
       FROM recipients r JOIN messages m ON m.id = r.message_id
      WHERE m.thread_id = ?`
  ).bind(id).all<{ message_id: number; kind: string; address: string; name: string | null }>();
  const attachments = await db.prepare(
    `SELECT a.id, a.message_id, a.filename, a.mime_type, a.size
       FROM attachments a JOIN messages m ON m.id = a.message_id
      WHERE m.thread_id = ?`
  ).bind(id).all<{ id: number; message_id: number; filename: string; mime_type: string; size: number }>();

  return {
    id,
    subject: messages.results[messages.results.length - 1].subject ?? "(sans objet)",
    messages: messages.results.map((m) => ({
      id: m.id,
      messageId: m.message_id,
      direction: m.direction,
      folder: m.folder,
      from: { address: m.from_addr, name: m.from_name },
      to: recipients.results.filter((r) => r.message_id === m.id && r.kind === "to")
        .map((r) => ({ address: r.address, name: r.name })),
      cc: recipients.results.filter((r) => r.message_id === m.id && r.kind === "cc")
        .map((r) => ({ address: r.address, name: r.name })),
      subject: m.subject ?? "",
      text: m.text_body ?? "",
      html: m.html_body,
      receivedAt: m.received_at,
      isRead: Boolean(m.is_read),
      parseError: Boolean(m.parse_error),
      bodyTruncated: Boolean(m.body_truncated),
      attachments: attachments.results.filter((a) => a.message_id === m.id)
        .map((a) => ({ id: a.id, filename: a.filename, mimeType: a.mime_type, size: a.size })),
    })),
  };
}
