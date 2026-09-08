# Cloudmail — client webmail sur Cloudflare Email Service

*Design validé le 2026-09-08*

## 1. Objectif

Un client webmail personnel permettant de lire et d'envoyer des emails sur les
adresses du domaine `planigramme.fr`, entièrement hébergé sur Cloudflare.

Usage : mono-utilisateur, plusieurs adresses/alias sur un domaine, vue unifiée,
choix de l'expéditeur à l'envoi.

### Contraintes de la plateforme

Cloudflare Email Service se compose de deux briques distinctes :

- **Email Sending** (public beta depuis avril 2026, plan Workers Paid) : envoi
  via REST API, binding Worker ou SMTP. Domaine expéditeur à vérifier.
  Limite de 5 MiB par message, pièces jointes comprises.
- **Email Routing** (gratuit) : réception, avec routage vers un handler
  `email()` dans un Worker.

**Cloudflare ne fournit aucun stockage de boîte aux lettres.** La persistance
des messages est donc à notre charge : D1 pour les métadonnées et le corps,
R2 pour le MIME brut et les pièces jointes.

Prérequis déjà en place : `planigramme.fr` sur Cloudflare, plan Workers Paid.

## 2. Périmètre v1

Inclus : liste des messages, lecture (HTML assaini + texte), composition,
envoi, réponse, lu/non-lu, suppression, pièces jointes (réception et envoi),
recherche plein texte, regroupement en threads.

Explicitement hors périmètre : brouillons, éditeur WYSIWYG, dossiers
personnalisés et labels, filtres et règles, carnet d'adresses, signatures,
multi-utilisateurs, multi-domaines, tests E2E.

## 3. Architecture

Un **Worker unique** (`cloudmail`, TypeScript) déployé sur
`mail.planigramme.fr`, avec trois entrées :

| Entrée | Rôle |
|---|---|
| `email()` handler | Ingestion des messages entrants routés par Email Routing |
| `fetch()` → `/api/*` (Hono) | API REST du webmail |
| `fetch()` → reste | Sert le SPA React buildé (binding `assets`) |

