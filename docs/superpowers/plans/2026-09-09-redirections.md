# Redirections gérées depuis Cloudmail — plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Permettre de gérer depuis l'interface de Cloudmail des redirections « toutes les adresses » ou « une adresse » vers une destination vérifiée, appliquées par le Worker à chaque message reçu, sans jamais compromettre l'archivage.

**Architecture:** Une table D1 `forward_rules` est la source de vérité. Le handler `email()` lit les règles qui correspondent au destinataire, appelle `message.forward()` pour chaque destination distincte **avant** de consommer `message.raw` pour l'archivage, et enregistre le résultat de chaque tentative. Une API sous `/api/forwarding/*` expose le CRUD des règles et la liste des destinations vérifiées lues via l'API Cloudflare Email Routing avec un second token en lecture seule. Le SPA ajoute une vue « Redirections ».

**Tech Stack:** TypeScript, Cloudflare Workers, Hono, zod, D1, React 19 + TanStack Query, Vitest (`@cloudflare/vitest-plugin` côté Worker, jsdom + Testing Library côté SPA).

**Spec:** `docs/superpowers/specs/2026-09-09-redirections-design.md`

## Global Constraints

- **Langue** : commentaires, messages d'erreur utilisateur et libellés d'interface en français, comme tout le dépôt. Les commentaires expliquent *pourquoi*, jamais *quoi*.
- **Invariant absolu** : `setReject()` n'est jamais appelé, et un échec de redirection ne doit jamais empêcher l'archivage. Toute tâche touchant `src/email.ts` doit préserver cela.
- **Ordre imposé** : le forward précède la lecture de `message.raw`. `message.raw` est un `ReadableStream` à usage unique.
- **Valeur sentinelle** : `'*'` dans `match_local` signifie « toutes les adresses ». Jamais `NULL`.
- **Sémantique cumulative** : toutes les règles qui correspondent s'appliquent ; les destinations identiques sont dédoublonnées.
- **Contrat d'erreur API** : `{ error: { code, message } }`, comme les routes existantes.
- **Deux suites de tests distinctes** : `pnpm vitest run` à la racine (runtime Workers), `pnpm --filter web test` (jsdom). Ne jamais mélanger.
- **Migrations immuables** : `migrations/0002_forward_rules.sql` est modifiable tant qu'il n'a pas été appliqué en distant. Après application, toute évolution passe par un `0003_*.sql`.
- **Trailer de commit** : chaque message de commit se termine par une ligne vide puis `Claude-Session: https://claude.ai/code/session_01RmG3bbzbeMEHfVNaHtKygf`.
- **Ne jamais déployer** en cours de plan. Le déploiement est une étape manuelle post-plan.

---

### Task 1: Migration et moteur de correspondance

Le cœur du sujet : à partir d'une adresse destinataire, quelles destinations servir. Isolé de tout accès réseau, donc entièrement testable.

**Files:**
- Create: `migrations/0002_forward_rules.sql`
- Create: `src/forwarding/rules.ts`
- Test: `test/forwarding/rules.test.ts`

**Interfaces:**
- Consumes: rien.
- Produces:
  - `export const CATCH_ALL = "*"`
  - `export type ForwardRule = { id: number; matchLocal: string; destination: string; enabled: boolean; createdAt: number; lastAttemptAt: number | null; lastStatus: "ok" | "error" | null; lastError: string | null }`
  - `export type Match = { ruleIds: number[]; destination: string }`
  - `export function localPart(address: string): string | null`
  - `export async function matchingDestinations(db: D1Database, to: string): Promise<Match[]>`

- [ ] **Step 1: Écrire la migration**

Créer `migrations/0002_forward_rules.sql` :

```sql
-- migrations/0002_forward_rules.sql
CREATE TABLE forward_rules (
  id INTEGER PRIMARY KEY,
  -- Partie locale de l'adresse source, ou '*' pour « toutes les adresses ». On
  -- utilise une sentinelle plutôt que NULL : en SQLite deux NULL sont distincts,
  -- donc l'index unique ci-dessous laisserait créer deux fois la même règle
  -- catch-all vers la même destination. '*' n'étant pas une partie locale valide,
  -- la collision avec une vraie adresse est impossible.
  match_local TEXT NOT NULL,
  destination TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  -- Résultat de la dernière tentative de forward. Utile même avec une saisie par
  -- liste fermée : une destination peut être supprimée ou dé-vérifiée côté
  -- Cloudflare après la création de la règle, et rien d'autre ne le signalerait.
  last_attempt_at INTEGER,
  last_status TEXT CHECK (last_status IN ('ok','error')),
  last_error TEXT
);

CREATE UNIQUE INDEX idx_forward_rules_pair ON forward_rules(match_local, destination);
CREATE INDEX idx_forward_rules_match ON forward_rules(match_local) WHERE enabled = 1;
```

- [ ] **Step 2: Écrire les tests qui échouent**

Créer `test/forwarding/rules.test.ts` :

```ts
import { env, applyD1Migrations } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { CATCH_ALL, localPart, matchingDestinations } from "../../src/forwarding/rules";

interface TestEnv {
  DB: D1Database;
  TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
}

const testEnv = env as unknown as TestEnv;

beforeAll(async () => {
  await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
});

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM forward_rules").run();
});

const addRule = (matchLocal: string, destination: string, enabled = 1) =>
  env.DB.prepare(
    "INSERT INTO forward_rules (match_local, destination, enabled, created_at) VALUES (?, ?, ?, 0)"
  ).bind(matchLocal, destination, enabled).run();

describe("localPart", () => {
  it("extrait la partie locale en minuscules", () => {
    expect(localPart("Contact@Example.com")).toBe("contact");
  });

  it("coupe sur la dernière arobase", () => {
    expect(localPart('"a@b"@example.com')).toBe('"a@b"');
  });

  it("renvoie null sans partie locale exploitable", () => {
    expect(localPart("pas-une-adresse")).toBeNull();
    expect(localPart("@example.com")).toBeNull();
  });
});

describe("matchingDestinations", () => {
  it("retient la règle nominative", async () => {
    await addRule("contact", "a@exemple.com");
    const matches = await matchingDestinations(env.DB, "contact@example.com");
    expect(matches).toEqual([{ ruleIds: [expect.any(Number)], destination: "a@exemple.com" }]);
  });

  it("retient la règle catch-all pour n'importe quelle adresse", async () => {
    await addRule(CATCH_ALL, "a@exemple.com");
    const matches = await matchingDestinations(env.DB, "nimportequoi@example.com");
    expect(matches.map((m) => m.destination)).toEqual(["a@exemple.com"]);
  });

  it("cumule règle nominative et catch-all", async () => {
    await addRule(CATCH_ALL, "archive@exemple.com");
    await addRule("thomas", "gmail@exemple.com");
    const matches = await matchingDestinations(env.DB, "thomas@example.com");
    expect(matches.map((m) => m.destination).sort()).toEqual([
      "archive@exemple.com",
      "gmail@exemple.com",
    ]);
  });

  it("dédoublonne les destinations identiques en conservant les deux règles", async () => {
    await addRule(CATCH_ALL, "gmail@exemple.com");
    await addRule("thomas", "GMAIL@exemple.com");
    const matches = await matchingDestinations(env.DB, "thomas@example.com");
    expect(matches).toHaveLength(1);
    expect(matches[0].ruleIds).toHaveLength(2);
  });

  it("ignore les règles désactivées", async () => {
    await addRule("thomas", "a@exemple.com", 0);
    expect(await matchingDestinations(env.DB, "thomas@example.com")).toEqual([]);
  });

  it("compare la partie locale sans tenir compte de la casse", async () => {
    await addRule("thomas", "a@exemple.com");
    const matches = await matchingDestinations(env.DB, "Thomas@Example.com");
    expect(matches).toHaveLength(1);
  });

  it("n'applique que le catch-all si l'adresse est inexploitable", async () => {
    await addRule(CATCH_ALL, "a@exemple.com");
    await addRule("thomas", "b@exemple.com");
    const matches = await matchingDestinations(env.DB, "adresse-cassee");
    expect(matches.map((m) => m.destination)).toEqual(["a@exemple.com"]);
  });
});
```

- [ ] **Step 3: Lancer les tests pour vérifier qu'ils échouent**

Run: `pnpm vitest run test/forwarding/rules.test.ts`
Expected: FAIL — `Cannot find module '../../src/forwarding/rules'`.

- [ ] **Step 4: Écrire l'implémentation minimale**

Créer `src/forwarding/rules.ts` :

```ts
export const CATCH_ALL = "*";

export type ForwardRule = {
  id: number;
  matchLocal: string;
  destination: string;
  enabled: boolean;
  createdAt: number;
  lastAttemptAt: number | null;
  lastStatus: "ok" | "error" | null;
  lastError: string | null;
};

// Une destination à servir, et les règles qui l'ont demandée. Le tableau
// `ruleIds` en porte plusieurs quand des règles distinctes pointent vers la même
// adresse : on n'envoie alors qu'une copie, mais chaque règle reçoit son statut.
export type Match = { ruleIds: number[]; destination: string };

// Partie locale normalisée d'une adresse, ou null si l'adresse n'en a pas
// d'exploitable. On coupe sur la DERNIÈRE arobase : une partie locale citée peut
// légalement en contenir une (`"a@b"@example.com`), le domaine jamais.
export function localPart(address: string): string | null {
  const at = address.lastIndexOf("@");
  if (at <= 0) return null;
  return address.slice(0, at).toLowerCase();
}

export async function matchingDestinations(db: D1Database, to: string): Promise<Match[]> {
  const local = localPart(to);
  const { results } = await db
    .prepare(
      `SELECT id, destination FROM forward_rules
        WHERE enabled = 1 AND (match_local = ? OR match_local = ?)
        ORDER BY id`
    )
    // Quand l'adresse n'a pas de partie locale exploitable, les deux paramètres
    // valent '*' : seules les règles catch-all s'appliquent.
    .bind(CATCH_ALL, local ?? CATCH_ALL)
    .all<{ id: number; destination: string }>();

  const byDestination = new Map<string, Match>();
  for (const row of results) {
    const key = row.destination.toLowerCase();
    const existing = byDestination.get(key);
    if (existing) existing.ruleIds.push(row.id);
    else byDestination.set(key, { ruleIds: [row.id], destination: row.destination });
  }
  return [...byDestination.values()];
}
```

