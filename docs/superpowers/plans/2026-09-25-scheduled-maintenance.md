# Scheduled Maintenance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A daily Cron Trigger empties trash older than `TRASH_RETENTION_DAYS` and counts R2 orphans; the result shows in the Maintenance view, a sidebar badge and a trash notice.

**Architecture:** `scheduled()` in `src/index.ts` calls `runMaintenance` (`src/maintenance/run.ts`), which runs two independent, capped tasks (`trash.ts`, `orphans.ts`) and records one row in a new `maintenance_runs` table (`runs.ts`). Two admin routes expose the latest runs and a manual orphan check; the SPA reads them.

**Tech Stack:** Cloudflare Workers (Cron Triggers, D1, R2), Hono, zod, Vitest + `@cloudflare/vitest-plugin` (Miniflare); React 19, TanStack Query, Vitest + jsdom for `web/`.

**Spec:** `docs/superpowers/specs/2026-09-25-scheduled-maintenance-design.md`

## Global Constraints

- `src/email.ts` is not touched; nothing here may call `setReject()`.
- Trash purge goes **only** through the existing `purgeMessage` (`src/db/mutations.ts`) — R2 first, then D1. Never delete rows or R2 objects directly.
- The orphan check only lists and counts. It never re-imports, never deletes.
- `runMaintenance` and `runOrphanCheck` never throw.
- Purge is never triggerable from the HTTP API or the UI.
- Caps: `TRASH_PURGE_BATCH = 100`, `ORPHAN_CHECK_MAX_PAGES = 20`, `ORPHAN_SAMPLE_SIZE = 20`, `MAINTENANCE_RUNS_KEPT = 30`.
- Cron: `"17 3 * * *"` — exactly one trigger (free plan limit).
- `TRASH_RETENTION_DAYS` default `"30"` in `wrangler.jsonc` `vars`; `0`, missing or unparsable → purge disabled.
- Timestamps in D1 are **seconds** (`received_at`, `trashed_at`, `ran_at`).
- Schema changes only in the new `migrations/0004_scheduled_maintenance.sql`; never edit `0001`–`0003`.
- Every visible SPA string goes through `useI18n().t`, in both `web/src/i18n/fr.ts` and `web/src/i18n/en.ts`; dates through `formatDate`.
- Test names and code comments are in French, like the rest of the codebase; neutral example addresses only (`example.com`).
- Commit messages carry no session URL or Claude attribution.
- Worker tests: `pnpm vitest run <file>` at the root. SPA tests: `pnpm --filter web test -- <file>`. Worker typecheck: `pnpm typecheck`. SPA typecheck: `pnpm build`.

## Review Focus

1. `TRASH_RETENTION_DAYS` overridden as a JSON number (`30`, not `"30"`) in `wrangler.overrides.json` → must still mean 30 days. Pinned in Task 2.
2. A message restored from the trash then trashed again → its retention clock restarts from the second move. Pinned in Task 1.
3. A trashed **sent** message (`raw_key = sent/<id>`, no R2 object) → purges cleanly. Pinned in Task 2.
4. A manual "Re-run the check" after a cron run → the Maintenance view still shows the last night's purge. Pinned in Task 4.
5. A manual check that fails (R2 down) → the user sees an error, not a silently unchanged card. Pinned in Task 5.

---

### Task 1: `trashed_at` column and `maintenance_runs` table

**Files:**
- Create: `migrations/0004_scheduled_maintenance.sql`
- Modify: `src/db/mutations.ts` (`moveToFolder`, the first `statements` line)
- Test: `test/api/mutations.test.ts`

**Interfaces:**
- Produces: column `messages.trashed_at INTEGER` (seconds, `NULL` outside trash); table `maintenance_runs` (columns below); `moveToFolder` keeps its signature `(db: D1Database, messageId: number, folder: "inbox" | "sent" | "trash") => Promise<boolean>`.

- [ ] **Step 1: Write the failing tests**

Append to `test/api/mutations.test.ts`:

```ts
describe("moveToFolder — trashed_at", () => {
  const trashedAt = async (id: number) =>
    (await env.DB.prepare("SELECT trashed_at FROM messages WHERE id = ?").bind(id)
      .first<{ trashed_at: number | null }>())?.trashed_at;

  it("date l'entrée en corbeille et l'efface à la sortie", async () => {
    const before = Math.floor(Date.now() / 1000);
    await moveToFolder(env.DB, 1, "trash");
    expect(await trashedAt(1)).toBeGreaterThanOrEqual(before - 1);
    await moveToFolder(env.DB, 1, "inbox");
    expect(await trashedAt(1)).toBeNull();
  });

  it("redémarre le délai quand un message restauré retourne à la corbeille", async () => {
    await moveToFolder(env.DB, 1, "trash");
    await env.DB.prepare("UPDATE messages SET trashed_at = 1000 WHERE id = 1").run();
    await moveToFolder(env.DB, 1, "inbox");
    await moveToFolder(env.DB, 1, "trash");
    expect(await trashedAt(1)).toBeGreaterThan(1000);
  });

  it("ne date rien lors d'un déplacement hors corbeille", async () => {
    await moveToFolder(env.DB, 1, "sent");
    expect(await trashedAt(1)).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run test/api/mutations.test.ts`
Expected: FAIL — `no such column: trashed_at`.

- [ ] **Step 3: Write the migration**

`migrations/0004_scheduled_maintenance.sql`:

```sql
-- Maintenance planifiée : date d'entrée en corbeille et historique des passages.

-- NULL hors corbeille. Posé et effacé par moveToFolder, seul chemin vers la corbeille.
ALTER TABLE messages ADD COLUMN trashed_at INTEGER;

-- Les messages déjà à la corbeille reçoivent l'heure de la migration, pas leur date de
-- réception : le premier passage après le déploiement ne purge rien, et le plus ancien
-- contenu existant part N jours après le déploiement.
UPDATE messages SET trashed_at = unixepoch() WHERE folder = 'trash';

CREATE INDEX idx_messages_trashed_at ON messages(folder, trashed_at);

CREATE TABLE maintenance_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ran_at INTEGER NOT NULL,
  trigger TEXT NOT NULL CHECK (trigger IN ('cron','manual')),
  trash_purged INTEGER,
  trash_failed INTEGER,
  trash_remaining INTEGER,
  orphans_count INTEGER,
  orphans_complete INTEGER,
  orphans_sample TEXT,
  error TEXT
);
```

- [ ] **Step 4: Update `moveToFolder`**

In `src/db/mutations.ts`, replace:

```ts
  const statements = [db.prepare("UPDATE messages SET folder = ? WHERE id = ?").bind(folder, messageId)];
```

with:

```ts
  // trashed_at date l'entrée en corbeille (point de départ de la purge planifiée) : il est
  // remis à l'heure courante à chaque entrée et effacé à chaque sortie.
  const statements = [
    db.prepare(
      `UPDATE messages
          SET folder = ?1,
              trashed_at = CASE WHEN ?1 = 'trash' THEN unixepoch() ELSE NULL END
        WHERE id = ?2`
    ).bind(folder, messageId),
  ];
```

- [ ] **Step 5: Run to verify pass, then the full Worker suite**

Run: `pnpm vitest run test/api/mutations.test.ts` → PASS.
Run: `pnpm vitest run` → PASS (no other test depends on the old statement).

- [ ] **Step 6: Commit**

```bash
git add migrations/0004_scheduled_maintenance.sql src/db/mutations.ts test/api/mutations.test.ts
git commit -m "feat(db): date trash entries and add maintenance_runs"
```

---

### Task 2: Trash purge task

**Files:**
- Create: `src/maintenance/trash.ts`
- Modify: `src/env.ts` (add `TRASH_RETENTION_DAYS`), `wrangler.jsonc` (`vars`)
- Test: `test/maintenance/trash.test.ts`

**Interfaces:**
- Consumes: `purgeMessage(env: Env, messageId: number): Promise<boolean>` from `src/db/mutations.ts`; `messages.trashed_at` from Task 1.
- Produces:
  - `export const TRASH_PURGE_BATCH = 100`
  - `export function retentionDays(env: { TRASH_RETENTION_DAYS?: unknown }): number | null`
  - `export type TrashPurgeResult = { purged: number; failed: number; remaining: number }`
  - `export async function purgeExpiredTrash(env: Env, now: number, days: number, batch?: number): Promise<TrashPurgeResult>` (`now` in seconds)

- [ ] **Step 1: Add the variable**

`src/env.ts`, after `MAIL_DOMAIN: string;`:

```ts
  // Jours de conservation de la corbeille avant purge planifiée. "0", absente ou invalide :
  // purge désactivée (voir retentionDays dans src/maintenance/trash.ts).
  TRASH_RETENTION_DAYS?: string;
```

`wrangler.jsonc`, in `vars`, after `"MAIL_DOMAIN": "example.com"` (add the comma):

```jsonc
    "MAIL_DOMAIN": "example.com",
    // Jours avant qu'un message de la corbeille soit supprimé définitivement par la
    // maintenance planifiée. "0" désactive la purge. Surchargeable dans
    // wrangler.overrides.json.
    "TRASH_RETENTION_DAYS": "30"
```

- [ ] **Step 2: Write the failing tests**

`test/maintenance/trash.test.ts`:

