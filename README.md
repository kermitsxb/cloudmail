# Cloudmail

Client webmail personnel, exécuté entièrement sur un Worker Cloudflare unique.
Chaque installation le configure avec son propre domaine et ses propres
identités d'envoi (voir « Mise en service » ci-dessous).

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

Les redirections sont gérées depuis l'application, pas depuis le tableau de bord
Cloudflare. Une règle de la table D1 `forward_rules` associe une adresse source
— une partie locale, ou `*` pour toutes les adresses du domaine — à une
destination vérifiée sur le compte Cloudflare. À la réception, `handleEmail`
(`src/email.ts`) applique **toutes** les règles qui correspondent au
destinataire, catch-all comprise, et dédoublonne les destinations identiques.
Le forward précède l'archivage, parce que `message.raw` est un `ReadableStream`
à usage unique ; les deux étapes sont isolées. Ce que cette isolation garantit
exactement : une **exception** levée par le forward ou par la lecture des règles
est rattrapée et n'empêche pas l'archivage, et un forward qui **bloque** est
abandonné au bout de dix secondes par destination (`FORWARD_TIMEOUT_MS` dans
`src/email.ts`) pour que l'archivage garde du temps d'exécution — sans cette
borne, un forward qui ne rend jamais la main laisserait le message sans objet R2
ni ligne D1, puisque rien n'est encore écrit à ce moment-là. Aucune de ces
situations n'appelle `setReject`. Cette séparation est ce qui permet
qu'un message arrive à la fois dans Cloudmail et dans une boîte externe :
Cloudflare Email Routing ne sait livrer qu'à un Worker **ou** à une adresse,
jamais aux deux.

## Prérequis Cloudflare

- Un domaine à vous (ex. `example.com`) doit être géré sur Cloudflare (zone DNS
  active). Les instructions ci-dessous utilisent `example.com` et le
  sous-domaine `mail.example.com` comme exemples : remplacez-les par votre
  propre domaine partout où ils apparaissent (`wrangler.jsonc`, tableau de bord
  Cloudflare).
- **`wrangler.jsonc` est versionné avec la configuration de l'instance de ce
  dépôt**, pas avec des placeholders : la route `mail.example.com`, le
  `database_id` de sa base D1 et son `MAIL_DOMAIN` sont des valeurs réelles.
  Rien de secret n'y figure (un `database_id` n'est pas un identifiant
  d'authentification, et les secrets vivent dans `wrangler secret`), mais aucune
  de ces valeurs ne vous concerne : remplacez les trois par les vôtres avant tout
  déploiement, sinon `wrangler deploy` réclamera une zone et une base que votre
  compte ne possède pas.