- [ ] **Step 5: Lancer les tests pour vérifier qu'ils passent**

Run: `pnpm vitest run test/forwarding/rules.test.ts`
Expected: PASS — 10 tests.

- [ ] **Step 6: Vérifier que la suite complète du Worker passe toujours**

Run: `pnpm vitest run`
Expected: PASS — la migration ajoutée ne casse aucun test existant.

- [ ] **Step 7: Commit**

```bash
git add migrations/0002_forward_rules.sql src/forwarding/rules.ts test/forwarding/rules.test.ts
git commit -m "feat(forwarding): table forward_rules et moteur de correspondance

La sémantique est cumulative : toutes les règles qui correspondent au
destinataire s'appliquent, catch-all comprise, et les destinations identiques
sont dédoublonnées pour n'envoyer qu'une copie tout en conservant un statut par
règle.

Claude-Session: https://claude.ai/code/session_01RmG3bbzbeMEHfVNaHtKygf"
```

---

### Task 2: Enregistrement du résultat des tentatives

**Files:**
- Modify: `src/forwarding/rules.ts` (ajout en fin de fichier)
- Test: `test/forwarding/rules.test.ts` (nouveau `describe`)

**Interfaces:**
- Consumes: `ForwardRule`, `Match` de la Task 1.
- Produces:
  - `export type AttemptResult = { ruleIds: number[]; status: "ok" | "error"; error?: string }`
  - `export async function recordAttempts(db: D1Database, results: AttemptResult[], now: number): Promise<void>`

- [ ] **Step 1: Écrire les tests qui échouent**

