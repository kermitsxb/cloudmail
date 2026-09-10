#!/usr/bin/env node
// Fabrique la configuration Wrangler de déploiement en appliquant vos valeurs
// personnelles (wrangler.overrides.json, ignoré par git) au fichier versionné
// (wrangler.jsonc, qui ne contient que des placeholders).
//
// Pourquoi ce détour plutôt qu'écrire ses valeurs dans wrangler.jsonc : le dépôt
// est destiné à être cloné, et une route ou un database_id désignent une
// installation précise. Les garder hors de git tout en laissant le fichier
// versionné structurellement valide permet aussi à `pnpm test` et `pnpm dev` de
// fonctionner sur un clone neuf, sans étape de préparation.
//
// Usage : node scripts/config.mjs [--check]
//   sans argument : écrit .wrangler/generated.jsonc
//   --check       : vérifie seulement, n'écrit rien

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { findPlaceholders, mergeConfig, resolveRelativePaths, stripJsonComments } from "./config-merge.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BASE = resolve(root, "wrangler.jsonc");
const OVERRIDES = resolve(root, "wrangler.overrides.json");
const OUT = resolve(root, ".wrangler/generated.jsonc");

const fail = (message) => {
  console.error(`\n✖ ${message}\n`);
  process.exit(1);
};

const readJson = async (path, label) => {
  let text;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return null;
  }
  try {
    return JSON.parse(stripJsonComments(text));
  } catch (err) {
    fail(`${label} est illisible : ${err.message}`);
  }
};

const base = await readJson(BASE, "wrangler.jsonc");
if (!base) fail("wrangler.jsonc est introuvable.");

const overrides = await readJson(OVERRIDES, "wrangler.overrides.json");
if (!overrides) {
  fail(
    `wrangler.overrides.json est introuvable.\n\n` +
      `  Ce fichier porte les valeurs propres à votre installation, et n'est pas\n` +
      `  versionné. Créez-le à la racine du dépôt sur ce modèle :\n\n` +
      `  {\n` +
      `    "routes": [{ "pattern": "mail.votredomaine.fr", "custom_domain": true }],\n` +
      `    "d1_databases": [{ "database_id": "<id affiché par wrangler d1 create>" }],\n` +
      `    "vars": { "MAIL_DOMAIN": "votredomaine.fr" }\n` +
      `  }\n\n` +
      `  Voir « Ne jamais versionner de valeur propre à votre installation »\n` +
      `  dans le README.`
  );
}

const merged = mergeConfig(base, overrides);

// Garde-fou principal : déployer avec un placeholder resté en place enverrait le
// Worker sur un domaine et une base qui ne vous appartiennent pas. On refuse
// avant d'écrire quoi que ce soit, en nommant chaque valeur à renseigner.
const remaining = findPlaceholders(merged);
if (remaining.length > 0) {
  fail(
    `${remaining.length} valeur(s) d'exemple non remplacée(s) — wrangler.overrides.json est incomplet :\n\n` +
      remaining.map((r) => `    ${r.path} = ${JSON.stringify(r.value)}`).join("\n") +
      `\n\n  Renseignez-les dans wrangler.overrides.json avant de déployer.`
  );
}

if (process.argv.includes("--check")) {
  console.log("✔ Configuration de déploiement complète.");
  process.exit(0);
}

// wrangler.jsonc écrit ses chemins relatifs à la racine du dépôt, mais
// generated.jsonc vit dans .wrangler/ : sans réécriture, wrangler les
// résoudrait depuis ce sous-dossier (ex. .wrangler/src/index.ts, introuvable).
const resolved = resolveRelativePaths(merged, (p) => resolve(root, p));

await mkdir(dirname(OUT), { recursive: true });
await writeFile(
  OUT,
  `// Fichier généré par scripts/config.mjs — ne pas éditer, ne pas versionner.\n` +
    `// Source : wrangler.jsonc + wrangler.overrides.json\n` +
    `${JSON.stringify(resolved, null, 2)}\n`,
  "utf8"
);
console.log(`✔ ${OUT.replace(`${root}/`, "")} écrit.`);
