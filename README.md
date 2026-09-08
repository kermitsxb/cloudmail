# Cloudmail

Client webmail personnel pour `thomas@example.com`, exécuté entièrement sur un
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

- Le domaine `example.com` doit être géré sur Cloudflare (zone DNS active).
- Un plan **Workers Paid** est nécessaire pour utiliser Email Sending (l'API
  d'envoi utilisée par `src/send/client.ts`). Email Routing, utilisé pour la
  réception, est gratuit et ne nécessite pas ce plan.
- Cloudflare Access (Zero Trust) doit être disponible sur le compte pour protéger
  `mail.example.com`.

## Commandes de développement

Telles que définies dans `package.json` :

- `pnpm dev` — lance en parallèle `pnpm wrangler dev` (le Worker, avec D1 et R2
  simulés localement par Miniflare) et `pnpm --filter web dev` (le serveur de dev
  Vite du SPA).
- `pnpm test` — exécute `vitest run` (176 tests côté Worker : ingestion, API,
  auth, envoi) puis `pnpm --filter web test` (18 tests côté SPA).
- `pnpm build` — construit uniquement le SPA (`pnpm --filter web build`), dont la
  sortie (`web/dist`) est servie par le Worker via le binding `ASSETS`.
- `pnpm deploy` — enchaîne `pnpm build` puis `pnpm wrangler deploy` : reconstruit
  le SPA puis déploie le Worker (code + assets) sur Cloudflare.
- `pnpm typecheck` — `tsc --noEmit`, non demandé par le brief mais utile en
  local.

## Mise en service

Ces étapes touchent le compte Cloudflare payant de l'utilisateur et rendent le
service public : elles ne sont **pas** automatisées et doivent être exécutées à
la main, dans l'ordre, par la personne qui opère le compte.

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

### 2. Premier déploiement (fait exister le Worker)

```bash
pnpm deploy
```

Ce premier déploiement n'a qu'un but : faire exister le Worker `cloudmail` sur
le compte Cloudflare. Il est nécessaire ici, avant même la configuration
d'Access et des secrets d'envoi, parce que l'étape 4 (Email Routing) doit
choisir ce Worker dans une liste déroulante du tableau de bord — et cette
liste ne propose que des Workers déjà déployés. Sans ce premier déploiement,
l'étape 4 est une impasse : la liste est vide et il n'y a rien à sélectionner.

À ce stade, le Worker déployé est incomplet (secrets d'envoi absents,
`ACCESS_TEAM_DOMAIN`/`ACCESS_AUD` encore vides) : c'est normal, aucun trafic
réel n'est encore attendu. Un second déploiement, final, aura lieu à l'étape 10
une fois toute la configuration en place.

### 3. Vérifier le domaine dans Email Service

Tableau de bord Cloudflare → Email → Email Service → Sending → ajouter
`example.com` et publier les enregistrements DNS demandés (SPF/DKIM). Attendre
le statut « verified ».

Cette étape produit l'autorisation d'envoyer des emails depuis `example.com`
via l'API Cloudflare Email Sending. Si elle est oubliée ou incomplète, tout
envoi via `src/send/client.ts` échoue (l'API Cloudflare rejette les messages
provenant d'un domaine non vérifié).

### 4. Activer Email Routing avec une règle catch-all

Tableau de bord Cloudflare → Email → Email Routing → activer, puis créer une
règle catch-all « Send to a Worker » pointant sur le Worker `cloudmail` (visible
dans la liste grâce au déploiement de l'étape 2).

Cette étape produit le déclenchement du handler `email()` (`src/email.ts`) pour
tout message reçu sur `*@example.com`. Si elle est oubliée, aucun message
entrant n'atteint jamais Cloudmail : Cloudflare les rejette ou les jette selon
la configuration DNS MX en place.

### 5. Créer l'application Cloudflare Access

Zero Trust → Access → Applications → Self-hosted, domaine `mail.example.com`,
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

Cette étape produit la protection d'accès de `mail.example.com` : sans jeton
Access valide, `src/auth/access.ts` (`requireAccess()`) rejette toute requête
API avec `401 unauthenticated`. Si `ACCESS_TEAM_DOMAIN` ou `ACCESS_AUD` sont
laissés vides (leur valeur par défaut dans `wrangler.jsonc`), la vérification
JWT échoue systématiquement et personne — pas même l'utilisateur légitime — ne
peut se connecter. (Ces valeurs ne seront effectivement appliquées qu'au
second déploiement, étape 10.)

### 6. Créer un token API restreint à l'envoi d'emails

Tableau de bord Cloudflare → créer un token API avec la seule permission
« Email Sending: Send » (aucune autre permission — ce token ne doit pas pouvoir
gérer le compte, les zones DNS, D1 ou R2).

Cette étape produit le jeton utilisé par `src/send/client.ts` pour appeler
`POST /accounts/{account_id}/email/sending/send`. Un token trop permissif serait
un risque inutile en cas de fuite ; un token absent ou mal scopé fait échouer
tout envoi avec une erreur d'autorisation Cloudflare.

### 7. Poser les secrets

```bash
pnpm wrangler secret put CF_ACCOUNT_ID
pnpm wrangler secret put CF_API_TOKEN
```

Ces deux commandes produisent les secrets chiffrés lus par `src/send/client.ts`
via `env.CF_ACCOUNT_ID` et `env.CF_API_TOKEN`. Sans eux, toute tentative de
réponse ou d'envoi échoue immédiatement au moment de l'appel à l'API Cloudflare.

### 8. Appliquer les migrations en distant

```bash
pnpm wrangler d1 migrations apply cloudmail --remote
```

Cette étape crée les tables (`identities`, `threads`, `messages`, ...) définies
dans `migrations/0001_initial.sql` sur la base D1 distante. Si elle est
oubliée, la première requête du Worker déployé contre D1 échoue avec une erreur
« no such table ».

### 9. Peupler la table `identities`

```bash
pnpm wrangler d1 execute cloudmail --remote --command \
  "INSERT INTO identities (address, display_name, is_default) VALUES ('thomas@example.com', 'Thomas Stocker', 1)"
```

Cette étape crée l'identité d'envoi par défaut. Sans ligne dans `identities`,
l'API n'a aucune adresse `From` à proposer pour composer ou répondre à un
message.

### 10. Déploiement final

```bash
pnpm deploy
```

Second et dernier déploiement : cette fois le Worker part avec les secrets
d'envoi posés (étape 7), les variables `ACCESS_TEAM_DOMAIN`/`ACCESS_AUD`
renseignées (étape 5) et une base D1 migrée et peuplée (étapes 8-9). C'est
cette exécution qui rend le service effectivement utilisable en production ;
tant qu'elle n'a pas eu lieu après les étapes précédentes, l'authentification
Access et l'envoi d'email restent non fonctionnels malgré un Worker déjà en
ligne depuis l'étape 2.

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

## Développement local

Copier `.dev.vars.example` vers `.dev.vars` (fichier ignoré par git) pour
lancer `pnpm dev` avec `DEV_BYPASS_AUTH=1`, qui désactive la vérification
Cloudflare Access en local. Voir les avertissements dans `.dev.vars.example` :
cette variable ne doit jamais être définie ailleurs qu'en local.