Ajouter à la fin de `test/forwarding/rules.test.ts` (et compléter l'import en tête du fichier avec `recordAttempts`) :

```ts
describe("recordAttempts", () => {
  const readRule = (id: number) =>
    env.DB.prepare(
      "SELECT last_attempt_at, last_status, last_error FROM forward_rules WHERE id = ?"
    ).bind(id).first<{ last_attempt_at: number; last_status: string; last_error: string | null }>();

  it("marque une règle servie avec succès", async () => {
    const { meta } = await addRule("thomas", "a@exemple.com");
    const id = meta.last_row_id;
    await recordAttempts(env.DB, [{ ruleIds: [id], status: "ok" }], 1700000000000);
    expect(await readRule(id)).toMatchObject({
      last_attempt_at: 1700000000000,
      last_status: "ok",
      last_error: null,
    });
  });

  it("enregistre l'erreur sur toutes les règles d'une destination en échec", async () => {
    const a = (await addRule(CATCH_ALL, "x@exemple.com")).meta.last_row_id;
    const b = (await addRule("thomas", "x@exemple.com")).meta.last_row_id;
    await recordAttempts(
      env.DB,
      [{ ruleIds: [a, b], status: "error", error: "destination non vérifiée" }],
      42,
    );
    expect(await readRule(a)).toMatchObject({ last_status: "error", last_error: "destination non vérifiée" });
    expect(await readRule(b)).toMatchObject({ last_status: "error", last_error: "destination non vérifiée" });
  });

  it("efface l'erreur précédente quand la tentative réussit", async () => {
    const id = (await addRule("thomas", "a@exemple.com")).meta.last_row_id;
    await recordAttempts(env.DB, [{ ruleIds: [id], status: "error", error: "boom" }], 1);
    await recordAttempts(env.DB, [{ ruleIds: [id], status: "ok" }], 2);
    expect(await readRule(id)).toMatchObject({ last_status: "ok", last_error: null });
  });

  it("tronque un message d'erreur trop long", async () => {
    const id = (await addRule("thomas", "a@exemple.com")).meta.last_row_id;
    await recordAttempts(env.DB, [{ ruleIds: [id], status: "error", error: "x".repeat(900) }], 1);
    const row = await readRule(id);
    expect(row?.last_error).toHaveLength(500);
  });

  it("ne fait rien sur une liste vide", async () => {
    await expect(recordAttempts(env.DB, [], 1)).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Lancer les tests pour vérifier qu'ils échouent**

Run: `pnpm vitest run test/forwarding/rules.test.ts`
Expected: FAIL — `recordAttempts is not a function` / erreur d'import.

- [ ] **Step 3: Écrire l'implémentation minimale**

Ajouter à la fin de `src/forwarding/rules.ts` :

```ts
export type AttemptResult = { ruleIds: number[]; status: "ok" | "error"; error?: string };

// Borne de stockage du message d'erreur. Les erreurs de l'API Cloudflare sont
// courtes ; la borne existe pour qu'une exception inattendue et volumineuse ne
// fasse pas grossir indéfiniment une ligne relue à chaque affichage de l'UI.
const MAX_ERROR_CHARS = 500;

export async function recordAttempts(
  db: D1Database,
  results: AttemptResult[],
  now: number,
): Promise<void> {
  const statements = results.flatMap((r) =>
    r.ruleIds.map((id) =>
      db
        .prepare(
          `UPDATE forward_rules
              SET last_attempt_at = ?, last_status = ?, last_error = ?
            WHERE id = ?`
        )
        .bind(
          now,
          r.status,
          r.status === "error" ? (r.error ?? "Erreur inconnue").slice(0, MAX_ERROR_CHARS) : null,
          id,
        )
    )
  );
  // db.batch() rejette un tableau vide : on sort avant plutôt que de laisser
  // remonter une erreur pour un cas parfaitement normal (aucune règle ne matche).
  if (statements.length === 0) return;
  await db.batch(statements);
}
```

- [ ] **Step 4: Lancer les tests pour vérifier qu'ils passent**

Run: `pnpm vitest run test/forwarding/rules.test.ts`
Expected: PASS — 15 tests.

- [ ] **Step 5: Commit**

```bash
git add src/forwarding/rules.ts test/forwarding/rules.test.ts
git commit -m "feat(forwarding): enregistre le résultat de chaque tentative de forward

Une destination peut être supprimée ou dé-vérifiée côté Cloudflare après la
création de la règle : sans ce statut, l'échec serait entièrement silencieux.

Claude-Session: https://claude.ai/code/session_01RmG3bbzbeMEHfVNaHtKygf"
```

---

### Task 3: Application des redirections dans le handler `email()`

Tâche la plus sensible du plan : elle touche le seul chemin où un message peut être perdu.

**Files:**
- Modify: `src/email.ts:5-20` (fonction `handleEmail`)
- Test: `test/email-handler.test.ts`

**Interfaces:**
- Consumes: `matchingDestinations`, `recordAttempts`, `AttemptResult` de `src/forwarding/rules.ts`.
- Produces: aucune nouvelle export ; `handleEmail(message, env)` garde sa signature.

- [ ] **Step 1: Écrire les tests qui échouent**

Dans `test/email-handler.test.ts`, ajouter `forward_rules` au `DELETE` du `beforeEach` existant, puis ajouter ce `describe` après le `describe("handleEmail", …)` :

```ts
const addRule = (matchLocal: string, destination: string, enabled = 1) =>
  env.DB.prepare(
    "INSERT INTO forward_rules (match_local, destination, enabled, created_at) VALUES (?, ?, ?, 0)"
  ).bind(matchLocal, destination, enabled).run();

const countMessages = async () =>
  (await env.DB.prepare("SELECT COUNT(*) AS n FROM messages").first<{ n: number }>())?.n;

describe("handleEmail — redirections", () => {
  it("ne forwarde rien quand aucune règle ne correspond", async () => {
    const msg = fakeMessage("simple.eml");
    await handleEmail(msg, env);
    expect(msg.forward).not.toHaveBeenCalled();
    expect(await countMessages()).toBe(1);
  });

  it("forwarde vers la destination de la règle qui correspond", async () => {
    await addRule("thomas", "gmail@exemple.com");
    const msg = fakeMessage("simple.eml");
    await handleEmail(msg, env);
    expect(msg.forward).toHaveBeenCalledWith("gmail@exemple.com");
    expect(await countMessages()).toBe(1);
  });

  it("n'envoie qu'une copie quand deux règles visent la même destination", async () => {
    await addRule("*", "gmail@exemple.com");
    await addRule("thomas", "gmail@exemple.com");
    const msg = fakeMessage("simple.eml");
    await handleEmail(msg, env);
    expect(msg.forward).toHaveBeenCalledTimes(1);
  });

  it("archive le message même si le forward échoue, et enregistre l'erreur", async () => {
    await addRule("thomas", "gmail@exemple.com");
    const msg = fakeMessage("simple.eml");
    (msg.forward as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("destination non vérifiée"));

    await expect(handleEmail(msg, env)).resolves.toBeUndefined();

    expect(await countMessages()).toBe(1);
    expect(msg.setReject).not.toHaveBeenCalled();
    const rule = await env.DB.prepare(
      "SELECT last_status, last_error FROM forward_rules LIMIT 1"
    ).first<{ last_status: string; last_error: string }>();
    expect(rule).toMatchObject({ last_status: "error", last_error: "destination non vérifiée" });
  });

  it("archive le message même si la lecture des règles échoue", async () => {
    const msg = fakeMessage("simple.eml");
    // Proxy et non un objet étalé : les méthodes de D1Database vivent sur le
    // prototype, donc `{ ...env.DB }` perdrait batch(), exec() et consorts dont
    // storeIncoming a besoin pour archiver — le test échouerait alors pour la
    // mauvaise raison.
    const brokenRules = {
      ...env,
      DB: new Proxy(env.DB, {
        get(target, prop) {
          if (prop === "prepare") {
            return (sql: string) => {
              if (sql.includes("forward_rules")) throw new Error("d1 down");
              return target.prepare(sql);
            };
          }
          const value = Reflect.get(target, prop, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      }),
    } as unknown as typeof env;

    await expect(handleEmail(msg, brokenRules)).resolves.toBeUndefined();
    expect(await countMessages()).toBe(1);
    expect(msg.setReject).not.toHaveBeenCalled();
  });

  it("forwarde même si l'archivage échoue", async () => {
    await addRule("thomas", "gmail@exemple.com");
    const msg = fakeMessage("simple.eml");
    const brokenR2 = {
      ...env,
      MAIL: {
        put: () => {
          throw new Error("r2 down");
        },
      },
    } as unknown as typeof env;

    await expect(handleEmail(msg, brokenR2)).resolves.toBeUndefined();
    expect(msg.forward).toHaveBeenCalledWith("gmail@exemple.com");
    expect(msg.setReject).not.toHaveBeenCalled();
  });

  it("forwarde avant de consommer message.raw", async () => {
    await addRule("thomas", "gmail@exemple.com");
    const msg = fakeMessage("simple.eml");
    let rawWasLockedAtForward: boolean | null = null;
    (msg.forward as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      rawWasLockedAtForward = msg.raw.locked;
    });

    await handleEmail(msg, env);
    expect(rawWasLockedAtForward).toBe(false);
  });
});
```

Note : le faux message de ce fichier a `to: "thomas@example.com"`, d'où la partie locale `thomas` utilisée dans les règles.

- [ ] **Step 2: Lancer les tests pour vérifier qu'ils échouent**

Run: `pnpm vitest run test/email-handler.test.ts`
Expected: FAIL — `expected "spy" to be called with arguments: [ 'gmail@exemple.com' ]`, aucun forward n'ayant lieu.

- [ ] **Step 3: Écrire l'implémentation minimale**

Remplacer le début de `src/email.ts` (imports et `handleEmail`) par :

```ts
import type { Env } from "./env";
import { parseEmail } from "./ingest/parse";
import { storeIncoming } from "./ingest/store";
import { matchingDestinations, recordAttempts, type AttemptResult } from "./forwarding/rules";

// Applique les règles de redirection. Entièrement encapsulée dans son propre
// try/catch : une redirection est un service rendu en plus de l'archivage, jamais
// une condition de celui-ci. Un échec ici — D1 indisponible, destination
// dé-vérifiée — ne doit pas coûter l'archivage du message.
async function applyForwardRules(message: ForwardableEmailMessage, env: Env): Promise<void> {
  try {
    const matches = await matchingDestinations(env.DB, message.to);
    if (matches.length === 0) return;

    const results: AttemptResult[] = [];
    for (const match of matches) {
      try {
        await message.forward(match.destination);
        results.push({ ruleIds: match.ruleIds, status: "ok" });
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        console.error(JSON.stringify({
          event: "forward_failed",
          to: message.to,
          destination: match.destination,
          error,
        }));
        results.push({ ruleIds: match.ruleIds, status: "error", error });
      }
    }
    await recordAttempts(env.DB, results, Date.now());
  } catch (err) {
    console.error(JSON.stringify({
      event: "forward_rules_failed",
      to: message.to,
      error: err instanceof Error ? err.message : String(err),
    }));
  }
}

export async function handleEmail(message: ForwardableEmailMessage, env: Env): Promise<void> {
  // Les redirections passent AVANT l'archivage : `message.raw` est un
  // ReadableStream à usage unique, et on ne veut pas dépendre de son état après
  // consommation par storeIncoming.
  await applyForwardRules(message, env);

  try {
    const raw = await new Response(message.raw).arrayBuffer();
    const res = await storeIncoming(env, raw, { from: message.from, to: message.to });
    console.log(JSON.stringify({ event: "email_stored", ...res, from: message.from }));
  } catch (err) {
    // On n'appelle jamais setReject : un rejet renverrait un bounce à l'expéditeur.
    // Cette route est le seul endroit du projet où avaler une erreur est le
    // comportement voulu.
    console.error(JSON.stringify({
      event: "email_failed",
      from: message.from,
      to: message.to,
      error: err instanceof Error ? err.message : String(err),
    }));
  }
}
```

- [ ] **Step 4: Lancer les tests pour vérifier qu'ils passent**

Run: `pnpm vitest run test/email-handler.test.ts`
Expected: PASS — les 2 tests existants plus les 7 nouveaux.

- [ ] **Step 5: Lancer la suite complète du Worker**

Run: `pnpm vitest run && pnpm typecheck`
Expected: PASS pour les deux.

- [ ] **Step 6: Commit**

```bash
git add src/email.ts test/email-handler.test.ts
git commit -m "feat(forwarding): applique les redirections à la réception

Le forward précède la lecture de message.raw, qui est un ReadableStream à usage
unique. Les deux étapes sont mutuellement isolées : un échec de redirection
n'empêche pas l'archivage, et un échec d'archivage ne prive pas les destinations
de leur copie. setReject n'est toujours jamais appelé.

Claude-Session: https://claude.ai/code/session_01RmG3bbzbeMEHfVNaHtKygf"
```

---

### Task 4: Lecture des destinations vérifiées chez Cloudflare

**Files:**
- Create: `src/forwarding/destinations.ts`
- Modify: `src/env.ts:1-12`
- Modify: `.dev.vars.example`
- Test: `test/forwarding/destinations.test.ts`

**Interfaces:**
- Consumes: `Env`.
- Produces:
  - `export class RoutingUnavailableError extends Error`
  - `export async function listVerifiedDestinations(env: Env): Promise<string[]>`

- [ ] **Step 1: Écrire les tests qui échouent**

Créer `test/forwarding/destinations.test.ts` :

```ts
import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  RoutingUnavailableError,
  listVerifiedDestinations,
} from "../../src/forwarding/destinations";

afterEach(() => vi.unstubAllGlobals());

const withRouting = () => ({ ...env, CF_ACCOUNT_ID: "acc", CF_ROUTING_TOKEN: "tok" });

describe("listVerifiedDestinations", () => {
  it("ne renvoie que les destinations vérifiées", async () => {
    vi.stubGlobal("fetch", async () =>
      Response.json({
        success: true,
        result: [
          { email: "ok@exemple.com", verified: "2026-01-01T00:00:00Z" },
          { email: "attente@exemple.com", verified: null },
        ],
      })
    );
    expect(await listVerifiedDestinations(withRouting())).toEqual(["ok@exemple.com"]);
  });

  it("appelle l'API compte avec le token de routage", async () => {
    const fetchSpy = vi.fn(async () => Response.json({ success: true, result: [] }));
    vi.stubGlobal("fetch", fetchSpy);
    await listVerifiedDestinations(withRouting());
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/accounts/acc/email/routing/addresses");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok");
  });

  it("lève RoutingUnavailableError quand le secret est absent", async () => {
    await expect(
      listVerifiedDestinations({ ...env, CF_ACCOUNT_ID: "acc", CF_ROUTING_TOKEN: "" } as typeof env)
    ).rejects.toBeInstanceOf(RoutingUnavailableError);
  });

  it("lève RoutingUnavailableError quand l'API refuse", async () => {
    vi.stubGlobal("fetch", async () =>
      Response.json({ success: false, errors: [{ message: "nope" }] }, { status: 403 })
    );
    await expect(listVerifiedDestinations(withRouting())).rejects.toBeInstanceOf(
      RoutingUnavailableError
    );
  });

  it("lève RoutingUnavailableError sur une réponse illisible", async () => {
    vi.stubGlobal("fetch", async () => new Response("pas du json", { status: 200 }));
    await expect(listVerifiedDestinations(withRouting())).rejects.toBeInstanceOf(
      RoutingUnavailableError
    );
  });
});
```

- [ ] **Step 2: Lancer les tests pour vérifier qu'ils échouent**

Run: `pnpm vitest run test/forwarding/destinations.test.ts`
Expected: FAIL — `Cannot find module '../../src/forwarding/destinations'`.

- [ ] **Step 3: Déclarer le nouveau secret**

Dans `src/env.ts`, ajouter le champ après `CF_API_TOKEN` :

```ts
export interface Env {
  DB: D1Database;
  MAIL: R2Bucket;
  ASSETS: Fetcher;
  CF_ACCOUNT_ID: string;
  CF_API_TOKEN: string;
  // Token distinct de CF_API_TOKEN, portant la seule permission « Email Routing:
  // Read ». Séparer les deux garde le moindre privilège : une fuite du token
  // d'envoi ne donne pas accès à la configuration de routage, et réciproquement.
  CF_ROUTING_TOKEN: string;
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUD: string;
  ALLOWED_EMAILS: string;
  MAIL_DOMAIN: string;
  DEV_BYPASS_AUTH?: string;
}
```

Ajouter la ligne correspondante à `.dev.vars.example` :

```
CF_ROUTING_TOKEN=
```

- [ ] **Step 4: Écrire l'implémentation minimale**

Créer `src/forwarding/destinations.ts` :

```ts
import type { Env } from "../env";

