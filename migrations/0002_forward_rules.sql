-- migrations/0002_forward_rules.sql
CREATE TABLE forward_rules (
  id INTEGER PRIMARY KEY,
  -- Partie locale de l'adresse source, ou '*' pour « toutes les adresses ». On
  -- utilise une sentinelle plutôt que NULL : en SQLite deux NULL sont distincts,
  -- donc l'index unique ci-dessous laisserait créer deux fois la même règle
  -- catch-all vers la même destination. '*' n'étant pas une partie locale valide,
  -- la collision avec une vraie adresse est impossible.
  match_local TEXT NOT NULL,
  destination TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  -- Résultat de la dernière tentative de forward. Utile même avec une saisie par
  -- liste fermée : une destination peut être supprimée ou dé-vérifiée côté
  -- Cloudflare après la création de la règle, et rien d'autre ne le signalerait.
  last_attempt_at INTEGER,
  last_status TEXT CHECK (last_status IN ('ok','error')),
  last_error TEXT
);

CREATE UNIQUE INDEX idx_forward_rules_pair ON forward_rules(match_local, destination);
CREATE INDEX idx_forward_rules_match ON forward_rules(match_local) WHERE enabled = 1;
