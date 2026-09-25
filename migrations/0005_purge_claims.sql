-- Réserve une clé R2 pendant la purge, sans supprimer l'adresse D1 avant les objets.
-- La clé primaire sérialise les purges de messages partageant le même raw_key.
CREATE TABLE purge_claims (
  raw_key TEXT PRIMARY KEY,
  message_id INTEGER NOT NULL,
  claimed_at INTEGER NOT NULL
);