// Distingue « la liste des destinations est inconnue » de « le compte n'a aucune
// destination ». Les deux se traduiraient par un tableau vide, alors que l'UI doit
// les présenter différemment : un problème de configuration n'est pas un état vide.
export class RoutingUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RoutingUnavailableError";
  }
}

type AddressRow = { email: string; verified: string | null };

export async function listVerifiedDestinations(env: Env): Promise<string[]> {
  if (!env.CF_ACCOUNT_ID || !env.CF_ROUTING_TOKEN) {
    throw new RoutingUnavailableError(
      "CF_ACCOUNT_ID ou CF_ROUTING_TOKEN n'est pas configuré sur ce Worker"
    );
  }

  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/email/routing/addresses?per_page=50`,
    { headers: { Authorization: `Bearer ${env.CF_ROUTING_TOKEN}` } }
  );

  const body = (await res.json().catch(() => null)) as
    | { success?: boolean; result?: AddressRow[] }
    | null;

  if (!res.ok || !body?.success || !Array.isArray(body.result)) {
    throw new RoutingUnavailableError(`API Cloudflare Email Routing : statut ${res.status}`);
  }

  // `verified` porte la date de confirmation, ou null tant que le lien reçu par
  // mail n'a pas été cliqué. Seules les adresses confirmées sont acceptées par
  // message.forward().
  return body.result.filter((a) => a.verified).map((a) => a.email);
}
```

- [ ] **Step 5: Lancer les tests pour vérifier qu'ils passent**

Run: `pnpm vitest run test/forwarding/destinations.test.ts`
Expected: PASS — 5 tests.

- [ ] **Step 6: Commit**

```bash
git add src/forwarding/destinations.ts src/env.ts .dev.vars.example test/forwarding/destinations.test.ts
git commit -m "feat(forwarding): lit les destinations vérifiées via l'API Cloudflare

message.forward() n'accepte qu'une destination confirmée sur le compte : la
lister permet à l'interface de fermer la saisie plutôt que de laisser passer une
faute de frappe qui n'échouerait qu'à la réception du premier message.

Le token est un second secret en lecture seule, pour ne pas élargir la
permission unique « Email Sending: Send » de CF_API_TOKEN.

Claude-Session: https://claude.ai/code/session_01RmG3bbzbeMEHfVNaHtKygf"
```

---

### Task 5: CRUD des règles en base

**Files:**
- Modify: `src/forwarding/rules.ts` (ajout en fin de fichier)
- Test: `test/forwarding/rules.test.ts` (nouveau `describe`)

**Interfaces:**
- Consumes: `ForwardRule`, `CATCH_ALL` de la Task 1.
- Produces:
  - `export async function listForwardRules(db: D1Database): Promise<ForwardRule[]>`
  - `export async function createForwardRule(db: D1Database, input: { matchLocal: string; destination: string }, now: number): Promise<ForwardRule | null>` — `null` si le couple existe déjà
  - `export async function setForwardRuleEnabled(db: D1Database, id: number, enabled: boolean): Promise<boolean>`
  - `export async function deleteForwardRule(db: D1Database, id: number): Promise<boolean>`

- [ ] **Step 1: Écrire les tests qui échouent**

Ajouter à `test/forwarding/rules.test.ts` (compléter l'import en tête avec les quatre fonctions) :

```ts
describe("CRUD des règles", () => {
  it("crée une règle et la relit", async () => {
    const created = await createForwardRule(
      env.DB,
      { matchLocal: "contact", destination: "a@exemple.com" },
      1700000000000,
    );
    expect(created).toMatchObject({
      matchLocal: "contact",
      destination: "a@exemple.com",
      enabled: true,
      createdAt: 1700000000000,
      lastStatus: null,
    });
    expect(await listForwardRules(env.DB)).toHaveLength(1);
  });

  it("renvoie null sur un couple (source, destination) déjà présent", async () => {
    await createForwardRule(env.DB, { matchLocal: "contact", destination: "a@exemple.com" }, 1);
    const again = await createForwardRule(
      env.DB,
      { matchLocal: "contact", destination: "a@exemple.com" },
      2,
    );
    expect(again).toBeNull();
    expect(await listForwardRules(env.DB)).toHaveLength(1);
  });

  it("autorise deux règles catch-all vers des destinations différentes", async () => {
    await createForwardRule(env.DB, { matchLocal: CATCH_ALL, destination: "a@exemple.com" }, 1);
    await createForwardRule(env.DB, { matchLocal: CATCH_ALL, destination: "b@exemple.com" }, 2);
    expect(await listForwardRules(env.DB)).toHaveLength(2);
  });

  it("refuse une seconde règle catch-all identique", async () => {
    await createForwardRule(env.DB, { matchLocal: CATCH_ALL, destination: "a@exemple.com" }, 1);
    expect(
      await createForwardRule(env.DB, { matchLocal: CATCH_ALL, destination: "a@exemple.com" }, 2)
    ).toBeNull();
  });

  it("désactive puis réactive une règle", async () => {
    const rule = await createForwardRule(env.DB, { matchLocal: "contact", destination: "a@exemple.com" }, 1);
    expect(await setForwardRuleEnabled(env.DB, rule!.id, false)).toBe(true);
    expect((await listForwardRules(env.DB))[0].enabled).toBe(false);
    await setForwardRuleEnabled(env.DB, rule!.id, true);
    expect((await listForwardRules(env.DB))[0].enabled).toBe(true);
  });

  it("supprime une règle", async () => {
    const rule = await createForwardRule(env.DB, { matchLocal: "contact", destination: "a@exemple.com" }, 1);
    expect(await deleteForwardRule(env.DB, rule!.id)).toBe(true);
    expect(await listForwardRules(env.DB)).toEqual([]);
  });

  it("signale l'absence sur un identifiant inconnu", async () => {
    expect(await setForwardRuleEnabled(env.DB, 999, false)).toBe(false);
    expect(await deleteForwardRule(env.DB, 999)).toBe(false);
  });
});
```

- [ ] **Step 2: Lancer les tests pour vérifier qu'ils échouent**

Run: `pnpm vitest run test/forwarding/rules.test.ts`
Expected: FAIL — erreur d'import sur `createForwardRule`.

- [ ] **Step 3: Écrire l'implémentation minimale**

Ajouter à la fin de `src/forwarding/rules.ts` :

```ts
type ForwardRuleRow = {
  id: number;
  match_local: string;
  destination: string;
  enabled: number;
  created_at: number;
  last_attempt_at: number | null;
  last_status: "ok" | "error" | null;
  last_error: string | null;
};

const toForwardRule = (row: ForwardRuleRow): ForwardRule => ({
  id: row.id,
  matchLocal: row.match_local,
  destination: row.destination,
  enabled: row.enabled === 1,
  createdAt: row.created_at,
  lastAttemptAt: row.last_attempt_at,
  lastStatus: row.last_status,
  lastError: row.last_error,
});

const SELECT_COLUMNS =
  "id, match_local, destination, enabled, created_at, last_attempt_at, last_status, last_error";

export async function listForwardRules(db: D1Database): Promise<ForwardRule[]> {
  // Les catch-all d'abord, puis l'ordre alphabétique : l'interface liste ainsi la
  // règle la plus large en tête, ce qui reflète la sémantique cumulative.
  const { results } = await db
    .prepare(
      `SELECT ${SELECT_COLUMNS} FROM forward_rules
        ORDER BY (match_local = '*') DESC, match_local, destination`
    )
    .all<ForwardRuleRow>();
  return results.map(toForwardRule);
}

export async function createForwardRule(
  db: D1Database,
  input: { matchLocal: string; destination: string },
  now: number,
): Promise<ForwardRule | null> {
  // On s'appuie sur l'index unique plutôt que sur un SELECT préalable : deux
  // requêtes concurrentes passeraient toutes les deux la vérification, l'index
  // est la seule garantie réelle.
  const row = await db
    .prepare(
      `INSERT INTO forward_rules (match_local, destination, enabled, created_at)
       VALUES (?, ?, 1, ?)
       ON CONFLICT (match_local, destination) DO NOTHING
       RETURNING ${SELECT_COLUMNS}`
    )
    .bind(input.matchLocal, input.destination, now)
    .first<ForwardRuleRow>();
  return row ? toForwardRule(row) : null;
}

export async function setForwardRuleEnabled(
  db: D1Database,
  id: number,
  enabled: boolean,
): Promise<boolean> {
  const { meta } = await db
    .prepare("UPDATE forward_rules SET enabled = ? WHERE id = ?")
    .bind(enabled ? 1 : 0, id)
    .run();
  return meta.changes > 0;
}

export async function deleteForwardRule(db: D1Database, id: number): Promise<boolean> {
  const { meta } = await db.prepare("DELETE FROM forward_rules WHERE id = ?").bind(id).run();
  return meta.changes > 0;
}
```

- [ ] **Step 4: Lancer les tests pour vérifier qu'ils passent**

Run: `pnpm vitest run test/forwarding/rules.test.ts`
Expected: PASS — 22 tests.

- [ ] **Step 5: Commit**

```bash
git add src/forwarding/rules.ts test/forwarding/rules.test.ts
git commit -m "feat(forwarding): CRUD des règles de redirection

La détection de doublon repose sur l'index unique et non sur un SELECT
préalable, seul moyen de rester correct sous requêtes concurrentes.

Claude-Session: https://claude.ai/code/session_01RmG3bbzbeMEHfVNaHtKygf"
```

---

### Task 6: Routes API

**Files:**
- Modify: `src/api/routes.ts` (imports en tête, schémas zod après `sendBody`, routes en fin de fichier)
- Test: `test/api/forwarding.test.ts`

**Interfaces:**
- Consumes: `listForwardRules`, `createForwardRule`, `setForwardRuleEnabled`, `deleteForwardRule`, `CATCH_ALL` (Tasks 1 et 5) ; `listVerifiedDestinations`, `RoutingUnavailableError` (Task 4).
- Produces: routes HTTP consommées par la Task 7.
  - `GET /api/config` → `{ mailDomain: string }`
  - `GET /api/forwarding/rules` → `ForwardRule[]`
  - `POST /api/forwarding/rules` → `ForwardRule` (201)
  - `PATCH /api/forwarding/rules/:id` → `{ ok: true }`
  - `DELETE /api/forwarding/rules/:id` → `{ ok: true }`
  - `GET /api/forwarding/destinations` → `{ destinations: string[] }`

- [ ] **Step 1: Écrire les tests qui échouent**

Créer `test/api/forwarding.test.ts` :

```ts
import { env, applyD1Migrations } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { app } from "../../src/index";

interface TestEnv {
  DB: D1Database;
  TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
}

const testEnv = env as unknown as TestEnv;

beforeAll(async () => {
  await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
});

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM forward_rules").run();
});

afterEach(() => vi.unstubAllGlobals());

const stubDestinations = (emails: string[]) =>
  vi.stubGlobal("fetch", async () =>
    Response.json({
      success: true,
      result: emails.map((email) => ({ email, verified: "2026-01-01T00:00:00Z" })),
    })
  );

const withEnv = () => ({
  ...env,
  DEV_BYPASS_AUTH: "1",
  CF_ACCOUNT_ID: "acc",
  CF_ROUTING_TOKEN: "tok",
  MAIL_DOMAIN: "example.com",
});

const req = (path: string, init?: RequestInit) =>
  app.request(`https://example.com${path}`, init ?? {}, withEnv());

const postRule = (body: unknown) =>
  req("/api/forwarding/rules", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe("GET /api/config", () => {
  it("expose le domaine de courrier", async () => {
    const res = await req("/api/config");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ mailDomain: "example.com" });
  });
});

describe("POST /api/forwarding/rules", () => {
  it("crée une règle sur une destination vérifiée", async () => {
    stubDestinations(["gmail@exemple.com"]);
    const res = await postRule({ matchLocal: "contact", destination: "gmail@exemple.com" });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ matchLocal: "contact", enabled: true });
  });

  it("normalise la partie locale en minuscules", async () => {
    stubDestinations(["gmail@exemple.com"]);
    const res = await postRule({ matchLocal: "  Contact  ", destination: "gmail@exemple.com" });
    expect(await res.json()).toMatchObject({ matchLocal: "contact" });
  });

  it("accepte la sentinelle catch-all", async () => {
    stubDestinations(["gmail@exemple.com"]);
    const res = await postRule({ matchLocal: "*", destination: "gmail@exemple.com" });
    expect(res.status).toBe(201);
  });

  it("refuse une partie locale invalide", async () => {
    stubDestinations(["gmail@exemple.com"]);
    const res = await postRule({ matchLocal: "a b@c", destination: "gmail@exemple.com" });
    expect(res.status).toBe(400);
    expect((await res.json() as { error: { code: string } }).error.code).toBe("invalid_body");
  });

  it("refuse une destination non vérifiée", async () => {
    stubDestinations(["gmail@exemple.com"]);
    const res = await postRule({ matchLocal: "contact", destination: "typo@exmple.com" });
    expect(res.status).toBe(400);
    expect((await res.json() as { error: { code: string } }).error.code).toBe("unverified_destination");
  });

  it("refuse un doublon", async () => {
    stubDestinations(["gmail@exemple.com"]);
    await postRule({ matchLocal: "contact", destination: "gmail@exemple.com" });
    const res = await postRule({ matchLocal: "contact", destination: "gmail@exemple.com" });
    expect(res.status).toBe(409);
    expect((await res.json() as { error: { code: string } }).error.code).toBe("duplicate_rule");
  });

  it("répond 503 quand la liste des destinations est inaccessible", async () => {
    vi.stubGlobal("fetch", async () => Response.json({ success: false }, { status: 403 }));
    const res = await postRule({ matchLocal: "contact", destination: "gmail@exemple.com" });
    expect(res.status).toBe(503);
    expect((await res.json() as { error: { code: string } }).error.code).toBe("routing_unavailable");
  });
});

