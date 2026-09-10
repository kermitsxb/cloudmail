# Redirections gérées depuis Cloudmail — design

> Statut : validé le 2026-09-09, prêt pour le plan d'implémentation.

## Problème

Le courrier entrant sur le domaine doit arriver **à la fois** dans Cloudmail et
dans une boîte externe (Gmail dans le cas qui motive ce travail), et l'ensemble
doit se piloter depuis l'application plutôt que depuis le tableau de bord
Cloudflare.

Cloudflare ne sait pas faire la double livraison en configuration. La
documentation Email Routing est explicite : *« Routing rules map email patterns
to a single destination **or** a Worker. To forward to multiple destinations, a
Worker must be used to call the forward function for each destination. »* Une
règle livre au Worker **ou** forwarde, jamais les deux. La double livraison doit
donc être exécutée par le Worker, via `message.forward()`.

C'est ce qui justifie une brique dédiée plutôt qu'une variable d'environnement :
puisque le Worker doit de toute façon porter la logique de redirection, autant
qu'elle soit lisible et modifiable sans redéploiement.

## Décisions structurantes

Ces quatre choix ont été arbitrés avec l'utilisateur avant rédaction. Ils sont
consignés ici parce qu'ils ferment chacun une alternative crédible, et que
l'implémentation n'a pas à les rouvrir.

### Les règles vivent dans Cloudmail, pas dans Cloudflare

La table D1 `forward_rules` est la source de vérité, et le Worker l'applique.
Côté Cloudflare, une seule règle subsiste : le catch-all vers le Worker.

L'alternative — faire de Cloudmail un front pour l'API Email Routing — a été
écartée parce qu'elle est contradictoire avec l'objectif : une adresse redirigée
par une règle Cloudflare **ne passe pas** par le Worker, et n'est donc jamais
archivée dans Cloudmail. On ne peut pas à la fois déléguer la redirection à
Cloudflare et prétendre tout archiver.

