import { readdir, readFile } from "node:fs/promises";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

const readFixtures = async (): Promise<Record<string, string>> => {
  const dir = new URL("./test/fixtures/", import.meta.url);
  const names = await readdir(dir);
  const fixtures: Record<string, string> = {};
  for (const name of names) {
    if (!name.endsWith(".eml")) continue;
    const buf = await readFile(new URL(name, dir));
    fixtures[name] = buf.toString("base64");
  }
  return fixtures;
};

export default defineConfig(async () => {
  const migrations = await readD1Migrations("./migrations");
  const fixtures = await readFixtures();

  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            TEST_FIXTURES: fixtures,
            // Neutralise le contournement d'authentification que `.dev.vars` active
            // pour `wrangler dev`. Sans ça, tout développeur ayant suivi la mise en
            // route locale voit les tests de la frontière Access échouer, alors que
            // la production ne charge jamais `.dev.vars`. Les tests qui ont besoin du
            // contournement l'injectent explicitement via `app.request(url, init, env)`.
            DEV_BYPASS_AUTH: "",
          },
        },
      }),
    ],
    test: {
      // Le front (web/) a son propre vitest en environnement jsdom — on l'exclut ici
      // pour que cette config, contrainte au runtime Workers, ne tente jamais de
      // charger ses tests React (et inversement, voir web/vitest.config.ts).
      exclude: ["**/node_modules/**", "**/dist/**", "web/**"],
    },
  };
});
