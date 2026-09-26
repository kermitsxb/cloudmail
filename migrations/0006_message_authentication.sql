-- Verdicts d'authentification (SPF, DKIM, DMARC) et dossier Spam.
--
-- Une contrainte CHECK ne se modifie pas en SQLite : ajouter 'spam' impose de reconstruire
-- messages. D1 applique les clés étrangères sans permettre de les désactiver, d'où deux
-- pièges vérifiés sur un D1 local :
--   - DROP TABLE messages fait un DELETE implicite qui déclenche ON DELETE CASCADE : la
--     reconstruction habituelle viderait recipients et attachments ;
--   - ALTER TABLE … RENAME réécrit les clés étrangères des tables enfants vers le nouveau nom.
-- On reconstruit donc aussi les deux tables enfants, et on supprime les enfants AVANT
-- messages : au moment du DROP de messages, plus rien ne le référence. Les id sont conservés,
-- donc messages_fts (table à contenu externe indexée par rowid) reste valide sans être touchée.
--
-- trashed_at change de sens sans changer de nom : date d'entrée dans la corbeille OU dans
-- Spam, point de départ de la purge planifiée (src/maintenance/trash.ts).

CREATE TABLE messages_new (
  id INTEGER PRIMARY KEY,
  thread_id INTEGER NOT NULL REFERENCES threads(id),
  message_id TEXT NOT NULL UNIQUE,
  in_reply_to TEXT,
  direction TEXT NOT NULL CHECK (direction IN ('in','out')),
  folder TEXT NOT NULL CHECK (folder IN ('inbox','sent','trash','spam')),
  from_addr TEXT NOT NULL,
  from_name TEXT,
  subject TEXT,
  text_body TEXT,
  html_body TEXT,
  snippet TEXT,
  received_at INTEGER NOT NULL,
  is_read INTEGER NOT NULL DEFAULT 0,
  has_attachments INTEGER NOT NULL DEFAULT 0,
  raw_key TEXT NOT NULL,
  parse_error INTEGER NOT NULL DEFAULT 0,
  body_truncated INTEGER NOT NULL DEFAULT 0,
  trashed_at INTEGER,
  -- Verdicts lus dans le premier en-tête Authentication-Results, s'il vient de
  -- mx.cloudflare.net (src/ingest/auth.ts). NULL : aucun verdict de confiance.
  auth_spf TEXT,
  auth_dkim TEXT,
  auth_dmarc TEXT,
  -- X-CF-SpamH-Score, conservé sans être utilisé : Cloudflare n'en documente pas l'échelle.
  spam_score INTEGER
);

CREATE TABLE recipients_new (
  id INTEGER PRIMARY KEY,
  message_id INTEGER NOT NULL REFERENCES messages_new(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('to','cc','reply-to')),
  address TEXT NOT NULL,
  name TEXT
);

CREATE TABLE attachments_new (
  id INTEGER PRIMARY KEY,
  message_id INTEGER NOT NULL REFERENCES messages_new(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  content_id TEXT,
  r2_key TEXT NOT NULL
);

INSERT INTO messages_new
  (id, thread_id, message_id, in_reply_to, direction, folder, from_addr, from_name, subject,
   text_body, html_body, snippet, received_at, is_read, has_attachments, raw_key, parse_error,
   body_truncated, trashed_at)
SELECT id, thread_id, message_id, in_reply_to, direction, folder, from_addr, from_name, subject,
       text_body, html_body, snippet, received_at, is_read, has_attachments, raw_key, parse_error,
       body_truncated, trashed_at
  FROM messages;

INSERT INTO recipients_new (id, message_id, kind, address, name)
SELECT id, message_id, kind, address, name FROM recipients;

INSERT INTO attachments_new (id, message_id, filename, mime_type, size, content_id, r2_key)
SELECT id, message_id, filename, mime_type, size, content_id, r2_key FROM attachments;

-- Enfants d'abord : le DROP de messages ne doit plus rien trouver à supprimer en cascade.
-- Les triggers FTS (messages_ai, messages_ad, messages_au) disparaissent avec messages.
DROP TABLE recipients;
DROP TABLE attachments;
DROP TABLE messages;

ALTER TABLE messages_new RENAME TO messages;
ALTER TABLE recipients_new RENAME TO recipients;
ALTER TABLE attachments_new RENAME TO attachments;

CREATE INDEX idx_messages_folder ON messages(folder, received_at DESC);
CREATE INDEX idx_messages_thread ON messages(thread_id);
CREATE INDEX idx_messages_in_reply_to ON messages(in_reply_to);
CREATE INDEX idx_messages_raw_key ON messages(raw_key);
CREATE INDEX idx_messages_trashed_at ON messages(folder, trashed_at);
CREATE INDEX idx_recipients_message ON recipients(message_id);
CREATE INDEX idx_recipients_address ON recipients(address);
CREATE INDEX idx_attachments_message ON attachments(message_id);

CREATE TRIGGER messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, subject, from_addr, text_body)
  VALUES (new.id, new.subject, new.from_addr, new.text_body);
END;

CREATE TRIGGER messages_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, subject, from_addr, text_body)
  VALUES ('delete', old.id, old.subject, old.from_addr, old.text_body);
END;

CREATE TRIGGER messages_au AFTER UPDATE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, subject, from_addr, text_body)
  VALUES ('delete', old.id, old.subject, old.from_addr, old.text_body);
  INSERT INTO messages_fts(rowid, subject, from_addr, text_body)
  VALUES (new.id, new.subject, new.from_addr, new.text_body);
END;
