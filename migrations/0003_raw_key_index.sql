-- Le brut d'un message (raw/<sha256>.eml) n'a pas d'autre adresse que cette colonne.
-- La recherche des orphelins (objets R2 sans ligne) et le réimport retrouvent les lignes
-- par raw_key : sans index, chaque page de 500 clés parcourrait toute la table.
CREATE INDEX idx_messages_raw_key ON messages(raw_key);