La variante « D1 source de vérité, synchronisée vers l'API Cloudflare » a été
écartée pour son coût : elle introduit un problème de réconciliation (que faire
quand quelqu'un édite une règle depuis le tableau de bord ?) sans rien apporter
au besoin.

Conséquence assumée : **Cloudmail devient un point de passage obligé** pour tout
le courrier du domaine. Si le Worker est indisponible, Cloudflare met le message
en file d'attente selon sa propre politique de retry ; rien dans ce design ne
contourne le Worker.

### Sémantique cumulative

Toutes les règles qui correspondent à une adresse s'appliquent. Un message vers
`thomas@` déclenche la règle `thomas@` **et** la règle catch-all.

C'est un écart délibéré avec la sémantique de Cloudflare Email Routing, où la
règle spécifique masque le catch-all. La sémantique de Cloudflare rend
inexprimable « tout vers X, et en plus `thomas@` vers Y » sans dupliquer X dans
chaque règle nominative. La règle mentale devient : **une règle qui matche = une
copie envoyée**, les destinations identiques étant dédoublonnées.

### Destinations choisies dans une liste, jamais saisies librement

`message.forward()` n'accepte qu'une **destination vérifiée** sur le compte
Cloudflare — une adresse ajoutée puis confirmée par clic sur un lien reçu par
mail. Une destination non vérifiée fait échouer le forward, sans que
l'expéditeur ni le destinataire n'en sachent rien.

L'interface interroge donc l'API Cloudflare et ne propose que les destinations
déjà vérifiées. Une faute de frappe dans une adresse devient impossible par
construction.

L'ajout d'une destination reste **hors de Cloudmail** : l'interface renvoie vers
le tableau de bord Cloudflare. Cela garde le token de lecture seule (voir plus
bas) et évite d'avoir à représenter l'état intermédiaire « en attente de
vérification » dans l'UI.

### Source : partie locale libre, ou toutes les adresses

On saisit une partie locale (`contact`, `factures`, `devis`…) à laquelle
l'interface accole le domaine, ou on coche « toutes les adresses du domaine ».

La source n'est pas choisie parmi les `identities` : cette table sert aux
adresses d'**envoi**, et confondre les deux notions obligerait à déclarer une
identité d'envoi pour pouvoir rediriger une adresse qui ne sert qu'à recevoir.
Le catch-all du Worker reçoit de toute façon l'intégralité du domaine, y compris
des adresses déclarées nulle part.

## Deux arbitrages techniques

### Le forward précède l'archivage

`message.raw` est un `ReadableStream` à usage unique. Plutôt que de parier sur
son état après consommation par `storeIncoming`, le forward est exécuté en
premier.

Les deux étapes sont **mutuellement isolées**, chacune dans son propre
`try`/`catch` :

- un échec du forward n'empêche pas l'archivage ;
- un échec de la lecture des règles n'empêche pas l'archivage ;
- un échec de l'archivage ne prive pas les destinations de leur copie.

`setReject` n'est toujours jamais appelé : un rejet renverrait un bounce à
l'expéditeur. L'invariant « aucun message reçu n'est perdu » est préservé — le
MIME brut continue d'être écrit dans R2 avant toute écriture D1.

### Un second token, en lecture seule

Le README impose délibérément à `CF_API_TOKEN` la **seule** permission « Email
Sending: Send ». Lire les destinations vérifiées demande « Email Routing: Read ».

Plutôt que d'élargir le token d'envoi, on ajoute un second secret
`CF_ROUTING_TOKEN` portant uniquement « Email Routing: Read ». Le moindre
privilège est conservé : une fuite du token d'envoi ne donne pas accès à la
configuration de routage, et réciproquement.

## Schéma

Nouvelle migration `migrations/0002_forward_rules.sql` :

```sql
CREATE TABLE forward_rules (
  id INTEGER PRIMARY KEY,
  -- Partie locale de l'adresse source, ou '*' pour « toutes les adresses ».
  match_local TEXT NOT NULL,
  destination TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  -- Résultat de la dernière tentative de forward pour cette règle. Utile même
  -- avec une saisie par liste déroulante : une destination peut être supprimée
  -- ou dé-vérifiée côté Cloudflare après la création de la règle.
  last_attempt_at INTEGER,
  last_status TEXT CHECK (last_status IN ('ok','error')),
  last_error TEXT
);

CREATE UNIQUE INDEX idx_forward_rules_pair ON forward_rules(match_local, destination);
CREATE INDEX idx_forward_rules_match ON forward_rules(match_local) WHERE enabled = 1;
```

`'*'` est une valeur sentinelle, pas `NULL` : en SQLite deux `NULL` sont
considérés distincts, donc un index unique sur une colonne nullable laisserait
créer deux fois la même règle catch-all vers la même destination. `'*'` n'étant
pas une partie locale valide, la collision avec une vraie adresse est impossible.

Le schéma ne référence aucun domaine : `MAIL_DOMAIN` reste la seule source du
domaine, et n'est pas dupliqué en base.

## Moteur de redirection

Nouveau module `src/forwarding/rules.ts` :

```ts
// Renvoie les destinations distinctes à servir pour une adresse donnée.
export async function matchingDestinations(db: D1Database, to: string): Promise<Match[]>

// Enregistre en un seul batch le résultat des tentatives.
export async function recordAttempts(db: D1Database, results: AttemptResult[]): Promise<void>
```

`matchingDestinations` extrait la partie locale de `to`, la met en minuscules, et
sélectionne les règles activées dont `match_local` vaut cette partie locale ou
`'*'`. Les destinations identiques sont dédoublonnées : deux règles pointant vers
la même adresse n'envoient qu'une copie, tout en conservant chacune leur propre
statut.

`src/email.ts` devient :

```
handleEmail(message, env):
  try:
    matches = matchingDestinations(env.DB, message.to)
    pour chaque destination distincte :
      try    await message.forward(destination)   → statut ok
      catch  → statut error + message d'erreur
    recordAttempts(env.DB, résultats)             # un seul batch
  catch:
    log { event: "forward_failed" }               # n'interrompt pas la suite

  try:
    raw → storeIncoming(...)                      # comportement actuel, inchangé
  catch:
    log { event: "email_failed" }                 # setReject jamais appelé
```

`reparse()` n'est pas modifiée et **ne rejoue pas les redirections** : elle rejoue
l'ingestion d'un message déjà stocké, et re-forwarder à cette occasion enverrait
un doublon aux destinataires externes. Ce point est documenté dans le README.

## API

Toutes les routes sont sous `/api/*`, donc déjà couvertes par `requireAccess()`
via `app.use("/api/*")` dans `src/index.ts`. Elles respectent le contrat d'erreur
existant `{ error: { code, message } }`.

| Route | Rôle |
|---|---|
| `GET /api/forwarding/rules` | Liste les règles avec leur statut de dernière tentative |
| `POST /api/forwarding/rules` | Crée une règle `{ matchLocal, destination }` |
| `PATCH /api/forwarding/rules/:id` | `{ enabled }` — désactiver sans supprimer |
| `DELETE /api/forwarding/rules/:id` | Supprime une règle |
| `GET /api/forwarding/destinations` | Destinations vérifiées du compte Cloudflare |
| `GET /api/config` | `{ mailDomain }` — le SPA ne code pas le domaine en dur |

Validation zod à la création :

- `matchLocal` : soit `'*'`, soit une partie locale (`^[a-z0-9._%+-]+$`, ≤ 64
  caractères), normalisée en minuscules ;
- `destination` : adresse email, **et** présente dans la liste des destinations
  vérifiées. La validation côté serveur ne fait pas confiance au fait que l'UI
  propose une liste fermée ;
- doublon `(matchLocal, destination)` → `409 duplicate_rule`.

`GET /api/forwarding/destinations` appelle
`GET /accounts/{CF_ACCOUNT_ID}/email/routing/addresses` avec `CF_ROUTING_TOKEN`,
et ne renvoie que les entrées dont le champ `verified` est renseigné. Si le
secret est absent ou refusé, la route répond `503 routing_unavailable` avec un
message explicite plutôt qu'une liste vide — une liste vide serait indiscernable
d'un compte sans destination.

## Interface

Nouvelle entrée « Redirections » dans `web/src/components/Sidebar.tsx`, qui
bascule `App.tsx` vers une vue de réglages. Nouveau composant
`web/src/components/ForwardingSettings.tsx`, construit sur les primitives `ui/`
existantes (`dialog`, `input`, `button`, `badge`).

**Liste** — une ligne par règle : source (`contact@example.com` ou « Toutes les
adresses »), destination, interrupteur d'activation, suppression, et un badge de
statut lorsque la dernière tentative a échoué, portant l'erreur Cloudflare et sa
date.

**Création** — dialogue reprenant la maquette validée :

```
Nouvelle redirection

  ◉ Une adresse
     [ contact        ]@example.com
  ○ Toutes les adresses du domaine

  Vers  [ ── choisir ──            ▾ ]
         ✓ vous@example.com
         ✓ archive@exemple.com
```

**État vide des destinations** — quand le compte n'a aucune destination vérifiée,
le `<select>` est remplacé par le renvoi vers le tableau de bord :

```
  Pour ajouter une destination, passez
  par le dashboard Cloudflare ↗
  puis cliquez le lien de confirmation
  reçu par mail.
```

Le domaine affiché à droite du champ de partie locale vient de `MAIL_DOMAIN`,
lu via la nouvelle route `GET /api/config`. Aucune route n'exposait jusqu'ici la
configuration du Worker au SPA, et coder `example.com` en dur dans le front
casserait la neutralité du dépôt vis-à-vis des autres installations.

## Tests

Côté Worker (`vitest` + `@cloudflare/vitest-plugin`) :

- correspondance sur adresse exacte, sur catch-all, et cumul des deux ;
- dédoublonnage des destinations identiques ;
- règles désactivées ignorées ;
- isolation : `forward()` qui lève → le message est **quand même** archivé ;
- isolation : lecture des règles qui lève → le message est **quand même** archivé ;
- isolation : `storeIncoming` qui lève → le forward a **quand même** eu lieu ;
- `setReject` jamais appelé, dans tous les cas d'échec ci-dessus ;
- écriture du statut d'erreur sur la bonne règle ;
- validation zod des routes, rejet du doublon, rejet d'une destination non vérifiée ;
- `GET /api/forwarding/destinations` : filtre les non-vérifiées, répond `503`
  quand le token manque.

Le faux message de `test/email-handler.test.ts` porte déjà un `forward: vi.fn()`,
directement exploitable.

Côté SPA (`vitest` + Testing Library) : rendu de la liste, création via le
dialogue, suppression, bascule d'activation, état vide des destinations.

## Conséquences côté Cloudflare

Le domaine porte aujourd'hui quatre règles littérales (`thomas@`, `contact@`,
`privacy@`, `developers@`) qui forwardent vers une boîte Gmail, et un catch-all
désactivé en `drop`.

Les règles spécifiques passent **avant** le catch-all. Tant qu'elles existent, le
Worker ne verra jamais ces quatre adresses, et Cloudmail n'archivera rien de ce
qui compte. La mise en service suppose donc de :

1. supprimer les quatre règles littérales ;
2. pointer le catch-all sur le Worker `cloudmail` et l'activer ;
3. recréer les quatre redirections dans Cloudmail.

⚠️ Recréer une **règle catch-all** vers Gmail plutôt que quatre règles nominatives
forwarderait aussi tout le courrier adressé à des adresses inexistantes — que
Cloudflare drope aujourd'hui. L'interface laisse le choix ; la recommandation est
de recréer les quatre règles nominatives.

## Hors périmètre

- Ajout et vérification d'une destination depuis Cloudmail (renvoi au tableau de
  bord Cloudflare).
- Redirections conditionnelles sur autre chose que l'adresse destinataire
  (expéditeur, sujet, en-têtes).
- Règle capable de supprimer l'archivage : Cloudmail archive **toujours** ce qui
  lui parvient, c'est le socle de l'invariant « aucun message reçu n'est perdu ».
- Réplication des règles vers l'API Cloudflare Email Routing.
- Rejeu des redirections par `reparse()`.