- Un plan **Workers Paid** est nécessaire pour utiliser Email Sending (l'API
  d'envoi utilisée par `src/send/client.ts`). Email Routing, utilisé pour la
  réception, est gratuit et ne nécessite pas ce plan.
- Cloudflare Access (Zero Trust) doit être disponible sur le compte pour protéger
  le sous-domaine choisi (`mail.example.com` dans les instructions).

## Commandes de développement

Telles que définies dans `package.json` :

- `pnpm dev` — lance en parallèle `pnpm wrangler dev` (le Worker, avec D1 et R2
  simulés localement par Miniflare) et `pnpm --filter web dev` (le serveur de dev
  Vite du SPA).
- `pnpm test` — exécute `vitest run` (247 tests côté Worker : ingestion, API,
  auth, envoi, redirections) puis `pnpm --filter web test` (51 tests côté SPA).
- `pnpm build` — construit uniquement le SPA (`pnpm --filter web build`), dont la
  sortie (`web/dist`) est servie par le Worker via le binding `ASSETS`.
- `pnpm run deploy` — enchaîne `pnpm build` puis `pnpm wrangler deploy` :
  reconstruit le SPA puis déploie le Worker (code + assets) sur Cloudflare. Le
  `run` n'est pas optionnel ici : dans un workspace pnpm, `deploy` est une
  commande native de pnpm, et `pnpm deploy` échoue donc avec
  `ERR_PNPM_NOTHING_TO_DEPLOY` sans jamais lancer le script.
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
`wrangler.jsonc`, à la place de celle qui y figure — celle de la base de
l'instance de ce dépôt, sur un autre compte que le vôtre :

```jsonc
"d1_databases": [
  {
    "binding": "DB",
    "database_name": "cloudmail",
    "database_id": "REMPLACER_PAR_VOTRE_ID",
    "migrations_dir": "migrations"
  }
]
```

Profiter du même passage pour remplacer la route `mail.example.com` par votre
propre sous-domaine, et `vars.MAIL_DOMAIN` par votre domaine (celui de l'étape
5). Si cette étape est oubliée, `wrangler deploy` échoue : votre compte n'a ni
cette zone ni cette base D1, et le Worker déployé n'aurait de toute façon pas de
base de données fonctionnelle. Ces valeurs ne servent qu'au distant : en local,
`wrangler dev` et les tests Vitest ne les lisent pas, Miniflare simulant D1 et R2
sans authentification Cloudflare — voir le commentaire dans `wrangler.jsonc`.

### 2. Appliquer les migrations en distant

```bash
pnpm wrangler d1 migrations apply cloudmail --remote
```

Cette étape applique **toutes** les migrations du dossier `migrations/` : les
tables (`identities`, `threads`, `messages`, ...) de `0001_initial.sql`, puis la
table `forward_rules` de `0002_forward_rules.sql`. Elle ne dépend que de l'étape
1 (base créée, `database_id` renseigné) : ni du Worker, ni d'Access, ni d'Email
Routing. Si elle est oubliée, toute requête D1 échoue avec « no such table » — y
compris celles du handler `email()`, dont l'échec est silencieux.

**Sur une installation déjà déployée, cette commande est à rejouer avant de
déployer cette version.** D1 n'applique que les migrations qu'il n'a pas encore
enregistrées, donc la rejouer sur une base à jour ne coûte rien ; l'omettre, en
revanche, ne casse rien de visible et c'est précisément le problème. Sans
`forward_rules`, `GET /api/forwarding/rules` répond 500 et la vue
« Redirections » affiche son message d'erreur au lieu de la liste, tandis que
chaque message entrant fait échouer la lecture des règles : `handleEmail` log
`forward_rules_failed` et archive normalement. Aucun courrier n'est donc perdu ni
rejeté, mais aucune redirection n'a lieu — la fonctionnalité est silencieusement
absente, et le reste jusqu'à ce que la migration soit appliquée.

### 3. Peupler la table `identities`

```bash
pnpm wrangler d1 execute cloudmail --remote --command \
  "INSERT INTO identities (address, display_name, is_default) VALUES ('vous@example.com', 'Votre Nom', 1)"
```

Remplacer `vous@example.com` et `Votre Nom` par l'adresse d'envoi et le nom
affiché souhaités, sur votre propre domaine.

Cette étape crée l'identité d'envoi par défaut ; elle a besoin des tables de
l'étape 2. Sans ligne dans `identities`, l'API n'a aucune adresse `From` à
proposer pour composer ou répondre à un message, et `POST /api/messages` refuse
tout envoi avec `unknown_sender`.

### 4. Premier déploiement (fait exister le Worker)

```bash
pnpm run deploy
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

Tableau de bord Cloudflare → Email → Email Service → Sending → ajouter votre
domaine (`example.com`) et publier les enregistrements DNS demandés
(SPF/DKIM). Attendre le statut « verified ».

Reporter ce même domaine dans `wrangler.jsonc`, section `vars` →
`MAIL_DOMAIN` (utilisé pour générer le `Message-ID` des emails envoyés, voir
`src/api/routes.ts`).

Cette étape produit l'autorisation d'envoyer des emails depuis votre domaine
via l'API Cloudflare Email Sending. Si elle est oubliée ou incomplète, tout
envoi via `src/send/client.ts` échoue (l'API Cloudflare rejette les messages
provenant d'un domaine non vérifié).

### 6. Activer Email Routing avec une règle catch-all

Tableau de bord Cloudflare → Email → Email Routing → activer, puis créer une
règle catch-all « Send to a Worker » pointant sur le Worker `cloudmail` (visible
dans la liste grâce au déploiement de l'étape 4).

Cette étape produit le déclenchement du handler `email()` (`src/email.ts`) pour
tout message reçu sur `*@votre-domaine`. Si elle est oubliée, aucun message
entrant n'atteint jamais Cloudmail : Cloudflare les rejette ou les jette selon
la configuration DNS MX en place.

C'est la première étape à partir de laquelle du courrier réel peut arriver :
elle exige donc que tout ce dont l'ingestion a besoin existe déjà — le Worker
déployé (étape 4), le bucket R2 (étape 1) et surtout les tables D1 (étape 2).
C'est la raison de la position de cette étape dans la séquence.

**Attention aux règles littérales déjà en place — mais ne les supprimez pas
maintenant.** Une règle Email Routing sur une adresse précise passe **avant** le
catch-all : tant qu'elle existe, le Worker ne voit jamais cette adresse, et
Cloudmail n'en archive rien. Si le domaine porte déjà des règles de forwarding
(par exemple `contact@` vers une boîte Gmail), c'est bien au Worker de reprendre
leur forward, en plus de l'archivage — mais il n'en est pas encore capable. À
cette étape, l'interface « Redirections » est injoignable et inutilisable :
l'application Access n'existe pas (étape 7), le secret `CF_ROUTING_TOKEN` n'est
pas posé (étape 9) et le Worker n'a pas été redéployé avec ces valeurs (étape
10), si bien que le formulaire ne peut lister aucune destination vérifiée et
qu'aucune règle ne peut être créée. Supprimer les règles littérales ici ouvrirait
donc une fenêtre allant jusqu'à l'étape 10 pendant laquelle tout est archivé mais
**rien n'est redirigé** vers la boîte externe — exactement la régression que les
redirections gérées depuis Cloudmail existent pour éviter. La bascule se fait en
dernier : voir « Reprendre les redirections » à la fin de l'étape 10.

Recréer une redirection **catch-all** vers une boîte externe plutôt que des
règles nominatives forwarde aussi tout le courrier adressé à des adresses
inexistantes, que Cloudflare drope aujourd'hui. Le choix est laissé à
l'utilisateur ; les règles nominatives sont recommandées.

### 7. Créer l'application Cloudflare Access

Zero Trust → Access → Applications → Self-hosted, domaine `mail.example.com`
(le sous-domaine choisi à l'étape « Prérequis Cloudflare »), politique
« Emails » limitée à votre propre adresse (celle avec laquelle vous vous
connecterez). Copier ensuite l'Application Audience (AUD) et le team domain
dans `wrangler.jsonc`, section `vars` :

```jsonc
"vars": {
  "ACCESS_TEAM_DOMAIN": "<team>.cloudflareaccess.com",
  "ACCESS_AUD": "<AUD copié depuis l'application Access>",
  "ALLOWED_EMAILS": "vous@example.com",
  "MAIL_DOMAIN": "example.com"
}
```

Cette étape produit la protection d'accès de `mail.example.com` : sans jeton
Access valide, `src/auth/access.ts` (`requireAccess()`) rejette toute requête
API avec `401 unauthenticated`. Si `ACCESS_TEAM_DOMAIN` ou `ACCESS_AUD` sont
laissés vides (leur valeur par défaut dans `wrangler.jsonc`), la vérification
JWT échoue systématiquement et personne — pas même l'utilisateur légitime — ne
peut se connecter. (Ces valeurs ne seront effectivement appliquées qu'au
déploiement final, étape 10.)

### 8. Créer les tokens API

Deux tokens distincts, chacun avec une seule permission :

- **Envoi** — permission « Email Sending: Send » uniquement. Utilisé par
  `src/send/client.ts` pour appeler
  `POST /accounts/{account_id}/email/sending/send`.
- **Routage** — permission « Email Routing: Read » uniquement. Utilisé par
  `src/forwarding/destinations.ts` pour lister les destinations vérifiées que
  l'interface propose dans le formulaire de redirection.

Les séparer garde le moindre privilège : une fuite du token d'envoi ne donne pas
accès à la configuration de routage, et réciproquement. Un token trop permissif
serait un risque inutile ; un token absent ou mal scopé fait échouer l'opération
correspondante avec une erreur d'autorisation Cloudflare.

### 9. Poser les secrets

```bash
pnpm wrangler secret put CF_ACCOUNT_ID
pnpm wrangler secret put CF_API_TOKEN
pnpm wrangler secret put CF_ROUTING_TOKEN
```

Ces trois commandes produisent les secrets chiffrés lus par le Worker :
`CF_ACCOUNT_ID` et `CF_API_TOKEN` par `src/send/client.ts` (envoi),
`CF_ROUTING_TOKEN` par `src/forwarding/destinations.ts` (lecture des
destinations vérifiées). Sans les deux premiers, toute tentative de réponse ou
d'envoi échoue immédiatement ; sans le troisième, le formulaire de redirection
répond « Impossible de lire les destinations vérifiées » et aucune règle ne peut
être créée. Elles s'appliquent au Worker, qui doit donc déjà exister (étape 4).

### 10. Déploiement final

```bash
pnpm run deploy
```

Second et dernier déploiement : cette fois le Worker part avec les secrets
d'envoi posés (étape 9), les variables `ACCESS_TEAM_DOMAIN`/`ACCESS_AUD`
renseignées (étape 7) et une base D1 migrée et peuplée (étapes 2-3). C'est
cette exécution qui rend le service effectivement utilisable en production ;
tant qu'elle n'a pas eu lieu après les étapes précédentes, l'authentification
Access et l'envoi d'email restent non fonctionnels malgré un Worker déjà en
ligne depuis l'étape 4.

**Reprendre les redirections (en dernier).** C'est seulement maintenant que
l'interface « Redirections » est joignable et capable de lister les destinations
vérifiées du compte, donc seulement maintenant que les règles de forwarding
littérales évoquées à l'étape 6 peuvent être retirées d'Email Routing. Dans cet
ordre, et pas l'inverse : créer d'abord dans Cloudmail la redirection équivalente
à chaque règle littérale (`contact@` vers la même boîte externe, par exemple),
puis supprimer les règles littérales du tableau de bord. Tant qu'une règle
littérale existe, elle continue de livrer à la boîte externe et le Worker ne voit
pas l'adresse : la redirection Cloudmail créée en doublon reste simplement sans
effet, et prend le relais à la seconde où la règle littérale disparaît. Aucune
fenêtre sans redirection ne s'ouvre. Un message de test envoyé à l'adresse
concernée après la bascule doit arriver **à la fois** dans Cloudmail et dans la
boîte externe ; s'il n'arrive que dans Cloudmail, la règle correspondante est
absente ou désactivée, et la ligne de l'interface affiche l'erreur de la dernière
tentative.

## Rejeu d'un message (`reparse`)

`src/email.ts` exporte `reparse(env, rawKey, envelopeFrom)`, qui relit le MIME
brut déjà stocké dans R2 (clé `rawKey`), le re-parse, supprime la ligne D1
existante correspondante (en décrémentant au passage les compteurs du thread
d'origine) puis rappelle `storeIncoming` comme si le message venait d'arriver.
C'est la fonction à utiliser pour rejouer un message après un correctif du
parseur, sans avoir à faire renvoyer l'email par l'expéditeur d'origine.

**`reparse` ne rejoue pas les redirections.** Elle rejoue l'ingestion d'un
message déjà stocké ; re-forwarder à cette occasion enverrait un doublon aux
destinataires externes, qui ont déjà reçu leur copie lors de la réception
initiale. Un rejeu corrige donc la ligne D1 et le contenu indexé, jamais ce qui
est déjà parti.

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