describe("GET /api/forwarding/rules", () => {
  it("liste les règles, catch-all en tête", async () => {
    stubDestinations(["a@exemple.com"]);
    await postRule({ matchLocal: "contact", destination: "a@exemple.com" });
    await postRule({ matchLocal: "*", destination: "a@exemple.com" });
    const rules = (await (await req("/api/forwarding/rules")).json()) as { matchLocal: string }[];
    expect(rules.map((r) => r.matchLocal)).toEqual(["*", "contact"]);
  });
});

describe("PATCH et DELETE /api/forwarding/rules/:id", () => {
  const create = async () => {
    stubDestinations(["a@exemple.com"]);
    const res = await postRule({ matchLocal: "contact", destination: "a@exemple.com" });
    return (await res.json()) as { id: number };
  };

  it("désactive une règle", async () => {
    const rule = await create();
    const res = await req(`/api/forwarding/rules/${rule.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    expect(res.status).toBe(200);
    const rules = (await (await req("/api/forwarding/rules")).json()) as { enabled: boolean }[];
    expect(rules[0].enabled).toBe(false);
  });

  it("supprime une règle", async () => {
    const rule = await create();
    expect((await req(`/api/forwarding/rules/${rule.id}`, { method: "DELETE" })).status).toBe(200);
    expect(await (await req("/api/forwarding/rules")).json()).toEqual([]);
  });

  it("répond 404 sur un identifiant inconnu", async () => {
    expect((await req("/api/forwarding/rules/999", { method: "DELETE" })).status).toBe(404);
  });

  it("répond 400 sur un identifiant non numérique", async () => {
    expect((await req("/api/forwarding/rules/abc", { method: "DELETE" })).status).toBe(400);
  });
});

describe("GET /api/forwarding/destinations", () => {
  it("ne renvoie que les destinations vérifiées", async () => {
    vi.stubGlobal("fetch", async () =>
      Response.json({
        success: true,
        result: [
          { email: "ok@exemple.com", verified: "2026-01-01T00:00:00Z" },
          { email: "attente@exemple.com", verified: null },
        ],
      })
    );
    const res = await req("/api/forwarding/destinations");
    expect(await res.json()).toEqual({ destinations: ["ok@exemple.com"] });
  });

  it("répond 503 plutôt qu'une liste vide quand le token manque", async () => {
    const res = await app.request(
      "https://example.com/api/forwarding/destinations",
      {},
      { ...env, DEV_BYPASS_AUTH: "1", CF_ACCOUNT_ID: "acc", CF_ROUTING_TOKEN: "" },
    );
    expect(res.status).toBe(503);
  });
});

describe("frontière Access", () => {
  it("refuse les routes de redirection sans jeton", async () => {
    const res = await app.request("https://example.com/api/forwarding/rules", {}, env);
    expect(res.status).toBe(401);
  });
});
```

- [ ] **Step 2: Lancer les tests pour vérifier qu'ils échouent**

Run: `pnpm vitest run test/api/forwarding.test.ts`
Expected: FAIL — 404 sur toutes les routes.

- [ ] **Step 3: Écrire l'implémentation minimale**

Dans `src/api/routes.ts`, ajouter aux imports en tête :

```ts
import {
  CATCH_ALL,
  createForwardRule,
  deleteForwardRule,
  listForwardRules,
  setForwardRuleEnabled,
} from "../forwarding/rules";
import { RoutingUnavailableError, listVerifiedDestinations } from "../forwarding/destinations";
```

Ajouter les schémas après `sendBody` :

```ts
// Partie locale d'une adresse, ou la sentinelle '*' pour « toutes les adresses ».
// Le jeu de caractères est celui des adresses non citées du RFC 5322 : suffisant
// pour tout ce qui s'écrit en pratique, et assez restreint pour qu'aucune valeur
// acceptée ici ne puisse être confondue avec la sentinelle.
const forwardRuleBody = z.object({
  matchLocal: z
    .string()
    .trim()
    .max(64)
    .transform((v) => v.toLowerCase())
    .refine((v) => v === CATCH_ALL || /^[a-z0-9._%+-]+$/.test(v), {
      message: "Partie locale invalide",
    }),
  destination: z.string().email(),
});

const forwardRulePatchBody = z.object({ enabled: z.boolean() });
```

Ajouter les routes en fin de fichier :

```ts
api.get("/config", (c) => c.json({ mailDomain: c.env.MAIL_DOMAIN }));

api.get("/forwarding/rules", async (c) => c.json(await listForwardRules(c.env.DB)));

api.post("/forwarding/rules", async (c) => {
  const parsed = forwardRuleBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: { code: "invalid_body", message: parsed.error.message } }, 400);
  }

  // La liste fermée côté interface est un confort, pas une garantie : on
  // revalide ici, car une destination non vérifiée ferait échouer le forward
  // silencieusement, longtemps après la création de la règle.
  let destinations: string[];
  try {
    destinations = await listVerifiedDestinations(c.env);
  } catch (err) {
    if (err instanceof RoutingUnavailableError) {
      return c.json({
        error: {
          code: "routing_unavailable",
          message: "Impossible de lire les destinations vérifiées du compte Cloudflare",
        },
      }, 503);
    }
    throw err;
  }

  const destination = parsed.data.destination;
  if (!destinations.some((d) => d.toLowerCase() === destination.toLowerCase())) {
    return c.json({
      error: {
        code: "unverified_destination",
        message: `${destination} n'est pas une destination vérifiée sur votre compte Cloudflare`,
      },
    }, 400);
  }

  const rule = await createForwardRule(c.env.DB, parsed.data, Date.now());
  if (!rule) {
    return c.json({
      error: { code: "duplicate_rule", message: "Cette redirection existe déjà" },
    }, 409);
  }
  return c.json(rule, 201);
});

