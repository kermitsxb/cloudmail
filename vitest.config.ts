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
          bindings: { TEST_MIGRATIONS: migrations, TEST_FIXTURES: fixtures },
        },
      }),
    ],
  };
});
