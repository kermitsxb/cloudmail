# Cloudmail

Client webmail personnel pour `thomas@planigramme.fr`, exécuté entièrement sur un
Worker Cloudflare unique.

## Architecture

Cloudmail tient dans un seul Worker Cloudflare qui porte trois rôles à la fois :
le handler `email()` (exporté par `src/email.ts`) reçoit les messages entrants via
Email Routing et les fait suivre au pipeline d'ingestion (parsing MIME, stockage,
threading) ; une API HTTP construite avec Hono (`src/api/routes.ts`) expose les
opérations de lecture, réponse, recherche et suppression sous `/api/*` ; et le même
Worker sert les fichiers statiques du SPA (le binding `ASSETS`, construit dans
`web/dist`) pour toute autre route, avec fallback SPA. Les métadonnées
structurées (identités, threads, messages, pièces jointes) vivent dans une base
D1 ; le MIME brut de chaque message reçu et les corps des pièces jointes sont
stockés dans un bucket R2. Cloudflare Access se place devant l'ensemble de
l'application : aucune requête n'atteint l'API ou le SPA sans un jeton Access
valide (sauf en développement local, voir plus bas).

## Prérequis Cloudflare

- Le domaine `planigramme.fr` doit être géré sur Cloudflare (zone DNS active).
- Un plan **Workers Paid** est nécessaire pour utiliser Email Sending (l'API
  d'envoi utilisée par `src/send/client.ts`). Email Routing, utilisé pour la
  réception, est gratuit et ne nécessite pas ce plan.
- Cloudflare Access (Zero Trust) doit être disponible sur le compte pour protéger
  `mail.planigramme.fr`.

## Commandes de développement

Telles que définies dans `package.json` :

- `pnpm dev` — lance en parallèle `pnpm wrangler dev` (le Worker, avec D1 et R2
  simulés localement par Miniflare) et `pnpm --filter web dev` (le serveur de dev
  Vite du SPA).
- `pnpm test` — exécute `vitest run` (189 tests côté Worker : ingestion, API,
  auth, envoi) puis `pnpm --filter web test` (24 tests côté SPA).
- `pnpm build` — construit uniquement le SPA (`pnpm --filter web build`), dont la
  sortie (`web/dist`) est servie par le Worker via le binding `ASSETS`.
- `pnpm deploy` — enchaîne `pnpm build` puis `pnpm wrangler deploy` : reconstruit
  le SPA puis déploie le Worker (code + assets) sur Cloudflare.
- `pnpm typecheck` — `tsc --noEmit`, non demandé par le brief mais utile en
  local.

## Mise en service

> **Les migrations deviennent immuables dès leur première application.** Tant que la base
> distante n'existe pas, `migrations/0001_initial.sql` peut encore être modifiée en place.
> Après la première application (étape 2 ci-dessous), toute évolution du schéma passe par un
> nouveau fichier `migrations/000N_*.sql` : D1 enregistre les migrations déjà jouées par leur
> nom, donc une modification a posteriori ne serait jamais rejouée et la base garderait
> silencieusement l'ancien schéma. Si une base **locale** de développement se retrouve dans
> cet état, la réinitialiser suffit : `rm -rf .wrangler/state/v3/d1 .wrangler/state/v3/r2`
> puis `pnpm wrangler d1 migrations apply cloudmail --local`.


Ces étapes touchent le compte Cloudflare payant de l'utilisateur et rendent le
service public : elles ne sont **pas** automatisées et doivent être exécutées à
la main, dans l'ordre, par la personne qui opère le compte.

L'ordre compte, et pas seulement pour des raisons de commodité : la base D1 est
migrée et peuplée (étapes 2 et 3) **avant** tout branchement d'Email Routing
(étape 6). L'ordre inverse perd du courrier — un message arrivé entre
l'activation de la règle catch-all et l'application des migrations rencontre
`no such table: messages`, l'erreur est avalée par `handleEmail` (qui n'appelle
jamais `setReject`, pour ne pas renvoyer de bounce à l'expéditeur), et le message
ne survit que comme objet R2 sans ligne D1 ni index inverse.

### 1. Créer la base D1 et le bucket R2

```bash
pnpm wrangler d1 create cloudmail
pnpm wrangler r2 bucket create cloudmail
```

La commande `d1 create` affiche un `database_id`. Reporter cette valeur dans
`wrangler.jsonc`, à la place du placeholder `"local"` actuellement présent dans
`d1_databases[0].database_id` :

```jsonc
"d1_databases": [
  {
    "binding": "DB",
    "database_name": "cloudmail",
    "database_id": "REMPLACER_PAR_LE_VRAI_ID", // était "local"
    "migrations_dir": "migrations"
  }
]
```

Si cette étape est oubliée, `wrangler deploy` échoue (ou pire, tente de lier une
base D1 inexistante nommée `local`) : le Worker déployé n'a pas de base de
données fonctionnelle. Le placeholder `"local"` ne fonctionne qu'en local, où
Miniflare simule D1 sans authentification Cloudflare — voir le commentaire dans
`wrangler.jsonc`.

### 2. Appliquer les migrations en distant

```bash
pnpm wrangler d1 migrations apply cloudmail --remote
```

Cette étape crée les tables (`identities`, `threads`, `messages`, ...) définies
dans `migrations/0001_initial.sql` sur la base D1 distante. Elle ne dépend que de
l'étape 1 (base créée, `database_id` renseigné) : ni du Worker, ni d'Access, ni
d'Email Routing. Si elle est oubliée, toute requête D1 échoue avec « no such
table » — y compris celles du handler `email()`, dont l'échec est silencieux.

### 3. Peupler la table `identities`

```bash
pnpm wrangler d1 execute cloudmail --remote --command \
  "INSERT INTO identities (address, display_name, is_default) VALUES ('thomas@planigramme.fr', 'Thomas Stocker', 1)"
```

Cette étape crée l'identité d'envoi par défaut ; elle a besoin des tables de
l'étape 2. Sans ligne dans `identities`, l'API n'a aucune adresse `From` à
proposer pour composer ou répondre à un message, et `POST /api/messages` refuse
tout envoi avec `unknown_sender`.

### 4. Premier déploiement (fait exister le Worker)

```bash
pnpm deploy
```

Ce premier déploiement n'a qu'un but : faire exister le Worker `cloudmail` sur
le compte Cloudflare. Il est nécessaire ici, avant même la configuration
d'Access et des secrets d'envoi, parce que l'étape 6 (Email Routing) doit
choisir ce Worker dans une liste déroulante du tableau de bord — et cette
liste ne propose que des Workers déjà déployés. Sans ce premier déploiement,
l'étape 6 est une impasse : la liste est vide et il n'y a rien à sélectionner.

Ce déploiement n'a besoin que des bindings de l'étape 1 (base D1 et bucket R2
existants). À ce stade, le Worker déployé est incomplet (secrets d'envoi
absents, `ACCESS_TEAM_DOMAIN`/`ACCESS_AUD` encore vides) : c'est normal, et sans
danger — avec ces variables vides, `requireAccess()` rejette **toute** requête
API en `401`, donc rien n'est exposé publiquement entre ce déploiement et le
déploiement final de l'étape 10. Sa base, elle, est déjà migrée et peuplée
(étapes 2-3) : le Worker est d'emblée capable d'ingérer du courrier.

### 5. Vérifier le domaine dans Email Service

Tableau de bord Cloudflare → Email → Email Service → Sending → ajouter
`planigramme.fr` et publier les enregistrements DNS demandés (SPF/DKIM). Attendre
le statut « verified ».

Cette étape produit l'autorisation d'envoyer des emails depuis `planigramme.fr`
via l'API Cloudflare Email Sending. Si elle est oubliée ou incomplète, tout
envoi via `src/send/client.ts` échoue (l'API Cloudflare rejette les messages
provenant d'un domaine non vérifié).

### 6. Activer Email Routing avec une règle catch-all

Tableau de bord Cloudflare → Email → Email Routing → activer, puis créer une
règle catch-all « Send to a Worker » pointant sur le Worker `cloudmail` (visible
dans la liste grâce au déploiement de l'étape 4).

Cette étape produit le déclenchement du handler `email()` (`src/email.ts`) pour
tout message reçu sur `*@planigramme.fr`. Si elle est oubliée, aucun message
entrant n'atteint jamais Cloudmail : Cloudflare les rejette ou les jette selon
la configuration DNS MX en place.

C'est la première étape à partir de laquelle du courrier réel peut arriver :
elle exige donc que tout ce dont l'ingestion a besoin existe déjà — le Worker
déployé (étape 4), le bucket R2 (étape 1) et surtout les tables D1 (étape 2).
C'est la raison de la position de cette étape dans la séquence.

### 7. Créer l'application Cloudflare Access

Zero Trust → Access → Applications → Self-hosted, domaine `mail.planigramme.fr`,
politique « Emails » limitée à `vous@example.com`. Copier ensuite
l'Application Audience (AUD) et le team domain dans `wrangler.jsonc`, section
`vars` :

```jsonc
"vars": {
  "ACCESS_TEAM_DOMAIN": "<team>.cloudflareaccess.com",
  "ACCESS_AUD": "<AUD copié depuis l'application Access>",
  "ALLOWED_EMAILS": "vous@example.com"
}
```

Cette étape produit la protection d'accès de `mail.planigramme.fr` : sans jeton
Access valide, `src/auth/access.ts` (`requireAccess()`) rejette toute requête
API avec `401 unauthenticated`. Si `ACCESS_TEAM_DOMAIN` ou `ACCESS_AUD` sont
laissés vides (leur valeur par défaut dans `wrangler.jsonc`), la vérification
JWT échoue systématiquement et personne — pas même l'utilisateur légitime — ne
peut se connecter. (Ces valeurs ne seront effectivement appliquées qu'au
déploiement final, étape 10.)

### 8. Créer un token API restreint à l'envoi d'emails

Tableau de bord Cloudflare → créer un token API avec la seule permission
« Email Sending: Send » (aucune autre permission — ce token ne doit pas pouvoir
gérer le compte, les zones DNS, D1 ou R2).

Cette étape produit le jeton utilisé par `src/send/client.ts` pour appeler
`POST /accounts/{account_id}/email/sending/send`. Un token trop permissif serait
un risque inutile en cas de fuite ; un token absent ou mal scopé fait échouer
tout envoi avec une erreur d'autorisation Cloudflare.

### 9. Poser les secrets

```bash
pnpm wrangler secret put CF_ACCOUNT_ID
pnpm wrangler secret put CF_API_TOKEN
```

Ces deux commandes produisent les secrets chiffrés lus par `src/send/client.ts`
via `env.CF_ACCOUNT_ID` et `env.CF_API_TOKEN` — dont le jeton créé à l'étape 8.
Sans eux, toute tentative de réponse ou d'envoi échoue immédiatement au moment
de l'appel à l'API Cloudflare. Elles s'appliquent au Worker, qui doit donc déjà
exister (étape 4).

### 10. Déploiement final

```bash
pnpm deploy
```

Second et dernier déploiement : cette fois le Worker part avec les secrets
d'envoi posés (étape 9), les variables `ACCESS_TEAM_DOMAIN`/`ACCESS_AUD`
renseignées (étape 7) et une base D1 migrée et peuplée (étapes 2-3). C'est
cette exécution qui rend le service effectivement utilisable en production ;
tant qu'elle n'a pas eu lieu après les étapes précédentes, l'authentification
Access et l'envoi d'email restent non fonctionnels malgré un Worker déjà en
ligne depuis l'étape 4.

## Rejeu d'un message (`reparse`)

`src/email.ts` exporte `reparse(env, rawKey, envelopeFrom)`, qui relit le MIME
brut déjà stocké dans R2 (clé `rawKey`), le re-parse, supprime la ligne D1
existante correspondante (en décrémentant au passage les compteurs du thread
d'origine) puis rappelle `storeIncoming` comme si le message venait d'arriver.
C'est la fonction à utiliser pour rejouer un message après un correctif du
parseur, sans avoir à faire renvoyer l'email par l'expéditeur d'origine.

**Aucun point d'entrée n'est livré aujourd'hui.** `reparse` n'est appelée nulle
part dans le code : ni route API, ni script, ni commande `wrangler`. Elle
existe et est testée, mais rien dans l'application déployée ne permet de la
déclencher. Pour l'invoquer malgré tout, il faut s'en donner un temporairement :

1. Ajouter localement, dans `src/api/routes.ts`, une route authentifiée (donc
   passant par `requireAccess()` comme les autres) qui appelle
   `reparse(c.env, rawKey, envelopeFrom)` avec des paramètres fournis par la
   requête ou codés en dur pour l'usage ponctuel.
2. Lancer `pnpm wrangler dev --remote` pour que ce Worker de développement
   local s'exécute contre les bindings D1/R2 **distants** réels (et non contre
   les simulations locales de Miniflare) — sans quoi le rejeu ne toucherait
   que des données locales éphémères.
3. Déclencher la route pour effectuer le rejeu.
4. Retirer la route ajoutée à l'étape 1 avant de committer ou de redéployer.

**Cette route ne doit jamais être déployée en production.** `reparse`
supprime puis réinsère une ligne de `messages` (et ajuste les compteurs du
thread concerné) : c'est une opération destructive exécutée sans confirmation
ni garde-fou particulier au-delà de l'authentification Access générique.
L'exposer durablement sur une application accessible depuis Internet mérite
son propre cycle de conception et de revue, pas un ajout de dernière minute.

**Limite connue de `reparse` elle-même** : si le message rejoué était le seul
message d'un thread, `storeIncoming` recrée un nouveau thread pour lui (le
threading se base sur le sujet normalisé et les en-têtes de référence au
moment du re-parsing, pas sur l'ancien `thread_id`) ; l'ancien thread,
désormais vide, reste orphelin en base plutôt que d'être supprimé. Ce cas doit
être nettoyé manuellement si besoin.

## Stockage du MIME brut

La clé R2 du MIME brut d'un message est adressée par contenu :
`raw/<sha256-du-contenu>.eml`. Elle n'est pas générée à partir de métadonnées
(ni horodatage, ni identifiant de message) : deux messages aux octets
identiques partagent la même clé. La ligne D1 correspondante (table
`messages`) est la seule adresse connue de cet objet R2 — il n'existe pas
d'index inverse ni de listing qui permette de retrouver un message à partir de
sa clé R2 sans passer par D1.

## Réconciliation R2 ↔ D1 (recherche d'orphelins)

L'invariant le plus fort du projet est « aucun message reçu n'est perdu » : le
MIME brut est écrit dans R2 **avant** tout parsing et toute écriture D1. Le
corollaire est qu'un échec ultérieur (insertion D1 refusée, base pas encore
migrée, bug d'ingestion) laisse un objet R2 sans ligne `messages` — et comme il
n'existe aucun index inverse (voir la section précédente), rien ne le signale.
Cette procédure est la seule façon de vérifier l'invariant en production. Elle
est manuelle et hors application : **aucune route d'administration n'est livrée,
et c'est délibéré** (une route qui liste ou rejoue du contenu de message mérite
son propre cycle de conception, pas un ajout de dernière minute).

**1. Extraire les clés connues de D1.**

```bash
pnpm wrangler d1 execute cloudmail --remote --json \
  --command "SELECT raw_key FROM messages ORDER BY raw_key" \
  | jq -r '.[0].results[].raw_key' | sort > d1-raw-keys.txt
```

**2. Lister le préfixe `raw/` dans R2.** Attention : `wrangler r2 object` ne sait
que `get`, `put` et `delete` — **il n'existe pas de sous-commande de listing**
(vérifié sur wrangler 4.x). Le listing passe donc par l'API S3-compatible de R2,
avec un jeton R2 « Object Read » (Access Key ID / Secret Access Key créés depuis
R2 → Manage API tokens) :

```bash
export AWS_ACCESS_KEY_ID=<access key id R2>
export AWS_SECRET_ACCESS_KEY=<secret access key R2>
export AWS_DEFAULT_REGION=auto

aws s3api list-objects-v2 \
  --endpoint-url "https://<CF_ACCOUNT_ID>.r2.cloudflarestorage.com" \
  --bucket cloudmail --prefix "raw/" \
  --query 'Contents[].Key' --output text \
  | tr '\t' '\n' | sort > r2-raw-keys.txt
```

(À défaut d'`aws`, `rclone lsf` sur un remote S3 pointant le même endpoint
produit la même liste ; l'explorateur d'objets du tableau de bord R2 permet de
parcourir le préfixe à l'œil, ce qui suffit sur un petit volume.)

**3. Comparer les deux listes.**

```bash
# Orphelins : objet R2 présent, aucune ligne D1 — le cas à traiter.
comm -23 r2-raw-keys.txt d1-raw-keys.txt

# Cas inverse : ligne D1 dont l'objet R2 a disparu (purge interrompue, cf.
# purgeMessage) — GET /api/messages/:id/raw répond 404 pour ces messages.
comm -13 r2-raw-keys.txt d1-raw-keys.txt
```

**4. Inspecter un orphelin**, pour décider s'il vaut la peine d'être réingéré :

```bash
pnpm wrangler r2 object get cloudmail/raw/<sha256>.eml --remote --file orphelin.eml
head -40 orphelin.eml   # From, To, Subject, Message-ID
```

**5. Réingérer.** `reparse(env, rawKey, envelopeFrom)` (section « Rejeu d'un
message » ci-dessus) relit exactement cet objet et rejoue l'ingestion complète ;
elle fonctionne aussi bien sur un orphelin — il n'y a alors simplement aucune
ligne D1 existante à supprimer au préalable. Le déclenchement se fait par la
route temporaire décrite dans cette même section, à retirer ensuite.

## Développement local

Copier `.dev.vars.example` vers `.dev.vars` (fichier ignoré par git) pour
lancer `pnpm dev` avec `DEV_BYPASS_AUTH=1`, qui désactive la vérification
Cloudflare Access en local. Voir les avertissements dans `.dev.vars.example` :
cette variable ne doit jamais être définie ailleurs qu'en local.
