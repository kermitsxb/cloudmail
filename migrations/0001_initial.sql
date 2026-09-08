-- migrations/0001_initial.sql
PRAGMA foreign_keys = ON;

CREATE TABLE identities (
  id INTEGER PRIMARY KEY,
  address TEXT NOT NULL UNIQUE,
  display_name TEXT,
  is_default INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE threads (
  id INTEGER PRIMARY KEY,
  subject_norm TEXT NOT NULL,
  last_message_at INTEGER NOT NULL,
  message_count INTEGER NOT NULL DEFAULT 0,
  unread_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_threads_last ON threads(last_message_at DESC);

CREATE TABLE messages (
  id INTEGER PRIMARY KEY,
  thread_id INTEGER NOT NULL REFERENCES threads(id),
  message_id TEXT NOT NULL UNIQUE,
  in_reply_to TEXT,
  direction TEXT NOT NULL CHECK (direction IN ('in','out')),
  folder TEXT NOT NULL CHECK (folder IN ('inbox','sent','trash')),
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
  parse_error INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_messages_folder ON messages(folder, received_at DESC);
CREATE INDEX idx_messages_thread ON messages(thread_id);
CREATE INDEX idx_messages_in_reply_to ON messages(in_reply_to);

CREATE TABLE recipients (
  id INTEGER PRIMARY KEY,
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('to','cc','reply-to')),
  address TEXT NOT NULL,
  name TEXT
);
CREATE INDEX idx_recipients_message ON recipients(message_id);
CREATE INDEX idx_recipients_address ON recipients(address);

CREATE TABLE attachments (
  id INTEGER PRIMARY KEY,
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  filename TEXT,
  mime_type TEXT,
  size INTEGER,
  content_id TEXT,
  r2_key TEXT NOT NULL
);
CREATE INDEX idx_attachments_message ON attachments(message_id);

CREATE VIRTUAL TABLE messages_fts USING fts5(
  subject, from_addr, text_body,
  content='messages', content_rowid='id',
  tokenize="unicode61 remove_diacritics 2"
);

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
