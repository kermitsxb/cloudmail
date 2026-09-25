-- Maintenance planifiée : date d'entrée en corbeille et historique des passages.

-- NULL hors corbeille. Posé et effacé par moveToFolder, seul chemin vers la corbeille.
ALTER TABLE messages ADD COLUMN trashed_at INTEGER;

-- Les messages déjà à la corbeille reçoivent l'heure de la migration, pas leur date de
-- réception : le premier passage après le déploiement ne purge rien, et le plus ancien
-- contenu existant part N jours après le déploiement.
UPDATE messages SET trashed_at = unixepoch() WHERE folder = 'trash';

CREATE INDEX idx_messages_trashed_at ON messages(folder, trashed_at);

CREATE TABLE maintenance_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ran_at INTEGER NOT NULL,
  trigger TEXT NOT NULL CHECK (trigger IN ('cron','manual')),
  trash_purged INTEGER,
  trash_failed INTEGER,
  trash_remaining INTEGER,
  orphans_count INTEGER,
  orphans_complete INTEGER,
  orphans_sample TEXT,
  error TEXT
);