```ts
import { env, applyD1Migrations } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../../src/env";
import { purgeExpiredTrash, retentionDays } from "../../src/maintenance/trash";

interface TestEnv {
  TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
}

const testEnv = env as unknown as TestEnv;
const workerEnv = env as unknown as Env;
const DAY = 86_400;
const NOW = 1_800_000_000;

beforeAll(async () => {
  await applyD1Migrations(env.DB, testEnv.TEST_MIGRATIONS);
});

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM attachments"),
    env.DB.prepare("DELETE FROM recipients"),
    env.DB.prepare("DELETE FROM messages"),
    env.DB.prepare("DELETE FROM threads"),
  ]);
  let cursor: string | undefined;
  do {
    const page = await env.MAIL.list({ cursor });
    if (page.objects.length > 0) await env.MAIL.delete(page.objects.map((o) => o.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
});

let seq = 0;
// Un message avec son thread et son brut R2 (sauf clé sent/…, qui n'a jamais d'objet).
const insertMessage = async (opts: { folder: "inbox" | "sent" | "trash"; trashedAt: number | null; rawKey?: string }) => {
  seq++;
  const rawKey = opts.rawKey ?? `raw/${String(seq).padStart(64, "0")}.eml`;
  if (rawKey.startsWith("raw/")) await env.MAIL.put(rawKey, `Subject: ${seq}\r\n\r\ncorps\r\n`);
  const thread = await env.DB.prepare(
    "INSERT INTO threads (subject_norm, last_message_at, message_count, unread_count) VALUES ('x', 0, 0, 0)"
  ).run();
  const res = await env.DB.prepare(
    `INSERT INTO messages (thread_id, message_id, direction, folder, from_addr, received_at, raw_key, trashed_at)
     VALUES (?, ?, 'in', ?, 'zoe@example.com', 0, ?, ?)`
  ).bind(thread.meta.last_row_id, `<m${seq}@example.com>`, opts.folder, rawKey, opts.trashedAt).run();
  return { id: Number(res.meta.last_row_id), rawKey };
};

const exists = async (id: number) =>
  (await env.DB.prepare("SELECT id FROM messages WHERE id = ?").bind(id).first()) !== null;

describe("retentionDays", () => {
  it("lit un nombre de jours positif", () => {
    expect(retentionDays({ TRASH_RETENTION_DAYS: "30" })).toBe(30);
    expect(retentionDays({ TRASH_RETENTION_DAYS: " 7 " })).toBe(7);
  });

  it("accepte un nombre JSON posé dans wrangler.overrides.json", () => {
    expect(retentionDays({ TRASH_RETENTION_DAYS: 30 })).toBe(30);
  });

  it("désactive la purge pour 0, vide, absent ou invalide", () => {
    for (const value of ["0", "", "abc", "-5", "1.5", undefined]) {
      expect(retentionDays({ TRASH_RETENTION_DAYS: value })).toBeNull();
    }
  });
});

describe("purgeExpiredTrash", () => {
  it("purge un message à la corbeille depuis plus de N jours, pas les autres", async () => {
    const old = await insertMessage({ folder: "trash", trashedAt: NOW - 31 * DAY });
    const recent = await insertMessage({ folder: "trash", trashedAt: NOW - 29 * DAY });
    const inbox = await insertMessage({ folder: "inbox", trashedAt: null });
    const undated = await insertMessage({ folder: "trash", trashedAt: null });

    expect(await purgeExpiredTrash(workerEnv, NOW, 30)).toEqual({ purged: 1, failed: 0, remaining: 0 });

    expect(await exists(old.id)).toBe(false);
    expect(await env.MAIL.head(old.rawKey)).toBeNull();
    expect(await exists(recent.id)).toBe(true);
    expect(await exists(inbox.id)).toBe(true);
    expect(await exists(undated.id)).toBe(true);
  });

  it("purge un message envoyé dont le brut n'existe pas dans R2", async () => {
    const sent = await insertMessage({ folder: "trash", trashedAt: NOW - 31 * DAY, rawKey: "sent/42" });
    expect(await purgeExpiredTrash(workerEnv, NOW, 30)).toEqual({ purged: 1, failed: 0, remaining: 0 });
    expect(await exists(sent.id)).toBe(false);
  });

  it("s'arrête au plafond et compte ce qui reste", async () => {
    for (let i = 0; i < 3; i++) await insertMessage({ folder: "trash", trashedAt: NOW - 40 * DAY + i });
    expect(await purgeExpiredTrash(workerEnv, NOW, 30, 2)).toEqual({ purged: 2, failed: 0, remaining: 1 });
  });

  it("purge les plus anciens d'abord", async () => {
    const newer = await insertMessage({ folder: "trash", trashedAt: NOW - 35 * DAY });
    const older = await insertMessage({ folder: "trash", trashedAt: NOW - 50 * DAY });
    await purgeExpiredTrash(workerEnv, NOW, 30, 1);
    expect(await exists(older.id)).toBe(false);
    expect(await exists(newer.id)).toBe(true);
  });

  it("continue après l'échec d'un message et le garde pour le prochain passage", async () => {
    const bad = await insertMessage({ folder: "trash", trashedAt: NOW - 40 * DAY });
    const good = await insertMessage({ folder: "trash", trashedAt: NOW - 39 * DAY });
    const brokenMail = {
      delete: async (keys: string | string[]) => {
        const list = Array.isArray(keys) ? keys : [keys];
        if (list.includes(bad.rawKey)) throw new Error("R2 indisponible");
        return env.MAIL.delete(list);
      },
    } as unknown as R2Bucket;

    const res = await purgeExpiredTrash({ ...workerEnv, MAIL: brokenMail }, NOW, 30);

    expect(res).toEqual({ purged: 1, failed: 1, remaining: 1 });
    expect(await exists(bad.id)).toBe(true);
    expect(await exists(good.id)).toBe(false);
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `pnpm vitest run test/maintenance/trash.test.ts`
Expected: FAIL — cannot resolve `../../src/maintenance/trash`.

- [ ] **Step 4: Implement**

`src/maintenance/trash.ts`:

```ts
import type { Env } from "../env";
import { purgeMessage } from "../db/mutations";

// Plafond par passage : le plan gratuit limite le temps CPU d'une invocation. Le reste
// part au passage suivant.
export const TRASH_PURGE_BATCH = 100;

const DAY = 86_400;

// Nombre de jours de conservation, ou null si la purge est désactivée. Une valeur absente
// ou illisible ne supprime jamais rien. String() couvre un nombre JSON posé dans
// wrangler.overrides.json.
export function retentionDays(env: { TRASH_RETENTION_DAYS?: unknown }): number | null {
  const raw = String(env.TRASH_RETENTION_DAYS ?? "").trim();
  if (!/^\d+$/.test(raw)) return null;
  const days = Number(raw);
  return days > 0 ? days : null;
}

export type TrashPurgeResult = { purged: number; failed: number; remaining: number };

// Purge les messages entrés en corbeille avant now − days, les plus anciens d'abord, via
// purgeMessage : l'ordre R2 puis D1 est conservé, et un échec laisse la ligne en place
// pour le passage suivant. `now` en secondes.
export async function purgeExpiredTrash(
  env: Env,
  now: number,
  days: number,
  batch = TRASH_PURGE_BATCH,
): Promise<TrashPurgeResult> {
  const cutoff = now - days * DAY;
  const expired = `FROM messages WHERE folder = 'trash' AND trashed_at IS NOT NULL AND trashed_at < ?`;

  const rows = await env.DB.prepare(`SELECT id ${expired} ORDER BY trashed_at, id LIMIT ?`)
    .bind(cutoff, batch).all<{ id: number }>();

  let purged = 0;
  let failed = 0;
  for (const { id } of rows.results) {
    try {
      if (await purgeMessage(env, id)) purged++;
    } catch (err) {
      failed++;
      console.error(JSON.stringify({
        event: "maintenance_purge_failed",
        messageId: id,
        error: err instanceof Error ? err.message : String(err),
      }));
    }
  }

  const left = await env.DB.prepare(`SELECT COUNT(*) AS n ${expired}`).bind(cutoff).first<{ n: number }>();
  return { purged, failed, remaining: left?.n ?? 0 };
}
```

- [ ] **Step 5: Run to verify pass, typecheck**

Run: `pnpm vitest run test/maintenance/trash.test.ts` → PASS.
Run: `pnpm typecheck` → no errors.

- [ ] **Step 6: Commit**

```bash
git add src/maintenance/trash.ts src/env.ts wrangler.jsonc test/maintenance/trash.test.ts
git commit -m "feat(maintenance): purge trash older than TRASH_RETENTION_DAYS"
```

---

### Task 3: Orphan check task

**Files:**
- Create: `src/maintenance/orphans.ts`
- Test: `test/maintenance/orphans.test.ts`

**Interfaces:**
- Consumes: `listOrphans(env, { cursor?: string; limit?: number }): Promise<{ orphans: { key: string; size: number; uploaded: string }[]; cursor: string | null }>` and `ORPHAN_PAGE_SIZE` from `src/admin/reimport.ts`.
- Produces:
  - `export const ORPHAN_CHECK_MAX_PAGES = 20`, `export const ORPHAN_SAMPLE_SIZE = 20`
  - `export type OrphanCheck = { count: number; complete: boolean; sample: string[] }`
  - `export async function checkOrphans(env: Env, opts?: { pageSize?: number; maxPages?: number }): Promise<OrphanCheck>` (throws on R2/D1 failure; the caller catches)

- [ ] **Step 1: Write the failing tests**

`test/maintenance/orphans.test.ts`:

```ts
import { env, applyD1Migrations } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../../src/env";
import { checkOrphans } from "../../src/maintenance/orphans";

