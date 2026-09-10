// Logique pure de fabrication de la configuration de déploiement, séparée de
// tout accès disque pour être testable : scripts/config.mjs en est la coquille
// d'entrée/sortie. Voir « Ne jamais versionner de valeur propre à votre
// installation » dans le README.

// Valeurs sentinelles du wrangler.jsonc versionné. Leur présence dans la
// configuration fusionnée signifie qu'un override manque : déployer là-dessus
// enverrait le Worker sur un domaine et une base qui ne sont pas les vôtres —
// l'échec le plus coûteux que ce mécanisme puisse produire, donc celui qu'on
// refuse le plus tôt possible.
export const PLACEHOLDER_VALUES = ["example.com", "mail.example.com", "local"];

// Clés dont la valeur ressemble à un placeholder sans en être un.
const IGNORED_KEYS = new Set(["$schema"]);

// JSONC → JSON. Un simple remplacement par expression régulière casserait sur
// une chaîne contenant `//` (une URL) ou `/*` (un glob) : on parcourt donc le
// texte caractère par caractère en suivant l'état « dans une chaîne », et en
// tenant compte des échappements.
export function stripJsonComments(text) {
  let out = "";
  let inString = false;
  let inLine = false;
  let inBlock = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const next = text[i + 1];

    if (inLine) {
      if (c === "\n") {
        inLine = false;
        out += c;
      }
      continue;
    }
    if (inBlock) {
      if (c === "*" && next === "/") {
        inBlock = false;
        i++;
      }
      continue;
    }
    if (inString) {
      out += c;
      // Un antislash consomme le caractère suivant : sans ça, \" fermerait la
      // chaîne à tort et la suite du fichier serait lue comme du code.
      if (c === "\\") {
        out += text[++i] ?? "";
      } else if (c === '"') {
        inString = false;
      }
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      continue;
    }
    if (c === "/" && next === "/") {
      inLine = true;
      i++;
      continue;
    }
    if (c === "/" && next === "*") {
      inBlock = true;
      i++;
      continue;
    }
    out += c;
  }

  // Virgules finales, tolérées par JSONC et refusées par JSON.parse.
  return out.replace(/,(\s*[}\]])/g, "$1");
}

const isPlainObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);

// Fusion profonde. Les tableaux sont fusionnés **par position** et non
// remplacés : un override qui ne porte que `database_id` doit laisser en place
// le binding, le nom de base et le dossier de migrations décrits par le fichier
// versionné, sinon le déploiement perdrait le binding D1.
export function mergeConfig(base, overrides) {
  if (Array.isArray(overrides)) {
    const from = Array.isArray(base) ? base : [];
    return overrides.map((item, i) =>
      isPlainObject(item) && isPlainObject(from[i]) ? mergeConfig(from[i], item) : item
    );
  }
  if (!isPlainObject(overrides)) return overrides;

  const out = isPlainObject(base) ? { ...base } : {};
  for (const [key, value] of Object.entries(overrides)) {
    out[key] = key in out ? mergeConfig(out[key], value) : value;
  }
  return out;
}

// Chemins des valeurs sentinelles restantes, pour un message d'erreur qui dit
// quoi renseigner plutôt qu'un simple « configuration invalide ».
export function findPlaceholders(config, path = "") {
  if (typeof config === "string") {
    return PLACEHOLDER_VALUES.includes(config) ? [{ path, value: config }] : [];
  }
  if (Array.isArray(config)) {
    return config.flatMap((item, i) => findPlaceholders(item, `${path}[${i}]`));
  }
  if (isPlainObject(config)) {
    return Object.entries(config).flatMap(([key, value]) =>
      IGNORED_KEYS.has(key) ? [] : findPlaceholders(value, path ? `${path}.${key}` : key)
    );
  }
  return [];
}
