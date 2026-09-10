import { describe, expect, it } from "vitest";
import {
  PLACEHOLDER_VALUES,
  findPlaceholders,
  mergeConfig,
  stripJsonComments,
} from "../../scripts/config-merge.mjs";

describe("stripJsonComments", () => {
  it("retire les commentaires de ligne", () => {
    expect(JSON.parse(stripJsonComments('{\n  // note\n  "a": 1\n}'))).toEqual({ a: 1 });
  });

  it("retire les commentaires de bloc", () => {
    expect(JSON.parse(stripJsonComments('{ /* note\nsur deux lignes */ "a": 1 }'))).toEqual({ a: 1 });
  });

  // Le piège du décommentage naïf : une chaîne peut contenir les mêmes
  // caractères qu'un commentaire. Les couper là corromprait la configuration
  // silencieusement, et on déploierait une valeur tronquée.
  it("préserve // et /* à l'intérieur d'une chaîne", () => {
    const src = '{ "url": "https://exemple.fr/a", "glob": "/*.ts" }';
    expect(JSON.parse(stripJsonComments(src))).toEqual({
      url: "https://exemple.fr/a",
      glob: "/*.ts",
    });
  });

  it("préserve un guillemet échappé dans une chaîne", () => {
    const src = '{ "a": "il a dit \\"//\\" ici" }';
    expect(JSON.parse(stripJsonComments(src))).toEqual({ a: 'il a dit "//" ici' });
  });

  it("retire une virgule finale", () => {
    expect(JSON.parse(stripJsonComments('{ "a": 1, "b": [1, 2,], }'))).toEqual({ a: 1, b: [1, 2] });
  });
});

describe("mergeConfig", () => {
  it("remplace une valeur scalaire imbriquée sans toucher aux voisines", () => {
    const base = { vars: { MAIL_DOMAIN: "example.com", AUTRE: "gardé" } };
    const out = mergeConfig(base, { vars: { MAIL_DOMAIN: "courrier.test" } });
    expect(out).toEqual({ vars: { MAIL_DOMAIN: "courrier.test", AUTRE: "gardé" } });
  });

  it("ne mute pas la base", () => {
    const base = { vars: { MAIL_DOMAIN: "example.com" } };
    mergeConfig(base, { vars: { MAIL_DOMAIN: "courrier.test" } });
    expect(base.vars.MAIL_DOMAIN).toBe("example.com");
  });

  // Fusion élément par élément, et non remplacement du tableau : l'override ne
  // porte que database_id, il ne doit pas faire disparaître binding,
  // database_name ni migrations_dir — sans quoi le déploiement perdrait le
  // binding D1 et échouerait de façon obscure.
  it("fusionne les objets d'un tableau par position", () => {
    const base = {
      d1_databases: [
        { binding: "DB", database_name: "cloudmail", database_id: "local", migrations_dir: "migrations" },
      ],
    };
    const out = mergeConfig(base, { d1_databases: [{ database_id: "db-id-reel" }] });
    expect(out.d1_databases[0]).toEqual({
      binding: "DB",
      database_name: "cloudmail",
      database_id: "db-id-reel",
      migrations_dir: "migrations",
    });
  });

  it("ajoute un élément de tableau absent de la base", () => {
    const out = mergeConfig({ routes: [{ pattern: "a" }] }, { routes: [{ pattern: "b" }, { pattern: "c" }] });
    expect(out.routes).toEqual([{ pattern: "b" }, { pattern: "c" }]);
  });

  it("ajoute une clé absente de la base", () => {
    expect(mergeConfig({ a: 1 }, { b: 2 })).toEqual({ a: 1, b: 2 });
  });

  it("remplace un tableau de scalaires", () => {
    expect(mergeConfig({ flags: ["a", "b"] }, { flags: ["c"] })).toEqual({ flags: ["c"] });
  });
});

describe("findPlaceholders", () => {
  it("signale un placeholder resté en place, avec son chemin", () => {
    const found = findPlaceholders({ vars: { MAIL_DOMAIN: "example.com" } });
    expect(found).toEqual([{ path: "vars.MAIL_DOMAIN", value: "example.com" }]);
  });

  it("signale un placeholder dans un tableau", () => {
    const found = findPlaceholders({ routes: [{ pattern: "mail.example.com" }] });
    expect(found).toEqual([{ path: "routes[0].pattern", value: "mail.example.com" }]);
  });

  it("signale le database_id local", () => {
    const found = findPlaceholders({ d1_databases: [{ database_id: "local" }] });
    expect(found.map((f) => f.path)).toEqual(["d1_databases[0].database_id"]);
  });

  it("ne signale rien sur une configuration entièrement renseignée", () => {
    expect(
      findPlaceholders({
        routes: [{ pattern: "mail.courrier.test" }],
        d1_databases: [{ database_id: "db-id-reel" }],
        vars: { MAIL_DOMAIN: "courrier.test" },
      })
    ).toEqual([]);
  });

  it("ignore le $schema, qui pointe légitimement dans node_modules", () => {
    expect(findPlaceholders({ $schema: "node_modules/wrangler/config-schema.json" })).toEqual([]);
  });

  it("expose la liste des valeurs sentinelles", () => {
    expect(PLACEHOLDER_VALUES).toContain("local");
  });
});