api.patch("/forwarding/rules/:id", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id)) {
    return c.json({ error: { code: "invalid_id", message: "Identifiant invalide" } }, 400);
  }
  const parsed = forwardRulePatchBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: { code: "invalid_body", message: parsed.error.message } }, 400);
  }
  const found = await setForwardRuleEnabled(c.env.DB, id, parsed.data.enabled);
  if (!found) {
    return c.json({ error: { code: "not_found", message: "Redirection introuvable" } }, 404);
  }
  return c.json({ ok: true });
});

api.delete("/forwarding/rules/:id", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id)) {
    return c.json({ error: { code: "invalid_id", message: "Identifiant invalide" } }, 400);
  }
  const found = await deleteForwardRule(c.env.DB, id);
  if (!found) {
    return c.json({ error: { code: "not_found", message: "Redirection introuvable" } }, 404);
  }
  return c.json({ ok: true });
});

api.get("/forwarding/destinations", async (c) => {
  try {
    return c.json({ destinations: await listVerifiedDestinations(c.env) });
  } catch (err) {
    if (err instanceof RoutingUnavailableError) {
      // 503 et non une liste vide : « je ne sais pas » ne doit pas se lire comme
      // « le compte n'a aucune destination », l'interface les affiche différemment.
      return c.json({
        error: {
          code: "routing_unavailable",
          message: "Impossible de lire les destinations vérifiées du compte Cloudflare",
        },
      }, 503);
    }
    throw err;
  }
});
```

- [ ] **Step 4: Lancer les tests pour vérifier qu'ils passent**

Run: `pnpm vitest run test/api/forwarding.test.ts`
Expected: PASS — 17 tests.

- [ ] **Step 5: Lancer la suite complète du Worker et le typecheck**

Run: `pnpm vitest run && pnpm typecheck`
Expected: PASS pour les deux.

- [ ] **Step 6: Commit**

```bash
git add src/api/routes.ts test/api/forwarding.test.ts
git commit -m "feat(api): routes de gestion des redirections

La destination est revalidée côté serveur contre la liste vérifiée : la liste
fermée de l'interface est un confort, pas une garantie. La route destinations
répond 503 plutôt qu'une liste vide quand elle ne peut pas interroger
Cloudflare, pour que l'interface distingue « inconnu » de « aucune ».

Claude-Session: https://claude.ai/code/session_01RmG3bbzbeMEHfVNaHtKygf"
```

---

### Task 7: Client SPA

**Files:**
- Modify: `web/src/api/client.ts` (ajout en fin de fichier, après `useUpdateMessage`)
- Test: `web/src/api/client.test.tsx` (nouveau `describe`)

**Interfaces:**
- Consumes: routes de la Task 6.
- Produces:
  - `export type ForwardRule` (miroir du type Worker)
  - `export type AppConfig = { mailDomain: string }`
  - `export const useConfig`, `useForwardRules`, `useForwardDestinations`, `useCreateForwardRule`, `useUpdateForwardRule`, `useDeleteForwardRule`

- [ ] **Step 1: Écrire les tests qui échouent**

Ouvrir `web/src/api/client.test.tsx` pour reprendre son harnais existant (`QueryClientProvider`, stub de `fetch`), puis ajouter :

```tsx
describe("hooks de redirection", () => {
  it("useForwardRules lit /api/forwarding/rules", async () => {
    const fetchSpy = vi.fn(async () =>
      new Response(JSON.stringify([
        {
          id: 1, matchLocal: "*", destination: "a@exemple.com", enabled: true,
          createdAt: 1, lastAttemptAt: null, lastStatus: null, lastError: null,
        },
      ]), { status: 200, headers: { "content-type": "application/json" } })
    );
    vi.stubGlobal("fetch", fetchSpy);

    const { result } = renderHook(() => useForwardRules(), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(fetchSpy.mock.calls[0][0]).toBe("/api/forwarding/rules");
    expect(result.current.data?.[0].matchLocal).toBe("*");
  });

  it("useCreateForwardRule poste la règle", async () => {
    const fetchSpy = vi.fn(async () =>
      new Response(JSON.stringify({ id: 1 }), {
        status: 201, headers: { "content-type": "application/json" },
      })
    );
    vi.stubGlobal("fetch", fetchSpy);

    const { result } = renderHook(() => useCreateForwardRule(), { wrapper });
    result.current.mutate({ matchLocal: "contact", destination: "a@exemple.com" });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/forwarding/rules");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({
      matchLocal: "contact",
      destination: "a@exemple.com",
    });
  });

  it("useDeleteForwardRule appelle DELETE sur l'identifiant", async () => {
    const fetchSpy = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200, headers: { "content-type": "application/json" },
      })
    );
    vi.stubGlobal("fetch", fetchSpy);

    const { result } = renderHook(() => useDeleteForwardRule(), { wrapper });
    result.current.mutate(7);
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/forwarding/rules/7");
    expect(init.method).toBe("DELETE");
  });
});
```

Si le fichier ne définit pas déjà `wrapper` et n'importe pas `renderHook`/`waitFor`, les ajouter en tête :

```tsx
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";

const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    {children}
  </QueryClientProvider>
);
```

- [ ] **Step 2: Lancer les tests pour vérifier qu'ils échouent**

Run: `pnpm --filter web test -- --run src/api/client.test.tsx`
Expected: FAIL — `useForwardRules is not exported`.

- [ ] **Step 3: Écrire l'implémentation minimale**

Ajouter à la fin de `web/src/api/client.ts` :

```ts
// Miroir volontaire de ForwardRule dans src/forwarding/rules.ts, comme les types
// ci-dessus : le SPA et le Worker sont deux cibles de build distinctes.
export type ForwardRule = {
  id: number;
  matchLocal: string;
  destination: string;
  enabled: boolean;
  createdAt: number;
  lastAttemptAt: number | null;
  lastStatus: "ok" | "error" | null;
  lastError: string | null;
};

export type AppConfig = { mailDomain: string };

export const useConfig = () =>
  useQuery({ queryKey: ["config"], queryFn: () => api<AppConfig>("/config") });

export const useForwardRules = () =>
  useQuery({ queryKey: ["forwardRules"], queryFn: () => api<ForwardRule[]>("/forwarding/rules") });

// retry: false — un 503 « routing_unavailable » traduit une configuration
// manquante, pas un incident passager : réessayer ne changerait rien et
// retarderait l'affichage du message qui explique quoi faire.
export const useForwardDestinations = () =>
  useQuery({
    queryKey: ["forwardDestinations"],
    queryFn: () => api<{ destinations: string[] }>("/forwarding/destinations"),
    retry: false,
  });

export const useCreateForwardRule = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { matchLocal: string; destination: string }) =>
      api<ForwardRule>("/forwarding/rules", { method: "POST", body: JSON.stringify(vars) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["forwardRules"] }),
  });
};

export const useUpdateForwardRule = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: number; enabled: boolean }) =>
      api<{ ok: true }>(`/forwarding/rules/${vars.id}`, {
        method: "PATCH",
        body: JSON.stringify({ enabled: vars.enabled }),
      }),
    onSettled: () => qc.invalidateQueries({ queryKey: ["forwardRules"] }),
  });
};

export const useDeleteForwardRule = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) =>
      api<{ ok: true }>(`/forwarding/rules/${id}`, { method: "DELETE" }),
    onSettled: () => qc.invalidateQueries({ queryKey: ["forwardRules"] }),
  });
};
```

- [ ] **Step 4: Lancer les tests pour vérifier qu'ils passent**

Run: `pnpm --filter web test -- --run src/api/client.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/api/client.ts web/src/api/client.test.tsx
git commit -m "feat(web): hooks de gestion des redirections

useForwardDestinations ne réessaie pas : un 503 traduit une configuration
manquante, pas un incident passager.

Claude-Session: https://claude.ai/code/session_01RmG3bbzbeMEHfVNaHtKygf"
```

---

### Task 8: Vue « Redirections »

**Files:**
- Create: `web/src/components/ForwardingSettings.tsx`
- Create: `web/src/components/ForwardingSettings.test.tsx`
- Modify: `web/src/components/Sidebar.tsx:13-46`
- Modify: `web/src/App.tsx:10-60`

**Interfaces:**
- Consumes: les hooks de la Task 7.
- Produces:
  - `export function ForwardingSettings(): JSX.Element`
  - `Sidebar` gagne les props `view: "mail" | "forwarding"` et `onSelectView: (view: "mail" | "forwarding") => void`

- [ ] **Step 1: Écrire les tests qui échouent**

Créer `web/src/components/ForwardingSettings.test.tsx` :

```tsx
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ForwardingSettings } from "./ForwardingSettings";

afterEach(() => vi.unstubAllGlobals());

const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    {children}
  </QueryClientProvider>
);

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const rule = (over: Partial<Record<string, unknown>> = {}) => ({
  id: 1, matchLocal: "contact", destination: "gmail@exemple.com", enabled: true,
  createdAt: 1, lastAttemptAt: null, lastStatus: null, lastError: null, ...over,
});