interface TestEnv {
  TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
}

const testEnv = env as unknown as TestEnv;
const workerEnv = env as unknown as Env;

beforeAll(async () => {
  await applyD1Migrations(env.DB, testEnv.TEST_MIGRATIONS);
});

beforeEach(async () => {
  await env.DB.batch([env.DB.prepare("DELETE FROM messages"), env.DB.prepare("DELETE FROM threads")]);
  let cursor: string | undefined;
  do {
    const page = await env.MAIL.list({ cursor });
    if (page.objects.length > 0) await env.MAIL.delete(page.objects.map((o) => o.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
});

const key = (n: number) => `raw/${String(n).padStart(64, "0")}.eml`;
const putRaw = async (n: number) => env.MAIL.put(key(n), `Subject: ${n}\r\n\r\ncorps\r\n`);

const insertKnown = async (n: number) => {
  const thread = await env.DB.prepare(
    "INSERT INTO threads (subject_norm, last_message_at) VALUES ('x', 0)"
  ).run();
  await env.DB.prepare(
    `INSERT INTO messages (thread_id, message_id, direction, folder, from_addr, received_at, raw_key)
     VALUES (?, ?, 'in', 'inbox', 'zoe@example.com', 0, ?)`
  ).bind(thread.meta.last_row_id, `<k${n}@example.com>`, key(n)).run();
};

describe("checkOrphans", () => {
  it("compte les bruts sans ligne D1 sur toutes les pages", async () => {
    for (let n = 1; n <= 5; n++) await putRaw(n);
    await insertKnown(3);

    const res = await checkOrphans(workerEnv, { pageSize: 2 });

    expect(res).toEqual({ count: 4, complete: true, sample: [key(1), key(2), key(4), key(5)] });
  });

  it("signale une vérification partielle quand le plafond de pages est atteint", async () => {
    for (let n = 1; n <= 5; n++) await putRaw(n);

    const res = await checkOrphans(workerEnv, { pageSize: 2, maxPages: 2 });

    expect(res).toEqual({ count: 4, complete: false, sample: [key(1), key(2), key(3), key(4)] });
  });

  it("limite l'échantillon à 20 clés", async () => {
    for (let n = 1; n <= 25; n++) await putRaw(n);

    const res = await checkOrphans(workerEnv);

    expect(res.count).toBe(25);
    expect(res.sample).toHaveLength(20);
  });

  it("renvoie zéro sur un stockage vide", async () => {
    expect(await checkOrphans(workerEnv)).toEqual({ count: 0, complete: true, sample: [] });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run test/maintenance/orphans.test.ts`
Expected: FAIL — cannot resolve `../../src/maintenance/orphans`.

- [ ] **Step 3: Implement**

`src/maintenance/orphans.ts`:

```ts
import type { Env } from "../env";
import { ORPHAN_PAGE_SIZE, listOrphans } from "../admin/reimport";

// 20 pages de 500 objets : au-delà, le compte est un minimum (complete = false). Le plan
// gratuit limite le temps CPU d'une invocation.
export const ORPHAN_CHECK_MAX_PAGES = 20;
export const ORPHAN_SAMPLE_SIZE = 20;

export type OrphanCheck = { count: number; complete: boolean; sample: string[] };

// Compte les bruts de raw/ sans ligne D1. Ne réimporte rien et ne supprime rien : la
// récupération reste une action de l'utilisateur dans la vue Maintenance.
export async function checkOrphans(
  env: Env,
  opts: { pageSize?: number; maxPages?: number } = {},
): Promise<OrphanCheck> {
  const maxPages = opts.maxPages ?? ORPHAN_CHECK_MAX_PAGES;
  const sample: string[] = [];
  let count = 0;
  let cursor: string | undefined;

  for (let page = 0; page < maxPages; page++) {
    const res = await listOrphans(env, { cursor, limit: opts.pageSize ?? ORPHAN_PAGE_SIZE });
    count += res.orphans.length;
    for (const o of res.orphans) {
      if (sample.length < ORPHAN_SAMPLE_SIZE) sample.push(o.key);
    }
    if (res.cursor === null) return { count, complete: true, sample };
    cursor = res.cursor;
  }
  return { count, complete: false, sample };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm vitest run test/maintenance/orphans.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/maintenance/orphans.ts test/maintenance/orphans.test.ts
git commit -m "feat(maintenance): bounded orphan count over the raw/ prefix"
```

---

### Task 4: Run orchestration, recording and the `scheduled()` handler

**Files:**
- Create: `src/maintenance/runs.ts`, `src/maintenance/run.ts`
- Modify: `src/index.ts` (default export), `wrangler.jsonc` (`triggers`)
- Test: `test/maintenance/run.test.ts`

**Interfaces:**
- Consumes: `retentionDays`, `purgeExpiredTrash` (Task 2); `checkOrphans` (Task 3); table `maintenance_runs` (Task 1).
- Produces (`src/maintenance/runs.ts`):
  - `export type MaintenanceTrigger = "cron" | "manual"`
  - `export type MaintenanceRun = { id: number; ranAt: number; trigger: MaintenanceTrigger; trashPurged: number | null; trashFailed: number | null; trashRemaining: number | null; orphansCount: number | null; orphansComplete: boolean | null; orphansSample: string[]; error: string | null }`
  - `export type NewMaintenanceRun = Omit<MaintenanceRun, "id">`
  - `export const MAINTENANCE_RUNS_KEPT = 30`
  - `export async function recordRun(env: Env, run: NewMaintenanceRun): Promise<MaintenanceRun>`
  - `export async function latestRuns(env: Env): Promise<{ lastRun: MaintenanceRun | null; lastCheck: MaintenanceRun | null }>`
- Produces (`src/maintenance/run.ts`):
  - `export async function runMaintenance(env: Env, now: number): Promise<MaintenanceRun | null>` (never throws; `null` = not recorded)
  - `export async function runOrphanCheck(env: Env, now: number): Promise<MaintenanceRun | null>` (never throws)
- Produces (`src/index.ts`): default export gains `scheduled`.

- [ ] **Step 1: Write the failing tests**

`test/maintenance/run.test.ts`:

```ts
import { env, applyD1Migrations, createExecutionContext, createScheduledController, waitOnExecutionContext } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../../src/env";
import worker from "../../src/index";
import { runMaintenance, runOrphanCheck } from "../../src/maintenance/run";
import { MAINTENANCE_RUNS_KEPT, latestRuns, recordRun, type NewMaintenanceRun } from "../../src/maintenance/runs";

interface TestEnv {
  TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
}

const testEnv = env as unknown as TestEnv;
const workerEnv = env as unknown as Env;
const DAY = 86_400;
const NOW = 1_800_000_000;

beforeAll(async () => {
  await applyD1Migrations(env.DB, testEnv.TEST_MIGRATIONS);
});

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM maintenance_runs"),
    env.DB.prepare("DELETE FROM attachments"),
    env.DB.prepare("DELETE FROM recipients"),
    env.DB.prepare("DELETE FROM messages"),
    env.DB.prepare("DELETE FROM threads"),
  ]);
  let cursor: string | undefined;
  do {
    const page = await env.MAIL.list({ cursor });
    if (page.objects.length > 0) await env.MAIL.delete(page.objects.map((o) => o.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
});

const key = (n: number) => `raw/${String(n).padStart(64, "0")}.eml`;

let seq = 0;
const insertTrashed = async (trashedAt: number) => {
  seq++;
  await env.MAIL.put(key(1000 + seq), "Subject: x\r\n\r\ncorps\r\n");
  const thread = await env.DB.prepare("INSERT INTO threads (subject_norm, last_message_at) VALUES ('x', 0)").run();
  await env.DB.prepare(
    `INSERT INTO messages (thread_id, message_id, direction, folder, from_addr, received_at, raw_key, trashed_at)
     VALUES (?, ?, 'in', 'trash', 'zoe@example.com', 0, ?, ?)`
  ).bind(thread.meta.last_row_id, `<t${seq}@example.com>`, key(1000 + seq), trashedAt).run();
};

const blank = (over: Partial<NewMaintenanceRun> = {}): NewMaintenanceRun => ({
  ranAt: NOW, trigger: "cron", trashPurged: null, trashFailed: null, trashRemaining: null,
  orphansCount: null, orphansComplete: null, orphansSample: [], error: null, ...over,
});

// D1 dont prepare() lève pour les requêtes contenant `needle` ; le reste passe au vrai D1.
const failingDb = (needle: string) =>
  new Proxy(env.DB, {
    get(target, prop) {
      if (prop === "prepare") {
        return (sql: string) => {
          if (sql.includes(needle)) throw new Error("D1 indisponible");
          return target.prepare(sql);
        };
      }
      const value = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });

describe("runMaintenance", () => {
  it("purge la corbeille expirée, compte les orphelins et enregistre un passage cron", async () => {
    await insertTrashed(NOW - 31 * DAY);
    await env.MAIL.put(key(1), "Subject: orphelin\r\n\r\ncorps\r\n");

    const run = await runMaintenance(workerEnv, NOW);

    expect(run).toMatchObject({
      ranAt: NOW, trigger: "cron", trashPurged: 1, trashFailed: 0, trashRemaining: 0,
      orphansCount: 1, orphansComplete: true, orphansSample: [key(1)], error: null,
    });
    const { n } = (await env.DB.prepare("SELECT COUNT(*) AS n FROM maintenance_runs").first<{ n: number }>())!;
    expect(n).toBe(1);
  });

  it("ne purge rien quand la rétention est désactivée", async () => {
    await insertTrashed(NOW - 400 * DAY);

    const run = await runMaintenance({ ...workerEnv, TRASH_RETENTION_DAYS: "0" }, NOW);

    expect(run).toMatchObject({ trashPurged: null, orphansCount: 0, error: null });
    const { n } = (await env.DB.prepare("SELECT COUNT(*) AS n FROM messages").first<{ n: number }>())!;
    expect(n).toBe(1);
  });

  it("vérifie les orphelins même si la purge échoue", async () => {
    await env.MAIL.put(key(1), "Subject: orphelin\r\n\r\ncorps\r\n");

    const run = await runMaintenance({ ...workerEnv, DB: failingDb("trashed_at <") }, NOW);

    expect(run).toMatchObject({ trashPurged: null, orphansCount: 1 });
    expect(run?.error).toMatch(/^trash: /);
  });

  it("purge même si la vérification des orphelins échoue", async () => {
    await insertTrashed(NOW - 31 * DAY);
    const brokenMail = {
      list: async () => { throw new Error("R2 indisponible"); },
      delete: (keys: string | string[]) => env.MAIL.delete(keys),
    } as unknown as R2Bucket;

    const run = await runMaintenance({ ...workerEnv, MAIL: brokenMail }, NOW);

    expect(run).toMatchObject({ trashPurged: 1, orphansCount: null, orphansComplete: null });
    expect(run?.error).toMatch(/orphans: R2 indisponible/);
  });

  it("ne lève pas quand l'enregistrement échoue", async () => {
    const run = await runMaintenance({ ...workerEnv, DB: failingDb("maintenance_runs") }, NOW);
    expect(run).toBeNull();
  });
});

describe("runOrphanCheck", () => {
  it("n'exécute que la vérification et enregistre un passage manuel", async () => {
    await insertTrashed(NOW - 400 * DAY);

    const run = await runOrphanCheck(workerEnv, NOW);

    expect(run).toMatchObject({ trigger: "manual", trashPurged: null, orphansCount: 0 });
    const { n } = (await env.DB.prepare("SELECT COUNT(*) AS n FROM messages").first<{ n: number }>())!;
    expect(n).toBe(1);
  });
});

describe("recordRun / latestRuns", () => {
  it(`ne garde que les ${MAINTENANCE_RUNS_KEPT} derniers passages`, async () => {
    for (let i = 0; i < MAINTENANCE_RUNS_KEPT + 2; i++) await recordRun(workerEnv, blank({ ranAt: i }));
    const rows = await env.DB.prepare("SELECT ran_at FROM maintenance_runs ORDER BY id").all<{ ran_at: number }>();
    expect(rows.results).toHaveLength(MAINTENANCE_RUNS_KEPT);
    expect(rows.results[0].ran_at).toBe(2);
  });

  it("distingue le dernier passage planifié de la dernière vérification réussie", async () => {
    await recordRun(workerEnv, blank({ ranAt: 1, trigger: "cron", trashPurged: 4, orphansCount: 2, orphansComplete: true }));
    await recordRun(workerEnv, blank({ ranAt: 2, trigger: "manual", orphansCount: 0, orphansComplete: true }));
    await recordRun(workerEnv, blank({ ranAt: 3, trigger: "manual", error: "orphans: R2 indisponible" }));

    const { lastRun, lastCheck } = await latestRuns(workerEnv);

    expect(lastRun).toMatchObject({ ranAt: 1, trigger: "cron", trashPurged: 4 });
    expect(lastCheck).toMatchObject({ ranAt: 2, trigger: "manual", orphansCount: 0, orphansComplete: true });
  });

  it("renvoie null sans passage enregistré", async () => {
    expect(await latestRuns(workerEnv)).toEqual({ lastRun: null, lastCheck: null });
  });

  it("renvoie null si la migration n'est pas appliquée", async () => {
    const db = { batch: async () => { throw new Error("D1_ERROR: no such table: maintenance_runs: SQLITE_ERROR"); }, prepare: (sql: string) => env.DB.prepare(sql) } as unknown as D1Database;
    expect(await latestRuns({ ...workerEnv, DB: db })).toEqual({ lastRun: null, lastCheck: null });
  });
});

describe("scheduled()", () => {
  it("enregistre un passage à l'heure planifiée", async () => {
    const ctrl = createScheduledController({ scheduledTime: new Date(NOW * 1000), cron: "17 3 * * *" });
    const ctx = createExecutionContext();

    await worker.scheduled!(ctrl, workerEnv, ctx);
    await waitOnExecutionContext(ctx);

    const row = await env.DB.prepare("SELECT ran_at, trigger FROM maintenance_runs").first<{ ran_at: number; trigger: string }>();
    expect(row).toEqual({ ran_at: NOW, trigger: "cron" });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run test/maintenance/run.test.ts`
Expected: FAIL — cannot resolve `../../src/maintenance/run`.

- [ ] **Step 3: Implement recording**

`src/maintenance/runs.ts`:

```ts
import type { Env } from "../env";

export type MaintenanceTrigger = "cron" | "manual";

export type MaintenanceRun = {
  id: number;
  ranAt: number;
  trigger: MaintenanceTrigger;
  // null : purge non exécutée (vérification manuelle, ou rétention désactivée, ou échec).
  trashPurged: number | null;
  trashFailed: number | null;
  trashRemaining: number | null;
  // null : vérification en échec.
  orphansCount: number | null;
  orphansComplete: boolean | null;
  orphansSample: string[];
  error: string | null;
};

export type NewMaintenanceRun = Omit<MaintenanceRun, "id">;

export const MAINTENANCE_RUNS_KEPT = 30;

type Row = {
  id: number;
  ran_at: number;
  trigger: MaintenanceTrigger;
  trash_purged: number | null;
  trash_failed: number | null;
  trash_remaining: number | null;
  orphans_count: number | null;
  orphans_complete: number | null;
  orphans_sample: string | null;
  error: string | null;
};

const toRun = (r: Row): MaintenanceRun => ({
  id: r.id,
  ranAt: r.ran_at,
  trigger: r.trigger,
  trashPurged: r.trash_purged,
  trashFailed: r.trash_failed,
  trashRemaining: r.trash_remaining,
  orphansCount: r.orphans_count,
  orphansComplete: r.orphans_complete === null ? null : r.orphans_complete === 1,
  orphansSample: r.orphans_sample ? (JSON.parse(r.orphans_sample) as string[]) : [],
  error: r.error,
});

// Insère le passage et ne garde que les MAINTENANCE_RUNS_KEPT plus récents, en un lot.
export async function recordRun(env: Env, run: NewMaintenanceRun): Promise<MaintenanceRun> {
  const [inserted] = await env.DB.batch<Row>([
    env.DB.prepare(
      `INSERT INTO maintenance_runs
         (ran_at, trigger, trash_purged, trash_failed, trash_remaining,
          orphans_count, orphans_complete, orphans_sample, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       RETURNING *`
    ).bind(
      run.ranAt, run.trigger, run.trashPurged, run.trashFailed, run.trashRemaining,
      run.orphansCount, run.orphansComplete === null ? null : run.orphansComplete ? 1 : 0,
      JSON.stringify(run.orphansSample), run.error,
    ),
    env.DB.prepare(
      "DELETE FROM maintenance_runs WHERE id NOT IN (SELECT id FROM maintenance_runs ORDER BY id DESC LIMIT ?)"
    ).bind(MAINTENANCE_RUNS_KEPT),
  ]);
  return toRun(inserted.results[0]);
}

// lastRun : dernier passage planifié (ce qu'a fait la dernière nuit). lastCheck : dernière
// vérification des orphelins réussie, planifiée ou manuelle. Deux champs, car une
// vérification manuelle écrit une ligne sans colonnes de corbeille qui ne doit pas masquer
// la dernière purge. Sans la migration, « jamais passé » plutôt qu'une erreur.
export async function latestRuns(env: Env): Promise<{ lastRun: MaintenanceRun | null; lastCheck: MaintenanceRun | null }> {
  try {
    const [cron, check] = await env.DB.batch<Row>([
      env.DB.prepare("SELECT * FROM maintenance_runs WHERE trigger = 'cron' ORDER BY id DESC LIMIT 1"),
      env.DB.prepare("SELECT * FROM maintenance_runs WHERE orphans_count IS NOT NULL ORDER BY id DESC LIMIT 1"),
    ]);
    return {
      lastRun: cron.results[0] ? toRun(cron.results[0]) : null,
      lastCheck: check.results[0] ? toRun(check.results[0]) : null,
    };
  } catch (err) {
    if (err instanceof Error && err.message.includes("no such table")) return { lastRun: null, lastCheck: null };
    throw err;
  }
}
```

- [ ] **Step 4: Implement orchestration**

`src/maintenance/run.ts`:

```ts
import type { Env } from "../env";
import { checkOrphans } from "./orphans";
import { recordRun, type MaintenanceRun, type MaintenanceTrigger, type NewMaintenanceRun } from "./runs";
import { purgeExpiredTrash, retentionDays } from "./trash";

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

const blankRun = (now: number, trigger: MaintenanceTrigger): NewMaintenanceRun => ({
  ranAt: now, trigger, trashPurged: null, trashFailed: null, trashRemaining: null,
  orphansCount: null, orphansComplete: null, orphansSample: [], error: null,
});

async function trashStep(env: Env, now: number, run: NewMaintenanceRun, errors: string[]): Promise<void> {
  const days = retentionDays(env);
  if (days === null) {
    console.log(JSON.stringify({ event: "maintenance_trash_disabled", value: env.TRASH_RETENTION_DAYS ?? null }));
    return;
  }
  try {
    const res = await purgeExpiredTrash(env, now, days);
    run.trashPurged = res.purged;
    run.trashFailed = res.failed;
    run.trashRemaining = res.remaining;
  } catch (err) {
    errors.push(`trash: ${errorMessage(err)}`);
  }
}

async function orphanStep(env: Env, run: NewMaintenanceRun, errors: string[]): Promise<void> {
  try {
    const res = await checkOrphans(env);
    run.orphansCount = res.count;
    run.orphansComplete = res.complete;
    run.orphansSample = res.sample;
  } catch (err) {
    errors.push(`orphans: ${errorMessage(err)}`);
  }
}

// Enregistre le passage et écrit une ligne de log, même si l'enregistrement échoue.
async function finish(env: Env, run: NewMaintenanceRun, errors: string[]): Promise<MaintenanceRun | null> {
  run.error = errors.length > 0 ? errors.join("; ") : null;
  let recorded: MaintenanceRun | null = null;
  let recordError: string | null = null;
  try {
    recorded = await recordRun(env, run);
  } catch (err) {
    recordError = errorMessage(err);
  }
  const line = JSON.stringify({
    event: "maintenance",
    trigger: run.trigger,
    trashPurged: run.trashPurged,
    trashFailed: run.trashFailed,
    trashRemaining: run.trashRemaining,
    orphansCount: run.orphansCount,
    orphansComplete: run.orphansComplete,
    error: run.error,
    recordError,
  });
  if (run.error || recordError) console.error(line);
  else console.log(line);
  return recorded;
}

// Passage planifié : purge de la corbeille puis vérification des orphelins, chacune
// rattrapant ses propres erreurs. Ne lève jamais ; null si le passage n'a pas pu être
// enregistré (la ligne de log part quand même). `now` en secondes.
export async function runMaintenance(env: Env, now: number): Promise<MaintenanceRun | null> {
  const run = blankRun(now, "cron");
  const errors: string[] = [];
  await trashStep(env, now, run, errors);
  await orphanStep(env, run, errors);
  return finish(env, run, errors);
}

// Vérification à la demande depuis la vue Maintenance : jamais de purge.
export async function runOrphanCheck(env: Env, now: number): Promise<MaintenanceRun | null> {
  const run = blankRun(now, "manual");
  const errors: string[] = [];
  await orphanStep(env, run, errors);
  return finish(env, run, errors);
}
```

- [ ] **Step 5: Wire `scheduled()` and the cron**

`src/index.ts`: add `import { runMaintenance } from "./maintenance/run";` next to the other imports, and replace the default export with:

```ts
export default {
  fetch: app.fetch,
  email: handleEmail,
  // runMaintenance ne lève jamais : un échec devient la colonne error du passage, visible
  // dans la vue Maintenance, plutôt qu'un échec du déclencheur Cron que personne ne regarde.
  scheduled: (controller, env, ctx) => {
    ctx.waitUntil(runMaintenance(env, Math.floor(controller.scheduledTime / 1000)));
  },
} satisfies ExportedHandler<Env>;
```

`wrangler.jsonc`, after the `"observability"` line:

```jsonc
  // Maintenance planifiée (src/maintenance/run.ts), une fois par nuit. Le plan gratuit
  // n'autorise qu'un déclencheur Cron par Worker : les deux tâches le partagent.
  "triggers": { "crons": ["17 3 * * *"] },
```

- [ ] **Step 6: Run to verify pass, full suite, typecheck**

Run: `pnpm vitest run test/maintenance/run.test.ts` → PASS.
Run: `pnpm vitest run` → PASS.
Run: `pnpm typecheck` → no errors.

- [ ] **Step 7: Commit**

```bash
git add src/maintenance/runs.ts src/maintenance/run.ts src/index.ts wrangler.jsonc test/maintenance/run.test.ts
git commit -m "feat(maintenance): nightly cron that purges trash and checks orphans"
```

---

### Task 5: Admin routes and `trashRetentionDays` in `/api/config`

**Files:**
- Modify: `src/api/routes.ts` (imports; `/config` route; new routes after `/admin/parse-errors`)
- Modify: `test/api/forwarding.test.ts` (`GET /api/config` expectation)
- Test: `test/api/maintenance.test.ts`

**Interfaces:**
- Consumes: `retentionDays` (Task 2), `latestRuns`, `MaintenanceRun` (Task 4), `runOrphanCheck` (Task 4), existing `storageUnavailableResponse(path, err)` in `routes.ts`.
- Produces:
  - `GET /api/config` → `{ mailDomain: string; trashRetentionDays: number | null }`
  - `GET /api/admin/maintenance` → `{ retentionDays: number | null; lastRun: MaintenanceRun | null; lastCheck: MaintenanceRun | null }`, or 503 `storage_unavailable`
  - `POST /api/admin/maintenance/orphan-check` → `MaintenanceRun` (200), or 503 `storage_unavailable` when the check failed or was not recorded

- [ ] **Step 1: Write the failing tests**

`test/api/maintenance.test.ts`:

```ts
import { env, applyD1Migrations } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { app } from "../../src/index";

interface TestEnv {
  TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
}

const testEnv = env as unknown as TestEnv;

beforeAll(async () => {
  await applyD1Migrations(env.DB, testEnv.TEST_MIGRATIONS);
});

beforeEach(async () => {
  await env.DB.batch([env.DB.prepare("DELETE FROM maintenance_runs"), env.DB.prepare("DELETE FROM messages")]);
  let cursor: string | undefined;
  do {
    const page = await env.MAIL.list({ cursor });
    if (page.objects.length > 0) await env.MAIL.delete(page.objects.map((o) => o.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
});

const req = (path: string, init?: RequestInit, over: Record<string, unknown> = {}) =>
  app.request(`https://example.com${path}`, init ?? {}, { ...env, DEV_BYPASS_AUTH: "1", ...over });

const brokenMail = { list: async () => { throw new Error("R2 indisponible"); } };

describe("accès", () => {
  it("refuse les routes de maintenance sans jeton Access", async () => {
    const res = await app.request("https://example.com/api/admin/maintenance", {}, { ...env, DEV_BYPASS_AUTH: "" });
    expect(res.status).toBe(401);
  });
});

describe("GET /api/admin/maintenance", () => {
  it("renvoie la rétention et aucun passage sur une base neuve", async () => {
    const res = await req("/api/admin/maintenance");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ retentionDays: 30, lastRun: null, lastCheck: null });
  });

  it("indique une purge désactivée", async () => {
    const res = await req("/api/admin/maintenance", {}, { TRASH_RETENTION_DAYS: "0" });
    expect(await res.json()).toMatchObject({ retentionDays: null });
  });

  it("renvoie 503 si D1 est indisponible", async () => {
    const brokenDb = { batch: async () => { throw new Error("D1 indisponible"); } };
    const res = await req("/api/admin/maintenance", {}, { DB: brokenDb });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: { code: "storage_unavailable" } });
  });
});

describe("POST /api/admin/maintenance/orphan-check", () => {
  it("vérifie les orphelins et l'expose comme dernière vérification", async () => {
    await env.MAIL.put(`raw/${"a".repeat(64)}.eml`, "Subject: x\r\n\r\ncorps\r\n");

    const res = await req("/api/admin/maintenance/orphan-check", { method: "POST" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ trigger: "manual", orphansCount: 1, orphansComplete: true, trashPurged: null });

    const status = await (await req("/api/admin/maintenance")).json();
    expect(status).toMatchObject({ lastRun: null, lastCheck: { orphansCount: 1 } });
  });

  it("renvoie 503 si la vérification échoue, sans masquer la précédente", async () => {
    await req("/api/admin/maintenance/orphan-check", { method: "POST" });

    const res = await req("/api/admin/maintenance/orphan-check", { method: "POST" }, { MAIL: brokenMail });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: { code: "storage_unavailable" } });

    const status = await (await req("/api/admin/maintenance")).json();
    expect(status).toMatchObject({ lastCheck: { orphansCount: 0 } });
  });
});
```

In `test/api/forwarding.test.ts`, replace:

```ts
    expect(await res.json()).toEqual({ mailDomain: "example.com" });
```

with:

```ts
    expect(await res.json()).toEqual({ mailDomain: "example.com", trashRetentionDays: 30 });
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run test/api/maintenance.test.ts test/api/forwarding.test.ts`
Expected: FAIL — 404 on the new routes, and `trashRetentionDays` missing from `/config`.

- [ ] **Step 3: Implement**

`src/api/routes.ts`, add imports next to the `../admin/reimport` import:

```ts
import { runOrphanCheck } from "../maintenance/run";
import { latestRuns } from "../maintenance/runs";
import { retentionDays } from "../maintenance/trash";
```

Replace:

```ts
api.get("/config", (c) => c.json({ mailDomain: c.env.MAIL_DOMAIN }));
```

with:

```ts
api.get("/config", (c) => c.json({ mailDomain: c.env.MAIL_DOMAIN, trashRetentionDays: retentionDays(c.env) }));
```

After the `api.get("/admin/parse-errors", …)` route, add:

```ts
api.get("/admin/maintenance", async (c) => {
  try {
    return c.json({ retentionDays: retentionDays(c.env), ...(await latestRuns(c.env)) });
  } catch (err) {
    return storageUnavailableResponse("/admin/maintenance", err);
  }
});

// Vérification des orphelins à la demande, pour que le badge ne reste pas périmé après un
// réimport manuel. Jamais de purge ici : elle reste réservée au passage planifié. Un échec
// est enregistré (historique) mais renvoyé en 503, pour que l'interface l'affiche.
api.post("/admin/maintenance/orphan-check", async (c) => {
  const run = await runOrphanCheck(c.env, Math.floor(Date.now() / 1000));
  if (run === null || run.orphansCount === null) {
    return storageUnavailableResponse(
      "/admin/maintenance/orphan-check",
      new Error(run?.error ?? "maintenance run not recorded"),
    );
  }
  return c.json(run);
});
```

- [ ] **Step 4: Run to verify pass, full suite, typecheck**

Run: `pnpm vitest run test/api/maintenance.test.ts test/api/forwarding.test.ts` → PASS.
Run: `pnpm vitest run` → PASS.
Run: `pnpm typecheck` → no errors.

- [ ] **Step 5: Commit**

```bash
git add src/api/routes.ts test/api/maintenance.test.ts test/api/forwarding.test.ts
git commit -m "feat(api): expose scheduled maintenance status and a manual orphan check"
```

---

### Task 6: Scheduled maintenance card in the Maintenance view

**Files:**
- Modify: `web/src/api/client.ts` (`AppConfig`; new types and hooks after `useParseErrors`)
- Modify: `web/src/i18n/fr.ts`, `web/src/i18n/en.ts` (`maintenance.scheduled`)
- Modify: `web/src/components/MaintenanceSettings.tsx` (new `ScheduledPanel`; `OrphansPanel.reimportSelected`)
- Test: `web/src/components/MaintenanceSettings.test.tsx`

**Interfaces:**
- Consumes: the three routes of Task 5.
- Produces (`web/src/api/client.ts`):
  - `export type AppConfig = { mailDomain: string; trashRetentionDays: number | null }`
  - `export type MaintenanceRun = { id: number; ranAt: number; trigger: "cron" | "manual"; trashPurged: number | null; trashFailed: number | null; trashRemaining: number | null; orphansCount: number | null; orphansComplete: boolean | null; orphansSample: string[]; error: string | null }`
  - `export type MaintenanceStatus = { retentionDays: number | null; lastRun: MaintenanceRun | null; lastCheck: MaintenanceRun | null }`
  - `export const useMaintenance: () => UseQueryResult<MaintenanceStatus>` (query key `["maintenance"]`)
  - `export const useOrphanCheck: () => UseMutationResult<MaintenanceRun, Error, void>` (invalidates `["maintenance"]`)
- Produces (i18n, both catalogues): `t.maintenance.scheduled.orphansFound(n: number): string` — reused by Task 7's badge.

- [ ] **Step 1: Write the failing tests**

In `web/src/components/MaintenanceSettings.test.tsx`, extend `Stub` and `stubApi`. Add to the `Stub` type:

```ts
  maintenance?: unknown;
  orphanCheck?: { status: number; body: unknown };
```

and change `stubApi` so it records every call and answers the new routes **before** the existing `/api/admin/orphans` branch:

```ts
const stubApi = (opts: Stub) => {
  const posts: string[][] = [];
  const calls: string[] = [];
  const failed = new Set<string>();
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    calls.push(`${init?.method ?? "GET"} ${url}`);
    if (url === "/api/admin/maintenance/orphan-check") {
      const r = opts.orphanCheck ?? { status: 200, body: {} };
      return json(r.body, r.status);
    }
    if (url === "/api/admin/maintenance") {
      return json(opts.maintenance ?? { retentionDays: 30, lastRun: null, lastCheck: null });
    }
    // … existing branches unchanged …
  }));
  return Object.assign(posts, { calls });
};
```

(`posts` stays an array so existing tests that read `posts` keep working; new tests read `.calls`.)

Append:

```ts
const run = (over: Record<string, unknown> = {}) => ({
  id: 1, ranAt: 1_790_000_000, trigger: "cron", trashPurged: null, trashFailed: null, trashRemaining: null,
  orphansCount: 0, orphansComplete: true, orphansSample: [], error: null, ...over,
});

describe("MaintenanceSettings — maintenance planifiée", () => {
  it("indique qu'aucun passage n'a encore eu lieu", async () => {
    stubApi({});
    render(<MaintenanceSettings />, { wrapper });
    expect(await screen.findByText("Aucun passage planifié pour l'instant.")).toBeDefined();
    expect(screen.getByText("Stockage jamais vérifié.")).toBeDefined();
    expect(screen.getByText("La corbeille est vidée des messages de plus de 30 jours.")).toBeDefined();
  });

  it("résume le dernier passage et la dernière vérification", async () => {
    stubApi({
      maintenance: {
        retentionDays: 30,
        lastRun: run({ trashPurged: 12, trashFailed: 1, trashRemaining: 3 }),
        lastCheck: run({ orphansCount: 3 }),
      },
    });
    render(<MaintenanceSettings />, { wrapper });
    expect(await screen.findByText("12 messages supprimés de la corbeille")).toBeDefined();
    expect(screen.getByText("1 suppression en échec")).toBeDefined();
    expect(screen.getByText("3 messages restent à supprimer au prochain passage")).toBeDefined();
    expect(screen.getByText(/3 messages orphelins détectés/)).toBeDefined();
  });

  it("signale une vérification partielle", async () => {
    stubApi({ maintenance: { retentionDays: 30, lastRun: null, lastCheck: run({ orphansCount: 4, orphansComplete: false }) } });
    render(<MaintenanceSettings />, { wrapper });
    expect(await screen.findByText(/Vérification partielle : 4 orphelins parmi les 10 000 premiers objets/)).toBeDefined();
  });

  it("indique une purge désactivée et l'erreur du dernier passage", async () => {
    stubApi({ maintenance: { retentionDays: null, lastRun: run({ error: "orphans: R2 indisponible" }), lastCheck: null } });
    render(<MaintenanceSettings />, { wrapper });
    expect(await screen.findByText("Purge automatique de la corbeille désactivée.")).toBeDefined();
    expect(screen.getByText("Erreur lors du passage : orphans: R2 indisponible")).toBeDefined();
  });

  it("relance la vérification et rafraîchit l'état", async () => {
    const api = stubApi({ orphanCheck: { status: 200, body: run({ trigger: "manual" }) } });
    render(<MaintenanceSettings />, { wrapper });
    await userEvent.click(await screen.findByRole("button", { name: "Relancer la vérification" }));
    await waitFor(() =>
      expect(api.calls.filter((c) => c === "GET /api/admin/maintenance").length).toBeGreaterThanOrEqual(2),
    );
    expect(api.calls).toContain("POST /api/admin/maintenance/orphan-check");
  });

  it("affiche l'échec d'une vérification relancée", async () => {
    stubApi({ orphanCheck: { status: 503, body: { error: { code: "storage_unavailable", message: "x" } } } });
    render(<MaintenanceSettings />, { wrapper });
    await userEvent.click(await screen.findByRole("button", { name: "Relancer la vérification" }));
    expect(await screen.findByText("Stockage indisponible : réessayez dans un instant.")).toBeDefined();
  });

  it("relance la vérification après un réimport qui a importé un message", async () => {
    const api = stubApi({ orphanPages: { "": { orphans: [orphan(1)], cursor: null } } });
    render(<MaintenanceSettings />, { wrapper });
    await userEvent.click(screen.getByRole("button", { name: "Analyser le stockage" }));
    await userEvent.click(await screen.findByLabelText(`Sélectionner ${k(1)}`));
    await userEvent.click(screen.getByRole("button", { name: "Réimporter la sélection (1)" }));
    await waitFor(() => expect(api.calls).toContain("POST /api/admin/maintenance/orphan-check"));
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter web test -- src/components/MaintenanceSettings.test.tsx`
Expected: the new tests FAIL (text not found); existing tests still PASS.

- [ ] **Step 3: API client**

In `web/src/api/client.ts`, replace:

```ts
export type AppConfig = { mailDomain: string };
```

with:

```ts
export type AppConfig = { mailDomain: string; trashRetentionDays: number | null };
```

After `useParseErrors`, add:

```ts
// Miroir volontaire de MaintenanceRun dans src/maintenance/runs.ts.
export type MaintenanceRun = {
  id: number;
  ranAt: number;
  trigger: "cron" | "manual";
  trashPurged: number | null;
  trashFailed: number | null;
  trashRemaining: number | null;
  orphansCount: number | null;
  orphansComplete: boolean | null;
  orphansSample: string[];
  error: string | null;
};

export type MaintenanceStatus = {
  retentionDays: number | null;
  lastRun: MaintenanceRun | null;
  lastCheck: MaintenanceRun | null;
};

export const useMaintenance = () =>
  useQuery({ queryKey: ["maintenance"], queryFn: () => api<MaintenanceStatus>("/admin/maintenance") });

export const useOrphanCheck = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api<MaintenanceRun>("/admin/maintenance/orphan-check", { method: "POST" }),
    onSettled: () => qc.invalidateQueries({ queryKey: ["maintenance"] }),
  });
};
```

- [ ] **Step 4: Catalogues**

`web/src/i18n/fr.ts`, inside `maintenance`, after `reimporting: "Réimport en cours…",`:

```ts
    scheduled: {
      title: "Maintenance planifiée",
      intro:
        "Chaque nuit, Cloudmail vide la corbeille des anciens messages et vérifie qu'aucun message reçu ne manque à la boîte.",
      retention: (days: number) =>
        `La corbeille est vidée des messages de plus de ${days} ${plural.select(days) === "one" ? "jour" : "jours"}.`,
      retentionDisabled: "Purge automatique de la corbeille désactivée.",
      neverRun: "Aucun passage planifié pour l'instant.",
      lastRun: (date: string) => `Dernier passage : ${date}`,
      purged: (n: number) =>
        plural.select(n) === "one" ? `${n} message supprimé de la corbeille` : `${n} messages supprimés de la corbeille`,
      purgeFailed: (n: number) =>
        `${n} ${plural.select(n) === "one" ? "suppression en échec" : "suppressions en échec"}`,
      purgeRemaining: (n: number) =>
        plural.select(n) === "one"
          ? `${n} message reste à supprimer au prochain passage`
          : `${n} messages restent à supprimer au prochain passage`,
      runFailed: (detail: string) => `Erreur lors du passage : ${detail}`,
      neverChecked: "Stockage jamais vérifié.",
      orphansNone: "Aucun message orphelin.",
      orphansFound: (n: number) =>
        plural.select(n) === "one" ? `${n} message orphelin détecté` : `${n} messages orphelins détectés`,
      orphansPartial: (n: number) =>
        `Vérification partielle : ${n} ${plural.select(n) === "one" ? "orphelin" : "orphelins"} parmi les 10 000 premiers objets`,
      checkedAt: (date: string) => `vérifié le ${date}`,
      recheck: "Relancer la vérification",
      rechecking: "Vérification…",
    },
```

`web/src/i18n/en.ts`, same place (after `reimporting`):

```ts
    scheduled: {
      title: "Scheduled maintenance",
      intro:
        "Every night, Cloudmail empties old messages from the trash and checks that no received message is missing from the mailbox.",
      retention: (days) =>
        `The trash is emptied of messages older than ${days} ${plural.select(days) === "one" ? "day" : "days"}.`,
      retentionDisabled: "Automatic trash purge disabled.",
      neverRun: "No scheduled run yet.",
      lastRun: (date) => `Last run: ${date}`,
      purged: (n) => `${n} ${plural.select(n) === "one" ? "message" : "messages"} deleted from the trash`,
      purgeFailed: (n) => `${n} ${plural.select(n) === "one" ? "deletion" : "deletions"} failed`,
      purgeRemaining: (n) =>
        `${n} ${plural.select(n) === "one" ? "message" : "messages"} left to delete on the next run`,
      runFailed: (detail) => `Error during the run: ${detail}`,
      neverChecked: "Storage never checked.",
      orphansNone: "No orphaned messages.",
      orphansFound: (n) => `${n} orphaned ${plural.select(n) === "one" ? "message" : "messages"} detected`,
      orphansPartial: (n) =>
        `Partial check: ${n} ${plural.select(n) === "one" ? "orphan" : "orphans"} among the first 10,000 objects`,
      checkedAt: (date) => `checked on ${date}`,
      recheck: "Re-run the check",
      rechecking: "Checking…",
    },
```

- [ ] **Step 5: `ScheduledPanel` and re-check after re-import**

In `web/src/components/MaintenanceSettings.tsx`:

Extend the client import:

```ts
import {
  fetchOrphans,
  reimportInBatches,
  useMaintenance,
  useOrphanCheck,
  useParseErrors,
  type MaintenanceRun,
  type Orphan,
  type ReimportResult,
} from "../api/client";
```

Add, before `function OrphansPanel()`:

```tsx
const orphansLine = (run: MaintenanceRun, s: Catalog["maintenance"]["scheduled"]) => {
  const count = run.orphansCount ?? 0;
  if (run.orphansComplete === false) return s.orphansPartial(count);
  return count === 0 ? s.orphansNone : s.orphansFound(count);
};

// Résultat du passage nocturne (purge de la corbeille) et de la dernière vérification des
// orphelins, planifiée ou relancée ici. La purge n'est jamais déclenchable depuis l'interface.
function ScheduledPanel() {
  const { t, formatDate } = useI18n();
  const s = t.maintenance.scheduled;
  const { data, error, isLoading } = useMaintenance();
  const check = useOrphanCheck();
  const lastRun = data?.lastRun ?? null;
  const lastCheck = data?.lastCheck ?? null;

  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-base font-semibold">{s.title}</h2>
      <p className="text-sm text-muted-foreground">{s.intro}</p>

      {isLoading && <p className="text-sm text-muted-foreground">{t.common.loading}</p>}
      {error && <p role="alert" className="text-sm text-destructive">{errorText(error, t)}</p>}

      {data && (
        <>
          <p className="text-sm">{data.retentionDays ? s.retention(data.retentionDays) : s.retentionDisabled}</p>

          {lastRun === null ? (
            <p className="text-sm text-muted-foreground">{s.neverRun}</p>
          ) : (
            <div className="flex flex-col gap-1 text-sm">
              <p>{s.lastRun(formatDate(toDate(lastRun.ranAt), DATE_OPTIONS))}</p>
              {lastRun.trashPurged !== null && <p>{s.purged(lastRun.trashPurged)}</p>}
              {!!lastRun.trashFailed && <p className="text-destructive">{s.purgeFailed(lastRun.trashFailed)}</p>}
              {!!lastRun.trashRemaining && <p>{s.purgeRemaining(lastRun.trashRemaining)}</p>}
              {lastRun.error && <p className="text-destructive">{s.runFailed(lastRun.error)}</p>}
            </div>
          )}

          {lastCheck === null ? (
            <p className="text-sm text-muted-foreground">{s.neverChecked}</p>
          ) : (
            <p className="text-sm">
              {`${orphansLine(lastCheck, s)} — ${s.checkedAt(formatDate(toDate(lastCheck.ranAt), DATE_OPTIONS))}`}
            </p>
          )}

          <div>
            <Button type="button" variant="outline" onClick={() => check.mutate()} disabled={check.isPending}>
              {check.isPending ? s.rechecking : s.recheck}
            </Button>
          </div>
          {check.error && <p role="alert" className="text-sm text-destructive">{errorText(check.error, t)}</p>}
        </>
      )}
    </section>
  );
}
```

In `OrphansPanel`, add `const recheck = useOrphanCheck();` next to `const qc = useQueryClient();`, and replace `reimportSelected` with:

```tsx
  const reimportSelected = async () => {
    setImporting(true);
    setError(null);
    let imported = false;
    try {
      await reimportInBatches([...selected], (batch) => {
        if (batch.some((r) => r.outcome === "imported")) imported = true;
        setResults((prev) => {
          const next = new Map(prev);
          for (const r of batch) next.set(r.key, r);
          return next;
        });
      });
      setSelected(new Set());
    } catch (err) {
      setError(err);
    } finally {
      setImporting(false);
      qc.invalidateQueries({ queryKey: ["threads"] });
      // Le compte d'orphelins affiché (et le badge) serait sinon périmé jusqu'à la nuit suivante.
      if (imported) recheck.mutate();
    }
  };
```

In `MaintenanceSettings`, render the panel first:

```tsx
      <h1 className="text-lg font-semibold">{t.maintenance.title}</h1>
      <ScheduledPanel />
      <OrphansPanel />
      <ParseErrorsPanel />
```

- [ ] **Step 6: Run to verify pass, then SPA suite and build**

Run: `pnpm --filter web test -- src/components/MaintenanceSettings.test.tsx` → PASS.
Run: `pnpm --filter web test` → PASS.
Run: `pnpm build` → succeeds (typechecks `en.ts` against `fr.ts`).

- [ ] **Step 7: Commit**

```bash
git add web/src/api/client.ts web/src/i18n/fr.ts web/src/i18n/en.ts web/src/components/MaintenanceSettings.tsx web/src/components/MaintenanceSettings.test.tsx
git commit -m "feat(web): scheduled maintenance status in the Maintenance view"
```

---

### Task 7: Sidebar orphan badge and trash notice

**Files:**
- Create: `web/src/components/TrashNotice.tsx`, `web/src/components/TrashNotice.test.tsx`
- Modify: `web/src/components/Sidebar.tsx` (Maintenance button), `web/src/App.tsx` (render `TrashNotice` in the trash)
- Modify: `web/src/i18n/fr.ts`, `web/src/i18n/en.ts` (`threadList.trashNotice`)
- Test: `web/src/components/Sidebar.test.tsx`

**Interfaces:**
- Consumes: `useMaintenance` (Task 6), `useConfig` returning `trashRetentionDays` (Tasks 5–6), `t.maintenance.scheduled.orphansFound` (Task 6).
- Produces: `export function TrashNotice(): JSX.Element | null`.

- [ ] **Step 1: Write the failing tests**

Append to `web/src/components/Sidebar.test.tsx`:

```tsx
describe("badge des orphelins", () => {
  const stubWith = (maintenance: unknown) =>
    vi.stubGlobal("fetch", vi.fn(async (url: string) =>
      Response.json(
        url === "/api/admin/maintenance" ? maintenance
          : url.startsWith("/api/threads") ? { threads: [], cursor: null }
          : [],
      ),
    ));

  it("affiche le nombre d'orphelins détectés", async () => {
    stubWith({ retentionDays: 30, lastRun: null, lastCheck: { orphansCount: 3, orphansComplete: true } });
    render(<App />, { wrapper });
    expect(await screen.findByLabelText("3 messages orphelins détectés")).toHaveTextContent("3");
  });

  it("n'affiche rien sans orphelin", async () => {
    stubWith({ retentionDays: 30, lastRun: null, lastCheck: { orphansCount: 0, orphansComplete: true } });
    render(<App />, { wrapper });
    await screen.findByRole("button", { name: "Maintenance" });
    expect(screen.queryByLabelText(/orphelin/)).toBeNull();
  });
});
```

`web/src/components/TrashNotice.test.tsx`:

```tsx
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderWithI18n as render } from "../test/i18n";
import { TrashNotice } from "./TrashNotice";

afterEach(() => vi.unstubAllGlobals());

const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    {children}
  </QueryClientProvider>
);

const stubConfig = (trashRetentionDays: number | null) => {
  const fetch = vi.fn(async () => Response.json({ mailDomain: "example.com", trashRetentionDays }));
  vi.stubGlobal("fetch", fetch);
  return fetch;
};

describe("TrashNotice", () => {
  it("annonce le délai de suppression", async () => {
    stubConfig(30);
    render(<TrashNotice />, { wrapper });
    expect(
      await screen.findByText("Les messages de la corbeille sont supprimés définitivement après 30 jours."),
    ).toBeDefined();
  });

  it("n'affiche rien quand la purge est désactivée", async () => {
    const fetch = stubConfig(null);
    const { container } = render(<TrashNotice />, { wrapper });
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));
    expect(container).toBeEmptyDOMElement();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter web test -- src/components/Sidebar.test.tsx src/components/TrashNotice.test.tsx`
Expected: FAIL — `TrashNotice` not found; badge label not found.

- [ ] **Step 3: Catalogues**

`web/src/i18n/fr.ts`, inside `threadList`, after `loadMore: "Charger plus",`:

```ts
    trashNotice: (days: number) =>
      `Les messages de la corbeille sont supprimés définitivement après ${days} ${plural.select(days) === "one" ? "jour" : "jours"}.`,
```

`web/src/i18n/en.ts`, same place:

```ts
    trashNotice: (days) =>
      `Messages in the trash are permanently deleted after ${days} ${plural.select(days) === "one" ? "day" : "days"}.`,
```

- [ ] **Step 4: `TrashNotice`**

`web/src/components/TrashNotice.tsx`:

```tsx
import { useConfig } from "../api/client";
import { useI18n } from "../i18n";

// Rappel en tête de la corbeille : son contenu est purgé par la maintenance planifiée.
// Masqué quand la purge est désactivée (trashRetentionDays null).
export function TrashNotice() {
  const { t } = useI18n();
  const { data } = useConfig();
  const days = data?.trashRetentionDays;
  if (!days) return null;
  return (
    <p className="border-b border-border px-3 py-2 text-xs text-muted-foreground">{t.threadList.trashNotice(days)}</p>
  );
}
```

`web/src/App.tsx`: add `import { TrashNotice } from "./components/TrashNotice";` and, just before `<div className="flex-1 overflow-y-auto">` (the thread list container), insert:

```tsx
            {folder === "trash" && <TrashNotice />}
```

- [ ] **Step 5: Badge**

`web/src/components/Sidebar.tsx`: change the import to `import { useIdentities, useMaintenance } from "../api/client";`, add after `const { data: identities } = useIdentities();`:

```tsx
  const { data: maintenance } = useMaintenance();
  // Dernière vérification réussie (planifiée ou manuelle) : le badge disparaît dès qu'une
  // vérification relancée après réimport ne trouve plus rien.
  const orphans = maintenance?.lastCheck?.orphansCount ?? 0;
```

and replace the Maintenance button's content `{t.sidebar.maintenance}` with:

```tsx
            <span className="flex items-center justify-between gap-2">
              {t.sidebar.maintenance}
              {orphans > 0 && (
                <span
                  aria-label={t.maintenance.scheduled.orphansFound(orphans)}
                  className="rounded-full bg-destructive px-2 text-xs font-semibold text-white"
                >
                  {orphans}
                </span>
              )}
            </span>
```

- [ ] **Step 6: Run to verify pass, then SPA suite and build**

Run: `pnpm --filter web test -- src/components/Sidebar.test.tsx src/components/TrashNotice.test.tsx` → PASS.
Run: `pnpm --filter web test` → PASS.
Run: `pnpm build` → succeeds.

- [ ] **Step 7: Commit**

```bash
git add web/src/components/TrashNotice.tsx web/src/components/TrashNotice.test.tsx web/src/components/Sidebar.tsx web/src/components/Sidebar.test.tsx web/src/App.tsx web/src/i18n/fr.ts web/src/i18n/en.ts
git commit -m "feat(web): orphan badge in the sidebar and trash retention notice"
```

---

### Task 8: Documentation

**Files:**
- Modify: `README.md` (Features, Configuration reference, Operations, Roadmap)
- Modify: `AGENTS.md` (Environment variables table, new section, Deployment, test counts)

**Interfaces:** none.

- [ ] **Step 1: README**

In `## Features`, after the "Nothing is ever lost" bullet, add:

```markdown
- **Scheduled maintenance** — every night, messages that have been in the
  trash for more than 30 days (configurable) are deleted for good, and the
  storage is checked for received mail missing from the app; the Maintenance
  view and a sidebar badge show the result
```

In `## Configuration reference`, add a row after `MAIL_DOMAIN`:

```markdown
| `TRASH_RETENTION_DAYS` | `wrangler.jsonc` → `vars` (override in `wrangler.overrides.json`) | Days before trashed messages are deleted for good; `0` disables it (default `30`) |
```

In `## Operations → ### Checking that no mail was lost`, replace the paragraph starting "Open **Maintenance** in the sidebar" with:

```markdown
This is checked every night: when messages stored in R2 are missing from the
app, a badge appears next to **Maintenance** in the sidebar. Open it and click
**Analyser le stockage** to list them and re-import them; **Relancer la
vérification** updates the count right away. The manual procedure below does
the same from a terminal and stays useful if the Worker itself can't run.
```

Add, after the "Re-importing a message" subsection:

```markdown
### Scheduled maintenance

A Cron Trigger runs once a night (`17 3 * * *` UTC, in `wrangler.jsonc`). It
deletes up to 100 messages that have been in the trash longer than
`TRASH_RETENTION_DAYS`, then counts orphaned messages (up to 10,000 stored
objects per run). Anything left over is handled the following night. Set
`TRASH_RETENTION_DAYS` to `0` in `wrangler.overrides.json` to keep the trash
forever. Messages already in the trash when you upgrade get the full
retention period, counted from the upgrade.
```

In `## Roadmap`, delete the "Scheduled maintenance: …" bullet (all its lines).

- [ ] **Step 2: AGENTS.md**

In the Environment variables table, after the `MAIL_DOMAIN` row:

```markdown
| `TRASH_RETENTION_DAYS` | var | `wrangler.jsonc` default `"30"`, override in `wrangler.overrides.json` | `wrangler.jsonc` | `src/maintenance/trash.ts` — trash retention; `0`/missing/invalid disables the purge |
```

Add a section after "## Re-importing a message (`src/admin/reimport.ts`)":

```markdown
## Scheduled maintenance (`src/maintenance/`)

One Cron Trigger (`triggers.crons` in `wrangler.jsonc`; the free plan allows
only one) calls `scheduled()` → `runMaintenance`, which never throws:

- **Trash purge** (`trash.ts`): messages with `folder = 'trash'` and
  `trashed_at` older than `TRASH_RETENTION_DAYS`, oldest first, at most 100
  per run, each through `purgeMessage` — never a direct delete, so the R2-then-D1
  order holds. `trashed_at` is set and cleared only by `moveToFolder`, the
  single path into the trash; keep it that way. A missing or invalid
  retention value disables the purge rather than deleting anything.
- **Orphan check** (`orphans.ts`): counts `raw/` objects with no row, up to
  20 pages of `listOrphans`. It reports only — never re-imports, never
  deletes. Recovery stays a user action.
- Each run is one `maintenance_runs` row (last 30 kept) and one
  `{ event: "maintenance" }` log line. `GET /api/admin/maintenance` returns
  the last `cron` row (`lastRun`) and the last successful check of either
  trigger (`lastCheck`). `POST /api/admin/maintenance/orphan-check` runs the
  check only; the purge is never reachable from the API.
```

In `## Deployment`, the bullet "On an existing installation, `pnpm run migrate:remote` must run before deploying a version with a new migration" — append:

```markdown
  Without `0004`, the nightly run logs a failure and the Maintenance view
  shows "never run"; moving a message to the trash returns 500 (missing
  `trashed_at`).
```

In `## Two test suites, don't mix them`, update the counts. Get them with:

```bash
find test -name '*.test.ts' | wc -l
find web/src -name '*.test.ts*' | wc -l
```

and write the numbers in place of `22` and `13`.

- [ ] **Step 3: Verify everything**

Run: `pnpm test` → both suites PASS.
Run: `pnpm typecheck && pnpm build` → no errors.

- [ ] **Step 4: Commit**

```bash
git add README.md AGENTS.md
git commit -m "docs: scheduled maintenance in the README and agent guide"
```
