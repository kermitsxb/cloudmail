# Cloudmail — instructions projet

## Ne jamais committer de valeur propre à une installation

Ce dépôt est open source et destiné à être cloné puis déployé par d'autres
personnes. Une valeur qui décrit **une** installation n'y a donc pas sa place,
même lorsqu'elle n'est pas secrète : elle force chaque personne qui reprend le
projet à deviner ce qui est un exemple et ce qui est la configuration de
quelqu'un d'autre, et elle finit par être déployée par erreur.

Le critère n'est pas « est-ce confidentiel ? » mais **« est-ce que la valeur
change d'une installation à l'autre ? »**. Un team domain Cloudflare Access et
un AUD d'application sont publics — Cloudflare les sert à tout visiteur anonyme
dans la redirection vers la page de connexion — et ils ne doivent pourtant pas
être versionnés, parce qu'ils désignent une installation précise.

Sont concernés, sans être exhaustif :

- adresses email, noms de domaine, sous-domaines
- identifiants de compte, de base D1, de bucket R2, de zone DNS
- team domain et Application Audience (AUD) Cloudflare Access
- jetons d'API, clés, mots de passe — évidemment, mais ce sont les cas faciles

**Où les mettre à la place.** Toute valeur lue par le Worker via `env` se pose
en secret, qui ne transite jamais par git :

```bash
pnpm wrangler secret put NOM_DE_LA_VARIABLE
```

En développement local, `.dev.vars` (ignoré par git) les fournit ; `.dev.vars.example`
documente lesquelles sont attendues, avec des valeurs vides ou d'exemple.

**Si le code lit une valeur qui peut manquer**, il doit refuser explicitement en
nommant ce qui n'est pas posé, et non planter. Voir `requireAccessConfig()` dans
`src/auth/access.ts` : un secret absent donne un refus d'authentification dont le
message désigne la variable, plutôt qu'un `TypeError` remonté en « 500 Erreur
interne » qui fait chercher un bug là où il n'y a qu'une configuration
incomplète.

**Dans les tests et la documentation**, utiliser des valeurs d'exemple neutres
(`vous@example.com`, `example.com`) et jamais une adresse ou un domaine réel.

## Deux suites de tests, à ne pas mélanger

- `pnpm vitest run` à la racine : le Worker, dans le runtime Workers (Miniflare
  fournit D1 et R2). 18 fichiers.
- `pnpm --filter web test` : le SPA, en jsdom. 7 fichiers.

`pnpm test` enchaîne les deux. `pnpm typecheck` ne couvre que le Worker :
seul `pnpm build` typecheck le SPA (`tsc -b`), donc une erreur de typage dans
`web/` ne se voit qu'au build.

## Configuration de déploiement

`wrangler.jsonc` est versionné avec des **placeholders structurellement valides**
(`mail.example.com`, `"local"`, `example.com`), ce qui permet à `pnpm test` et
`pnpm dev` de fonctionner sur un clone neuf sans préparation. Les valeurs réelles
vivent dans `wrangler.overrides.json` (ignoré par git) et sont fusionnées par
`scripts/config.mjs` vers `.wrangler/generated.jsonc`, utilisé par les commandes
distantes via `-c`.

Ne jamais écrire de valeur réelle dans `wrangler.jsonc`. Toute commande Wrangler
qui touche le distant (`deploy`, `d1 ... --remote`) doit passer par
`.wrangler/generated.jsonc`, sinon elle viserait le `database_id` placeholder.
La logique pure de fusion vit dans `scripts/config-merge.mjs` et est testée dans
`test/scripts/config-merge.test.ts` ; `scripts/config.mjs` n'en est que la
coquille d'entrée/sortie.

## Déploiement

`pnpm run deploy`, et non `pnpm deploy` : dans un workspace pnpm, `deploy` est
une commande native de pnpm qui masque le script et échoue avec
`ERR_PNPM_NOTHING_TO_DEPLOY` sans rien lancer.

## Invariant du handler `email()`

`src/email.ts` ne doit jamais appeler `setReject()` — un rejet renverrait un
bounce à l'expéditeur. Un échec de redirection ne doit jamais empêcher
l'archivage, et le forward précède la lecture de `message.raw`, qui est un
`ReadableStream` à usage unique. Voir le paragraphe « Architecture » du README.