// Route les appels selon le chemin : le composant en émet trois au montage
// (config, règles, destinations) et l'ordre n'est pas garanti.
const stubApi = (opts: {
  rules?: unknown[];
  destinations?: string[];
  destinationsStatus?: number;
}) =>
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url === "/api/config") return json({ mailDomain: "example.com" });
    if (url === "/api/forwarding/rules") return json(opts.rules ?? []);
    if (url === "/api/forwarding/destinations") {
      return opts.destinationsStatus === 503
        ? json({ error: { code: "routing_unavailable", message: "indisponible" } }, 503)
        : json({ destinations: opts.destinations ?? [] });
    }
    return json({ ok: true });
  }));

describe("ForwardingSettings", () => {
  it("liste les règles existantes", async () => {
    stubApi({ rules: [rule(), rule({ id: 2, matchLocal: "*", destination: "a@exemple.com" })] });
    render(<ForwardingSettings />, { wrapper });

    expect(await screen.findByText("contact@example.com")).toBeDefined();
    expect(screen.getByText("Toutes les adresses")).toBeDefined();
    expect(screen.getByText("gmail@exemple.com")).toBeDefined();
  });

  it("affiche l'erreur de la dernière tentative", async () => {
    stubApi({ rules: [rule({ lastStatus: "error", lastError: "destination non vérifiée" })] });
    render(<ForwardingSettings />, { wrapper });
    expect(await screen.findByText(/destination non vérifiée/)).toBeDefined();
  });

  it("annonce l'absence de règle", async () => {
    stubApi({ rules: [] });
    render(<ForwardingSettings />, { wrapper });
    expect(await screen.findByText("Aucune redirection.")).toBeDefined();
  });

  it("renvoie vers le dashboard Cloudflare sans destination vérifiée", async () => {
    stubApi({ rules: [], destinations: [] });
    render(<ForwardingSettings />, { wrapper });

    await userEvent.click(await screen.findByRole("button", { name: "Ajouter une redirection" }));
    expect(await screen.findByRole("link", { name: /dashboard Cloudflare/ })).toBeDefined();
    expect(screen.queryByRole("combobox", { name: "Vers" })).toBeNull();
  });

  it("signale une configuration de routage manquante", async () => {
    stubApi({ rules: [], destinationsStatus: 503 });
    render(<ForwardingSettings />, { wrapper });

    await userEvent.click(await screen.findByRole("button", { name: "Ajouter une redirection" }));
    expect(await screen.findByText(/Impossible de lire les destinations/)).toBeDefined();
  });

  it("crée une redirection sur une adresse", async () => {
    stubApi({ rules: [], destinations: ["gmail@exemple.com"] });
    render(<ForwardingSettings />, { wrapper });

    await userEvent.click(await screen.findByRole("button", { name: "Ajouter une redirection" }));
    await userEvent.type(await screen.findByLabelText("Partie locale"), "contact");
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Vers" }), "gmail@exemple.com");
    await userEvent.click(screen.getByRole("button", { name: "Enregistrer" }));

    await waitFor(() => {
      const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.find(
        ([, init]) => (init as RequestInit | undefined)?.method === "POST",
      );
      expect(JSON.parse((call?.[1] as RequestInit).body as string)).toEqual({
        matchLocal: "contact",
        destination: "gmail@exemple.com",
      });
    });
  });

  it("crée une redirection catch-all", async () => {
    stubApi({ rules: [], destinations: ["gmail@exemple.com"] });
    render(<ForwardingSettings />, { wrapper });

    await userEvent.click(await screen.findByRole("button", { name: "Ajouter une redirection" }));
    await userEvent.click(await screen.findByLabelText("Toutes les adresses du domaine"));
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Vers" }), "gmail@exemple.com");
    await userEvent.click(screen.getByRole("button", { name: "Enregistrer" }));

    await waitFor(() => {
      const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.find(
        ([, init]) => (init as RequestInit | undefined)?.method === "POST",
      );
      expect(JSON.parse((call?.[1] as RequestInit).body as string).matchLocal).toBe("*");
    });
  });

  it("supprime une redirection", async () => {
    stubApi({ rules: [rule()] });
    render(<ForwardingSettings />, { wrapper });

    await userEvent.click(
      await screen.findByRole("button", { name: "Supprimer la redirection contact@example.com" }),
    );
    await waitFor(() => {
      const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.find(
        ([, init]) => (init as RequestInit | undefined)?.method === "DELETE",
      );
      expect(call?.[0]).toBe("/api/forwarding/rules/1");
    });
  });

  it("bascule l'activation d'une redirection", async () => {
    stubApi({ rules: [rule()] });
    render(<ForwardingSettings />, { wrapper });

    await userEvent.click(await screen.findByRole("switch", { name: /Activer/ }));
    await waitFor(() => {
      const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.find(
        ([, init]) => (init as RequestInit | undefined)?.method === "PATCH",
      );
      expect(JSON.parse((call?.[1] as RequestInit).body as string)).toEqual({ enabled: false });
    });
  });
});
```

- [ ] **Step 2: Lancer les tests pour vérifier qu'ils échouent**

Run: `pnpm --filter web test -- --run src/components/ForwardingSettings.test.tsx`
Expected: FAIL — `Failed to resolve import "./ForwardingSettings"`.

- [ ] **Step 3: Écrire le composant**

Créer `web/src/components/ForwardingSettings.tsx` :

```tsx
import { useState } from "react";
import {
  useConfig,
  useCreateForwardRule,
  useDeleteForwardRule,
  useForwardDestinations,
  useForwardRules,
  useUpdateForwardRule,
  type ForwardRule,
} from "../api/client";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

const CATCH_ALL = "*";
const DASHBOARD_URL = "https://dash.cloudflare.com/?to=/:account/email/routing/destination-addresses";

const sourceLabel = (rule: ForwardRule, mailDomain: string) =>
  rule.matchLocal === CATCH_ALL ? "Toutes les adresses" : `${rule.matchLocal}@${mailDomain}`;

function RuleRow({ rule, mailDomain }: { rule: ForwardRule; mailDomain: string }) {
  const update = useUpdateForwardRule();
  const remove = useDeleteForwardRule();
  const label = sourceLabel(rule, mailDomain);

  return (
    <li className="flex items-center gap-3 border-b border-border py-3 text-sm">
      <div className="min-w-0 flex-1">
        <p className="truncate">
          <span className="font-medium">{label}</span>
          <span className="mx-2 text-muted-foreground">→</span>
          <span>{rule.destination}</span>
        </p>
        {rule.lastStatus === "error" && (
          <p className="mt-1 text-xs text-destructive">
            Dernière tentative en échec : {rule.lastError}
          </p>
        )}
      </div>

      <button
        type="button"
        role="switch"
        aria-checked={rule.enabled}
        aria-label={`Activer la redirection ${label}`}
        onClick={() => update.mutate({ id: rule.id, enabled: !rule.enabled })}
        className="rounded border border-border px-2 py-1 text-xs aria-[checked=true]:bg-accent"
      >
        {rule.enabled ? "Active" : "Inactive"}
      </button>

      <button
        type="button"
        aria-label={`Supprimer la redirection ${label}`}
        onClick={() => remove.mutate(rule.id)}
        className="rounded px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
      >
        Supprimer
      </button>
    </li>
  );
}

function NewRuleForm({ mailDomain, onDone }: { mailDomain: string; onDone: () => void }) {
  const destinations = useForwardDestinations();
  const create = useCreateForwardRule();
  const [catchAll, setCatchAll] = useState(false);
  const [local, setLocal] = useState("");
  const [destination, setDestination] = useState("");

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    create.mutate(
      { matchLocal: catchAll ? CATCH_ALL : local.trim(), destination },
      { onSuccess: onDone },
    );
  };

  // Trois états distincts, volontairement non fusionnés : « je ne sais pas »
  // (503, configuration manquante) ne doit pas se lire comme « aucune
  // destination » (compte vide), qui ne se lit pas comme « en cours ».
  const unavailable = destinations.isError;
  const empty = destinations.isSuccess && destinations.data.destinations.length === 0;

  return (
    <form onSubmit={submit} className="flex flex-col gap-4 border border-border p-4 text-sm">
      <fieldset className="flex flex-col gap-2">
        <legend className="sr-only">Adresse source</legend>
        <label className="flex items-center gap-2">
          <input type="radio" checked={!catchAll} onChange={() => setCatchAll(false)} />
          Une adresse
        </label>
        <div className="flex items-center gap-1 pl-6">
          <Input
            aria-label="Partie locale"
            value={local}
            disabled={catchAll}
            onChange={(e) => setLocal(e.target.value)}
            className="w-40"
          />
          <span className="text-muted-foreground">@{mailDomain}</span>
        </div>
        <label className="flex items-center gap-2">
          <input type="radio" checked={catchAll} onChange={() => setCatchAll(true)} />
          Toutes les adresses du domaine
        </label>
      </fieldset>

      {unavailable && (
        <p className="text-xs text-destructive">
          Impossible de lire les destinations vérifiées du compte Cloudflare. Vérifiez que le
          secret CF_ROUTING_TOKEN est posé sur le Worker.
        </p>
      )}

      {empty && (
        <p className="text-xs text-muted-foreground">
          Aucune destination vérifiée. Ajoutez-en une depuis le{" "}
          <a href={DASHBOARD_URL} target="_blank" rel="noreferrer" className="underline">
            dashboard Cloudflare
          </a>
          , puis cliquez le lien de confirmation reçu par mail.
        </p>
      )}

      {!unavailable && !empty && (
        <label className="flex flex-col gap-1">
          Vers
          <select
            aria-label="Vers"
            value={destination}
            onChange={(e) => setDestination(e.target.value)}
            className="rounded border border-border bg-transparent px-3 py-2"
          >
            <option value="">── choisir ──</option>
            {destinations.data?.destinations.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
        </label>
      )}

      {create.isError && <p className="text-xs text-destructive">{create.error.message}</p>}

      <div className="flex gap-2">
        <Button type="submit" disabled={!destination || (!catchAll && !local.trim())}>
          Enregistrer
        </Button>
        <Button type="button" variant="ghost" onClick={onDone}>
          Annuler
        </Button>
      </div>
    </form>
  );
}