Bindings : `DB` (D1), `MAIL` (R2). Secrets : `CF_ACCOUNT_ID`, `CF_API_TOKEN`
(portée : envoi d'emails uniquement), `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`,
`ALLOWED_EMAILS`.

### 3.1 Flux entrant

Email Routing est configuré en catch-all sur `planigramme.fr` vers le Worker.

1. `message.raw` (stream consommable une seule fois) est bufferisé en
   `ArrayBuffer`.
2. Écriture immédiate dans R2 sous `raw/{key}.eml`, **avant tout parsing** :
   un message est ainsi toujours rejouable. `key` est le `Message-ID` réduit
   aux caractères `[A-Za-z0-9._-]` et tronqué à 200 caractères ; à défaut de
   `Message-ID` exploitable, un UUID est généré et sert aussi de `message_id`
   en base.
3. `PostalMime.parse()` sur le même buffer.
4. Extraction des pièces jointes vers `att/{key}/{n}-{filename}`, le nom de
   fichier étant assaini de la même façon.
5. Insertion en D1 (message, destinataires, pièces jointes) et résolution du
   thread, dans une transaction unique.

En cas d'échec du parsing : log, puis insertion d'une ligne dégradée
(from/to/subject lus dans les headers bruts, `parse_error = 1`). Le handler ne
lève jamais et n'appelle jamais `setReject` — un rejet provoquerait un bounce
chez l'expéditeur.

### 3.2 Flux sortant

Le front POST `/api/messages` → le Worker valide (Zod), appelle
`POST /accounts/{account_id}/email/sending/send` avec
`Authorization: Bearer {CF_API_TOKEN}`, puis, **après confirmation seulement**,
stocke une copie du message en D1 (`folder = 'sent'`) rattachée au même thread.

Sur une réponse, les en-têtes `In-Reply-To` et `References` sont renseignés via
le champ `headers` de la requête, pour que le threading tienne côté
destinataire.

### 3.3 Authentification

Cloudflare Access protège `mail.planigramme.fr`. Le Worker vérifie le JWT
`Cf-Access-Jwt-Assertion` contre le JWKS du team domain (mis en cache en
mémoire, rafraîchi à l'expiration), valide `aud` et `exp`, et compare l'email
du token à `ALLOWED_EMAILS`.

Aucune route `/api` n'est servie sans JWT valide. En développement local, un
bypass est activé uniquement par la variable explicite `DEV_BYPASS_AUTH`, qui
n'est jamais définie en production.

## 4. Modèle de données (D1)

```sql
-- Les adresses possédées : alimente le sélecteur d'expéditeur et le filtrage
CREATE TABLE identities (
  id INTEGER PRIMARY KEY,
  address TEXT NOT NULL UNIQUE,
  display_name TEXT,
  is_default INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE threads (
  id INTEGER PRIMARY KEY,
  subject_norm TEXT NOT NULL,          -- sujet sans Re:/Fwd:, pour le fallback
  last_message_at INTEGER NOT NULL,
  message_count INTEGER NOT NULL DEFAULT 0,
  unread_count  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE messages (
  id INTEGER PRIMARY KEY,
  thread_id   INTEGER NOT NULL REFERENCES threads(id),
  message_id  TEXT NOT NULL UNIQUE,    -- Message-ID RFC, clé d'idempotence
  in_reply_to TEXT,
  direction   TEXT NOT NULL,           -- 'in' | 'out'
  folder      TEXT NOT NULL,           -- 'inbox' | 'sent' | 'trash'
  from_addr   TEXT NOT NULL,
  from_name   TEXT,
  subject     TEXT,
  text_body   TEXT,
  html_body   TEXT,                    -- stocké brut, assaini à l'affichage
  snippet     TEXT,                    -- 200 premiers caractères du texte
  received_at INTEGER NOT NULL,
  is_read     INTEGER NOT NULL DEFAULT 0,
  has_attachments INTEGER NOT NULL DEFAULT 0,
  raw_key     TEXT NOT NULL,           -- clé R2 du .eml
  parse_error INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE recipients (              -- To/Cc/Reply-To, un par ligne
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,                  -- 'to' | 'cc' | 'reply-to'
  address TEXT NOT NULL,
  name TEXT
);

CREATE TABLE attachments (
  id INTEGER PRIMARY KEY,
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  filename TEXT,
  mime_type TEXT,
  size INTEGER,
  content_id TEXT,                     -- pour les images inline (cid:)
  r2_key TEXT NOT NULL
);

CREATE VIRTUAL TABLE messages_fts USING fts5(
  subject, from_addr, text_body,
  content='messages', content_rowid='id',
  tokenize="unicode61 remove_diacritics 2"
);
```

Index : `messages(folder, received_at DESC)`, `threads(last_message_at DESC)`,
`messages(thread_id)`, `recipients(message_id)`, `attachments(message_id)`.
Trois triggers maintiennent `messages_fts` (insert / update / delete).

### 4.1 Résolution de thread

À l'ingestion, dans cet ordre :

1. `In-Reply-To` correspondant à un `message_id` connu ;
2. `References`, parcouru du plus récent au plus ancien ;
3. sujet normalisé identique **et** participant commun, dans les 30 derniers
   jours ;
4. sinon, création d'un nouveau thread.

`message_count` et `unread_count` sont mis à jour dans la même transaction que
l'insertion du message.

### 4.2 Idempotence et suppression

`message_id UNIQUE` combiné à `INSERT OR IGNORE` : Email Routing peut réessayer
sans jamais produire de doublon.

La suppression positionne `folder = 'trash'`. La purge définitive supprime aussi
les objets R2 associés (brut et pièces jointes).

## 5. API

Toutes les routes sont sous `/api`, en JSON, et exigent un JWT Access valide.

| Route | Rôle |
|---|---|
| `GET /api/threads?folder=&q=&cursor=` | Liste paginée par curseur ; `q` bascule sur FTS5 |
| `GET /api/threads/:id` | Le thread avec tous ses messages et leurs pièces jointes |
| `PATCH /api/messages/:id` | `{ is_read }` ou `{ folder }` |
| `POST /api/messages` | Envoi (voir 3.2) |
| `GET /api/attachments/:id` | Stream depuis R2, `Content-Disposition` et type MIME forcé sûr |
| `GET /api/identities` | Adresses expéditrices disponibles |
| `GET /api/messages/:id/raw` | Le `.eml` d'origine (debug) |

Validation des entrées par Zod à la frontière. Format d'erreur uniforme :
`{ error: { code, message } }`.

## 6. Front

React 19 + Vite + TypeScript, Tailwind et shadcn/ui, TanStack Query pour le
cache et les mutations optimistes (lu/non-lu, suppression).

Layout à trois zones — barre latérale (dossiers, identités), liste des threads,
panneau de lecture — qui devient une pile navigable en mobile. Le composeur est
en texte brut, sans WYSIWYG.

### 6.1 Sécurité de l'affichage HTML

Point le plus sensible d'un webmail :

- assainissement côté **Worker** avec `HTMLRewriter` : allow-list de balises et
  d'attributs, suppression de `<script>`, `<style>`, des attributs `on*` et des
  URL `javascript:` ;
- rendu dans une **iframe `sandbox`** sans `allow-scripts` ;
- images distantes **bloquées par défaut**, avec un bandeau « afficher les
  images » (protection contre les pixels espions) ;
- images inline `cid:` réécrites vers `/api/attachments/:id` ;
- CSP stricte sur l'application ; `target="_blank"` et
  `rel="noopener noreferrer"` forcés sur tous les liens.

## 7. Gestion d'erreurs

**Ingestion.** Le brut est écrit en R2 en premier, donc aucun message n'est
perdu. Un parsing en échec produit une ligne dégradée `parse_error = 1`,
affichée dans l'UI avec un lien vers le `.eml`. Une commande de rejeu permet de
reparser un `.eml` depuis R2 après correction du code.

**Envoi.** Les erreurs de l'API Email Sending sont remontées au front : 429 →
invitation à réessayer, 4xx de validation → message ciblé. Le message n'est
stocké en `sent` qu'après confirmation, pour éviter tout envoi fantôme. Les
`permanent_bounces` de la réponse sont affichés à l'utilisateur.

**Limites.** Le dépassement de 5 MiB (message + pièces jointes encodées en
base64) est refusé côté front **et** côté Worker, avant tout appel réseau.

## 8. Tests

Vitest avec `@cloudflare/vitest-pool-workers`, qui exécute le code dans workerd
avec de vraies instances locales de D1 et R2. TDD sur les trois cœurs logiques :

1. **Ingestion** — corpus de fixtures `.eml` : multipart, pièces jointes,
   images inline `cid:`, charsets non-UTF8, encodages base64 et
   quoted-printable, message malformé. Vérification de l'état de D1 et R2 après
   passage du handler.
2. **Threading** — chaînes de réponses, `References` désordonné, sujet `Re:`
   sans en-tête de référence, idempotence sur `Message-ID` dupliqué.
3. **Assainissement HTML** — batterie de charges XSS (`<script>`, `onerror`,
   `javascript:`, SVG) dont on vérifie qu'aucune ne survit.

Les routes API sont couvertes par des requêtes intégrées avec auth Access
simulée. Le front se limite à quelques tests de composants sur la liste et le
composeur. Pas de E2E en v1.

## 9. Déploiement

Un seul `wrangler deploy` ; le build Vite alimente le binding `assets`.
Migrations D1 versionnées dans `migrations/`. Secrets posés par
`wrangler secret put`.

Étapes manuelles, faites une fois et documentées dans le README :

1. vérification de `planigramme.fr` dans Email Service (enregistrements DNS) ;
2. activation d'Email Routing et règle catch-all vers le Worker `cloudmail` ;
3. création de l'application Cloudflare Access sur `mail.planigramme.fr` ;
4. création du token API limité à l'envoi d'emails ;
5. peuplement de la table `identities`.