export function ForwardingSettings() {
  const config = useConfig();
  const rules = useForwardRules();
  const [adding, setAdding] = useState(false);
  const mailDomain = config.data?.mailDomain ?? "";

  return (
    <section className="mx-auto flex w-full max-w-2xl flex-col gap-4 p-6">
      <header className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">Redirections</h1>
        {!adding && (
          <Button type="button" onClick={() => setAdding(true)}>
            Ajouter une redirection
          </Button>
        )}
      </header>

      <p className="text-sm text-muted-foreground">
        Toutes les règles qui correspondent à une adresse s'appliquent : un message reçu peut
        partir vers plusieurs destinations. Il reste dans tous les cas archivé dans Cloudmail.
      </p>

      {adding && <NewRuleForm mailDomain={mailDomain} onDone={() => setAdding(false)} />}

      {rules.isSuccess && rules.data.length === 0 && (
        <p className="text-sm text-muted-foreground">Aucune redirection.</p>
      )}

      <ul>
        {rules.data?.map((rule) => (
          <RuleRow key={rule.id} rule={rule} mailDomain={mailDomain} />
        ))}
      </ul>
    </section>
  );
}
```

- [ ] **Step 4: Lancer les tests pour vérifier qu'ils passent**

Run: `pnpm --filter web test -- --run src/components/ForwardingSettings.test.tsx`
Expected: PASS — 9 tests. Si `Button` n'accepte pas `variant="ghost"`, lire `web/src/components/ui/button.tsx` et utiliser une variante réellement définie.

- [ ] **Step 5: Brancher la vue dans la navigation**

Dans `web/src/components/Sidebar.tsx`, remplacer la signature et ajouter l'entrée de navigation :

```tsx
export function Sidebar({
  folder,
  onSelectFolder,
  view,
  onSelectView,
}: {
  folder: string;
  onSelectFolder: (folder: string) => void;
  view: "mail" | "forwarding";
  onSelectView: (view: "mail" | "forwarding") => void;
}) {
```

Dans le `<ul>` des dossiers, remplacer `aria-current={f.id === folder ? "true" : undefined}` par `aria-current={view === "mail" && f.id === folder ? "true" : undefined}`, et `onClick={() => onSelectFolder(f.id)}` par `onClick={() => { onSelectView("mail"); onSelectFolder(f.id); }}`.

Juste après ce `<ul>`, ajouter :

```tsx
      <ul className="flex flex-col gap-1">
        <li>
          <button
            type="button"
            aria-current={view === "forwarding" ? "true" : undefined}
            onClick={() => onSelectView("forwarding")}
            className="w-full rounded px-3 py-2 text-left text-sm hover:bg-accent aria-[current=true]:bg-accent aria-[current=true]:font-semibold"
          >
            Redirections
          </button>
        </li>
      </ul>
```

Dans `web/src/App.tsx`, ajouter l'import `import { ForwardingSettings } from "./components/ForwardingSettings";`, l'état `const [view, setView] = useState<"mail" | "forwarding">("mail");`, passer `view={view} onSelectView={setView}` à `<Sidebar>`, et remplacer les deux colonnes de droite par un rendu conditionnel :

```tsx
      {view === "forwarding" ? (
        <div className="col-span-1 overflow-y-auto lg:col-span-2">
          <ForwardingSettings />
        </div>
      ) : (
        <>
          {/* ICI : déplacer VERBATIM les deux <div> existants — celui de la
              colonne « recherche + ThreadList » et celui de ThreadView — sans
              modifier une ligne de leur contenu ni de leurs className. */}
        </>
      )}
```

Le premier `<div>` de la grille (celui qui contient `<Sidebar>`) reste **hors** de
ce conditionnel : la navigation doit rester visible dans les deux vues.

- [ ] **Step 6: Lancer toute la suite du SPA**

Run: `pnpm --filter web test`
Expected: PASS — les 24 tests existants plus les nouveaux. Si un test de `Sidebar` casse sur les props ajoutées, le corriger en lui passant `view="mail"` et `onSelectView={() => {}}`.

- [ ] **Step 7: Vérifier le build et le typecheck**

Run: `pnpm build && pnpm typecheck`
Expected: PASS pour les deux.

- [ ] **Step 8: Commit**

```bash
git add web/src/components/ForwardingSettings.tsx web/src/components/ForwardingSettings.test.tsx web/src/components/Sidebar.tsx web/src/App.tsx
git commit -m "feat(web): vue de gestion des redirections

Le formulaire distingue trois états de la liste des destinations — inconnue
(503), vide, chargée — parce qu'une configuration manquante et un compte sans
destination appellent deux actions différentes de la part de l'utilisateur.

Claude-Session: https://claude.ai/code/session_01RmG3bbzbeMEHfVNaHtKygf"
```

---

### Task 9: Documentation

**Files:**
- Modify: `README.md` (section « Architecture », « Mise en service », « Rejeu d'un message »)

**Interfaces:**
- Consumes: tout ce qui précède.
- Produces: rien de logiciel.

- [ ] **Step 1: Documenter la brique dans « Architecture »**

Ajouter ce paragraphe à la fin de la section « Architecture » :

```markdown
Les redirections sont gérées depuis l'application, pas depuis le tableau de bord
Cloudflare. Une règle de la table D1 `forward_rules` associe une adresse source
— une partie locale, ou `*` pour toutes les adresses du domaine — à une
destination vérifiée sur le compte Cloudflare. À la réception, `handleEmail`
(`src/email.ts`) applique **toutes** les règles qui correspondent au
destinataire, catch-all comprise, et dédoublonne les destinations identiques.
Le forward précède l'archivage, parce que `message.raw` est un `ReadableStream`
à usage unique ; les deux étapes sont isolées, si bien qu'un échec de
redirection ne coûte jamais l'archivage. Cette séparation est ce qui permet
qu'un message arrive à la fois dans Cloudmail et dans une boîte externe :
Cloudflare Email Routing ne sait livrer qu'à un Worker **ou** à une adresse,
jamais aux deux.
```

- [ ] **Step 2: Documenter le second token et le secret**

Dans la section « Mise en service », remplacer l'étape 8 par :

```markdown
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
```

Puis, dans l'étape 9, ajouter la troisième commande et adapter le texte :

```markdown
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
```

- [ ] **Step 3: Documenter la règle catch-all et le piège des règles littérales**

Dans l'étape 6, après le paragraphe existant sur le catch-all, ajouter :

```markdown
**Attention aux règles littérales déjà en place.** Une règle Email Routing sur
une adresse précise passe **avant** le catch-all : tant qu'elle existe, le
Worker ne voit jamais cette adresse, et Cloudmail n'en archive rien. Si le
domaine porte déjà des règles de forwarding (par exemple `contact@` vers une
boîte Gmail), il faut les supprimer et recréer les redirections équivalentes
depuis l'interface « Redirections » de Cloudmail — c'est le Worker qui reprend
alors le forward, en plus de l'archivage.

Recréer une redirection **catch-all** vers une boîte externe plutôt que des
règles nominatives forwarde aussi tout le courrier adressé à des adresses
inexistantes, que Cloudflare drope aujourd'hui. Le choix est laissé à
l'utilisateur ; les règles nominatives sont recommandées.
```

- [ ] **Step 4: Documenter le comportement de `reparse`**

Dans la section « Rejeu d'un message (`reparse`) », ajouter après le premier paragraphe :

```markdown
**`reparse` ne rejoue pas les redirections.** Elle rejoue l'ingestion d'un
message déjà stocké ; re-forwarder à cette occasion enverrait un doublon aux
destinataires externes, qui ont déjà reçu leur copie lors de la réception
initiale. Un rejeu corrige donc la ligne D1 et le contenu indexé, jamais ce qui
est déjà parti.
```

- [ ] **Step 5: Relire le README modifié**

Run: `git diff README.md`
Expected: les quatre ajouts sont présents, la numérotation des étapes reste cohérente (1 à 10), et aucune occurrence de `pnpm deploy` sans `run` n'a été réintroduite.

- [ ] **Step 6: Lancer la vérification finale complète**

Run: `pnpm test && pnpm typecheck && pnpm build`
Expected: PASS pour les trois. Ne pas déployer.

- [ ] **Step 7: Commit**

```bash
git add README.md
git commit -m "docs: documente les redirections gérées depuis Cloudmail

Signale en particulier qu'une règle Email Routing littérale masque le catch-all,
piège qui empêcherait silencieusement le Worker de voir les adresses concernées.

Claude-Session: https://claude.ai/code/session_01RmG3bbzbeMEHfVNaHtKygf"
```

---

## Après le plan (manuel, hors périmètre de l'exécution)

Ces étapes touchent le compte Cloudflare et ne sont pas automatisées :

1. `pnpm wrangler d1 migrations apply cloudmail --remote` — applique `0002_forward_rules.sql`.
2. Créer le token « Email Routing: Read » et poser `pnpm wrangler secret put CF_ROUTING_TOKEN`.
3. `pnpm run deploy`.
4. Dans Email Routing : supprimer les règles littérales existantes, activer le catch-all vers le Worker `cloudmail`.
5. Recréer les redirections depuis l'interface « Redirections ».

L'ordre compte : la migration avant le déploiement, et le déploiement avant la bascule du routage — sinon le Worker reçoit du courrier alors que `forward_rules` n'existe pas encore, et les redirections sont silencieusement sautées (l'archivage, lui, reste assuré).
