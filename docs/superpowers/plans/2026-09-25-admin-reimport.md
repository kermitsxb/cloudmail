# Admin re-import entry point Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship an authenticated admin entry point (API + Maintenance view) that finds orphaned raw MIME objects in R2, re-imports them, and re-parses existing incoming messages in place.

**Architecture:** All logic lives in a new module `src/admin/reimport.ts` (listing orphans, listing parse errors, `reimportKey`). Existing messages are re-parsed by an in-place `UPDATE` in one atomic D1 batch that never touches `id`, `thread_id`, `folder` or `is_read`; orphans go through the normal `storeIncoming`. Three thin Hono routes under `/api/admin/*` expose it, and the SPA drives listing pages and batches of 10 keys.

**Tech Stack:** Cloudflare Workers, Hono, zod, D1 (SQLite), R2, postal-mime; SPA in React + TanStack Query + Tailwind; tests with vitest (`@cloudflare/vitest-plugin` for the Worker, jsdom + Testing Library for the SPA).

**Spec:** `docs/superpowers/specs/2026-09-25-admin-reimport-design.md`

## Global Constraints

- Code comments, test names (`describe`/`it`) and every user-facing string (API error messages, UI copy) are in **French**, like the rest of the codebase. Plan prose is English.
- Tests and docs use neutral example values only (`example.com`, `zoe@example.com`) — never a real address or domain.
- Accepted replay keys match exactly `^raw/[0-9a-f]{64}\.eml$`.
- `POST /api/admin/reimport` takes 1 to 10 keys (`REIMPORT_MAX_KEYS = 10`); the SPA batches by 10.
- Orphan listing page size: 500 R2 keys. Parse-errors page size: 50 rows.
- Placeholder envelope sender for orphans: `unknown@invalid`.
- A replay never forwards, never reads/writes `forward_rules`, never deletes a `raw/…` object.
- In-place re-parse never writes `id`, `thread_id`, `folder`, `is_read`, `direction`, `raw_key`.
- Order of writes: new attachment objects to R2 **before** the D1 batch; old attachment objects deleted **after** it commits.
- Migrations are immutable: the index goes in a new `migrations/0003_raw_key_index.sql`.
- Worker suite: `pnpm vitest run` at the root. SPA suite: `pnpm --filter web test`. `pnpm typecheck` covers only the Worker; `pnpm build` typechecks the SPA.
- Commit messages: conventional style (`feat(admin): …`), no session URL or Claude attribution lines.

## Review Focus

1. **An orphan whose `Message-ID` already exists under another raw key** (same mail delivered twice with different `Received` headers) — expected: reported as `duplicate` with the existing message id, not `error` and not a false `imported`. Pinned in Task 4.
2. **A re-parse whose new `Message-ID` collides with another row** — expected: `error` naming the other message, the row and its attachments unchanged, no stray R2 object. Pinned in Task 4.
3. **A scan that fails midway (503 on page 2)** — expected: orphans from page 1 stay listed, the error is shown, and "Reprendre" continues from the failed cursor instead of restarting. Pinned in Task 7.
4. **Re-importing a message from the thread currently open** — expected: the thread view refetches and shows the re-parsed content without a reload. Pinned in Task 8.
5. **A tampered `cursor` query parameter** (`?cursor=abc` on parse-errors, a 2000-char cursor on orphans) — expected: 400 with a French message, never 500. Pinned in Task 5.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `migrations/0003_raw_key_index.sql` (create) | Index on `messages(raw_key)` |
| `src/ingest/parse.ts` (modify) | `messageIdSynthetic` flag |
| `src/ingest/store.ts` (modify) | Shared helpers: `attachmentKey`, `putAttachments`, `recipientStatements`, `attachmentStatements`; `storeIncoming` uses them |
| `src/admin/reimport.ts` (create) | `listOrphans`, `listParseErrors`, `reimportKey`, in-place re-parse |
| `src/email.ts` (modify) | Remove `reparse` |
| `src/api/routes.ts` (modify) | `/admin/orphans`, `/admin/parse-errors`, `/admin/reimport` |
| `src/db/queries.ts` (modify) | `rawKey` on `MessageDetail` |
| `web/src/api/client.ts` (modify) | Types, fetchers, `reimportInBatches`, hooks |
| `web/src/lib/reimport.ts` (create) | `outcomeLabel` (French label per result) |
| `web/src/components/MaintenanceSettings.tsx` (create) | Maintenance view: orphans panel, parse-errors panel |
| `web/src/components/Sidebar.tsx`, `web/src/App.tsx` (modify) | `"maintenance"` view |
| `web/src/components/ThreadView.tsx` (modify) | Re-import action on incoming messages |
| `test/admin/reimport.test.ts` (create) | Worker tests for the module |
| `test/api/admin.test.ts` (create) | Route tests |
| `AGENTS.md`, `README.md` (modify) | Docs |

---

### Task 1: `raw_key` index and synthetic Message-ID flag

**Files:**
- Create: `migrations/0003_raw_key_index.sql`
- Modify: `src/ingest/parse.ts` (type `ParsedMessage`, function `parseEmail`)
- Test: `test/db/schema.test.ts`, `test/ingest/parse.test.ts`

**Interfaces:**
- Produces: `ParsedMessage.messageIdSynthetic: boolean` — `true` when `messageId` was generated by Cloudmail (fallback path or missing `Message-ID` header). Index `idx_messages_raw_key`.

- [ ] **Step 1: Write the failing tests**

Append to `test/db/schema.test.ts`, inside its existing top-level `describe` (reuse the file's existing `beforeAll` that applies migrations):

```ts
  it("indexe messages.raw_key pour retrouver une ligne par son brut", async () => {
    const row = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_messages_raw_key'"
    ).first<{ name: string }>();
    expect(row?.name).toBe("idx_messages_raw_key");
  });
```

Append to `test/ingest/parse.test.ts`, inside `describe("parseEmail", …)`:

```ts
  it("signale un Message-ID réel comme non synthétique", async () => {
    const m = await parseEmail(await load("simple.eml"), "zoe@example.com");
    expect(m.messageIdSynthetic).toBe(false);
  });

  it("signale le Message-ID inventé d'un message illisible", async () => {
    const m = await parseEmail(await load("malformed.eml"), "zoe@example.com");
    expect(m.messageIdSynthetic).toBe(true);
  });

  it("signale le Message-ID inventé d'un message sans en-tête Message-ID", async () => {
    const raw = new TextEncoder().encode(
      "From: zoe@example.com\r\nTo: thomas@example.com\r\nSubject: Sans identifiant\r\n\r\nBonjour\r\n"
    ).buffer as ArrayBuffer;
    const m = await parseEmail(raw, "zoe@example.com");
    expect(m.messageId).toMatch(/@cloudmail\.local>$/);
    expect(m.messageIdSynthetic).toBe(true);
  });
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm vitest run test/db/schema.test.ts test/ingest/parse.test.ts`
Expected: FAIL — index not found; `messageIdSynthetic` is `undefined`.

- [ ] **Step 3: Implement**

Create `migrations/0003_raw_key_index.sql`:

```sql
-- Le brut d'un message (raw/<sha256>.eml) n'a pas d'autre adresse que cette colonne.
-- La recherche des orphelins (objets R2 sans ligne) et le réimport retrouvent les lignes
-- par raw_key : sans index, chaque page de 500 clés parcourrait toute la table.
CREATE INDEX idx_messages_raw_key ON messages(raw_key);
```

In `src/ingest/parse.ts`, add to `ParsedMessage` after `messageId`:

```ts
  // Vrai quand messageId a été inventé par Cloudmail (message illisible ou sans en-tête
  // Message-ID). Un nouveau parsing en inventerait un autre : le réimport s'en sert pour
  // conserver l'identifiant déjà en base plutôt que de le remplacer.
  messageIdSynthetic: boolean;
```

In `parseEmail`, add `messageIdSynthetic: true,` to the object returned by `fallback()` (next to `messageId`), and in the main return replace the `messageId` line with:

```ts
    messageId: email.messageId ?? `<${crypto.randomUUID()}@cloudmail.local>`,
    messageIdSynthetic: !email.messageId,
```

- [ ] **Step 4: Run to verify they pass**

Run: `pnpm vitest run test/db/schema.test.ts test/ingest/parse.test.ts && pnpm typecheck`
Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add migrations/0003_raw_key_index.sql src/ingest/parse.ts test/db/schema.test.ts test/ingest/parse.test.ts
git commit -m "feat(ingest): index raw_key and flag invented Message-IDs"
```

---

### Task 2: Extract shared storage helpers from `storeIncoming`

Pure refactor: the in-place re-parse (Task 4) must build attachment keys, write attachments and build recipient/attachment rows exactly like `storeIncoming`. Extract, don't duplicate.

**Files:**
- Modify: `src/ingest/store.ts`
- Test: `test/ingest/store.test.ts`

**Interfaces:**
- Produces (all exported from `src/ingest/store.ts`):
  - `type StoredAttachment = ParsedAttachment & { r2Key: string }`
  - `attachmentKey(messageId: string, index: number, filename: string): string` → `att/<safeKey(messageId)>/<index>-<sanitizeFilename(filename)>`
  - `putAttachments(env: Env, messageId: string, attachments: ParsedAttachment[]): Promise<StoredAttachment[]>`
  - `recipientStatements(db: D1Database, rowId: number, msg: ParsedMessage): D1PreparedStatement[]`
  - `attachmentStatements(db: D1Database, rowId: number, stored: StoredAttachment[]): D1PreparedStatement[]`
  - Unchanged and still exported: `truncateBody`, `sanitizeFilename`, `storeIncoming`, `IncomingState`, `StoreResult`.

- [ ] **Step 1: Write the failing test**

Append to `test/ingest/store.test.ts` (add `attachmentKey` to its import from `../../src/ingest/store`):

```ts
describe("attachmentKey", () => {
  it("range la pièce jointe sous l'identifiant nettoyé du message", () => {
    expect(attachmentKey("<att-1@example.com>", 0, "data.csv")).toBe("att/att-1-example.com/0-data.csv");
  });

  it("nettoie le nom de fichier", () => {
    expect(attachmentKey("<a@example.com>", 2, "rapport final (v2).pdf")).toBe("att/a-example.com/2-rapport-final-v2-.pdf");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run test/ingest/store.test.ts`
Expected: FAIL — `attachmentKey` is not exported.

- [ ] **Step 3: Implement**

In `src/ingest/store.ts`:

Change the parse import to `import { parseEmail, safeKey, snippetOf, type ParsedAttachment, type ParsedMessage } from "./parse";`

Add after `sanitizeFilename`:

```ts
// Pièce jointe écrite dans R2, avec la clé sous laquelle elle l'a été.
export type StoredAttachment = ParsedAttachment & { r2Key: string };

// Clé R2 d'une pièce jointe. Partagée par l'ingestion et le réimport : une même pièce
// jointe d'un même message doit toujours atterrir sous la même clé.
export const attachmentKey = (messageId: string, index: number, filename: string): string =>
  `att/${safeKey(messageId)}/${index}-${sanitizeFilename(filename)}`;

// Écrit les pièces jointes dans R2, une par une, avant toute écriture D1 qui les référence.
export async function putAttachments(
  env: Env,
  messageId: string,
  attachments: ParsedAttachment[],
): Promise<StoredAttachment[]> {
  const stored: StoredAttachment[] = [];
  for (const [i, att] of attachments.entries()) {
    const r2Key = attachmentKey(messageId, i, att.filename);
    await env.MAIL.put(r2Key, att.content, { httpMetadata: { contentType: att.mimeType } });
    stored.push({ ...att, r2Key });
  }
  return stored;
}

export function recipientStatements(db: D1Database, rowId: number, msg: ParsedMessage): D1PreparedStatement[] {
  const statements: D1PreparedStatement[] = [];
  for (const [kind, list] of [["to", msg.to], ["cc", msg.cc], ["reply-to", msg.replyTo]] as const) {
    for (const a of list) {
      statements.push(
        db.prepare("INSERT INTO recipients (message_id, kind, address, name) VALUES (?, ?, ?, ?)")
          .bind(rowId, kind, a.address, a.name)
      );
    }
  }
  return statements;
}

export function attachmentStatements(db: D1Database, rowId: number, stored: StoredAttachment[]): D1PreparedStatement[] {
  return stored.map((att) =>
    db.prepare(
      "INSERT INTO attachments (message_id, filename, mime_type, size, content_id, r2_key) VALUES (?, ?, ?, ?, ?, ?)"
    ).bind(rowId, att.filename, att.mimeType, att.size, att.contentId, att.r2Key)
  );
}
```

In `storeIncoming`, delete the line `const key = safeKey(msg.messageId);`, and replace the block from `const statements: D1PreparedStatement[] = [];` through the end of the attachments `for` loop with:

```ts
  const stored = await putAttachments(env, msg.messageId, msg.attachments);
  const statements: D1PreparedStatement[] = [
    ...recipientStatements(env.DB, messageId, msg),
    ...attachmentStatements(env.DB, messageId, stored),
  ];
```

(The following `statements.push(… UPDATE threads …)` and `await env.DB.batch(statements)` stay as they are.)

- [ ] **Step 4: Run the whole Worker suite (refactor safety net)**

Run: `pnpm vitest run && pnpm typecheck`
Expected: PASS — all existing ingestion and `reparse` tests unchanged and green.

- [ ] **Step 5: Commit**

```bash
git add src/ingest/store.ts test/ingest/store.test.ts
git commit -m "refactor(ingest): extract attachment and recipient helpers from storeIncoming"
```

---

### Task 3: Listing orphans and parse errors

**Files:**
- Create: `src/admin/reimport.ts`
- Create: `test/admin/reimport.test.ts`

**Interfaces:**
- Consumes: index from Task 1.
- Produces (exported from `src/admin/reimport.ts`):
  - `RAW_KEY_PATTERN: RegExp` = `/^raw\/[0-9a-f]{64}\.eml$/`
  - `ORPHAN_PAGE_SIZE = 500`, `PARSE_ERRORS_PAGE_SIZE = 50`
  - `type Orphan = { key: string; size: number; uploaded: string }` (`uploaded` is ISO 8601)
  - `listOrphans(env: Env, opts?: { cursor?: string; limit?: number }): Promise<{ orphans: Orphan[]; cursor: string | null }>`
  - `type ParseErrorMessage = { id: number; rawKey: string; subject: string | null; receivedAt: number }`
  - `listParseErrors(env: Env, opts?: { cursor?: number; limit?: number }): Promise<{ messages: ParseErrorMessage[]; cursor: string | null }>` — `cursor` in the result is the last `id` as a string.

- [ ] **Step 1: Write the failing tests**

Create `test/admin/reimport.test.ts`:

```ts
import { env, applyD1Migrations } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { listOrphans, listParseErrors } from "../../src/admin/reimport";

interface TestEnv {
  TEST_FIXTURES: Record<string, string>;
  TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
}

const testEnv = env as unknown as TestEnv;

beforeAll(async () => {
  await applyD1Migrations(env.DB, testEnv.TEST_MIGRATIONS);
});

// Le stockage n'est pas isolé entre tests : on vide D1 et tout le bucket R2.
const clearBucket = async () => {
  let cursor: string | undefined;
  do {
    const page = await env.MAIL.list({ cursor });
    if (page.objects.length > 0) await env.MAIL.delete(page.objects.map((o) => o.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
};

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM attachments"),
    env.DB.prepare("DELETE FROM recipients"),
    env.DB.prepare("DELETE FROM messages"),
    env.DB.prepare("DELETE FROM threads"),
    env.DB.prepare("DELETE FROM forward_rules"),
  ]);
  await clearBucket();
});

const loadBytes = (name: string): ArrayBuffer => {
  const b64 = testEnv.TEST_FIXTURES[name];
  if (!b64) throw new Error(`fixture introuvable: ${name}`);
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
};

// Clé adressée par contenu, calculée comme storeIncoming.
const rawKeyOf = async (raw: ArrayBuffer) => {
  const digest = await crypto.subtle.digest("SHA-256", raw);
  return `raw/${[...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("")}.eml`;
};

const textBytes = (s: string) => new TextEncoder().encode(s).buffer as ArrayBuffer;

// Ligne D1 minimale pointant vers un brut donné.
const insertRow = async (over: { rawKey: string; messageId: string; direction?: "in" | "out"; parseError?: number; subject?: string }) => {
  const thread = await env.DB.prepare(
    "INSERT INTO threads (subject_norm, last_message_at, message_count, unread_count) VALUES ('sujet', 0, 1, 1)"
  ).run();
  const res = await env.DB.prepare(
    `INSERT INTO messages (thread_id, message_id, direction, folder, from_addr, subject, received_at, raw_key, parse_error)
     VALUES (?, ?, ?, 'inbox', 'zoe@example.com', ?, 1757318400, ?, ?)`
  ).bind(
    thread.meta.last_row_id, over.messageId, over.direction ?? "in", over.subject ?? "Sujet",
    over.rawKey, over.parseError ?? 0,
  ).run();
  return Number(res.meta.last_row_id);
};

describe("listOrphans", () => {
  it("ne renvoie que les bruts sans ligne D1, page après page", async () => {
    const keys: string[] = [];
    for (const n of [1, 2, 3]) {
      const raw = textBytes(`Subject: orphelin ${n}\r\n\r\ncorps\r\n`);
      const key = await rawKeyOf(raw);
      await env.MAIL.put(key, raw);
      keys.push(key);
    }
    await insertRow({ rawKey: keys[1], messageId: "<connu@example.com>" });

    const found: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await listOrphans(env, { cursor, limit: 2 });
      found.push(...page.orphans.map((o) => o.key));
      cursor = page.cursor ?? undefined;
      pages++;
    } while (cursor);

    expect(pages).toBe(2);
    expect(found.sort()).toEqual([keys[0], keys[2]].sort());
  });

  it("décrit chaque orphelin par sa taille et sa date de dépôt", async () => {
    const raw = textBytes("Subject: seul\r\n\r\ncorps\r\n");
    const key = await rawKeyOf(raw);
    await env.MAIL.put(key, raw);

    const page = await listOrphans(env);

    expect(page.cursor).toBeNull();
    expect(page.orphans).toHaveLength(1);
    expect(page.orphans[0]).toMatchObject({ key, size: raw.byteLength });
    expect(Number.isNaN(Date.parse(page.orphans[0].uploaded))).toBe(false);
  });

  it("ignore les objets hors du préfixe raw/", async () => {
    await env.MAIL.put("att/a-example.com/0-data.csv", "a,b");
    const page = await listOrphans(env);
    expect(page).toEqual({ orphans: [], cursor: null });
  });
});

describe("listParseErrors", () => {
  it("liste les messages reçus en erreur d'analyse, du plus récent au plus ancien, par pages", async () => {
    const a = await insertRow({ rawKey: "raw/a.eml", messageId: "<a@example.com>", parseError: 1, subject: "A" });
    await insertRow({ rawKey: "raw/b.eml", messageId: "<b@example.com>", parseError: 0 });
    await insertRow({ rawKey: "sent/c", messageId: "<c@example.com>", parseError: 1, direction: "out" });
    const d = await insertRow({ rawKey: "raw/d.eml", messageId: "<d@example.com>", parseError: 1, subject: "D" });

    const first = await listParseErrors(env, { limit: 1 });
    expect(first.messages).toEqual([{ id: d, rawKey: "raw/d.eml", subject: "D", receivedAt: 1757318400 }]);
    expect(first.cursor).toBe(String(d));

    const second = await listParseErrors(env, { cursor: Number(first.cursor), limit: 1 });
    expect(second.messages.map((m) => m.id)).toEqual([a]);
    expect(second.cursor).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm vitest run test/admin/reimport.test.ts`
Expected: FAIL — cannot resolve `../../src/admin/reimport`.

- [ ] **Step 3: Implement**

Create `src/admin/reimport.ts`:

```ts
import type { Env } from "../env";

// Seules les clés de brut entrant sont réimportables. Les messages envoyés ont une clé
// sent/<id> sans objet R2, et les pièces jointes vivent sous att/ : ce motif ferme aussi
// la porte à toute clé fabriquée (chemin relatif, autre préfixe).
export const RAW_KEY_PATTERN = /^raw\/[0-9a-f]{64}\.eml$/;

export const ORPHAN_PAGE_SIZE = 500;
export const PARSE_ERRORS_PAGE_SIZE = 50;

export type Orphan = { key: string; size: number; uploaded: string };

// Une page de raw/ dans R2, moins les clés connues de D1. Une page sans orphelin avec un
// curseur non nul est normale : l'appelant continue jusqu'à cursor === null.
export async function listOrphans(
  env: Env,
  opts: { cursor?: string; limit?: number } = {},
): Promise<{ orphans: Orphan[]; cursor: string | null }> {
  const page = await env.MAIL.list({
    prefix: "raw/",
    limit: opts.limit ?? ORPHAN_PAGE_SIZE,
    cursor: opts.cursor,
  });
  const keys = page.objects.map((o) => o.key);

  let known = new Set<string>();
  if (keys.length > 0) {
    // Les clés passent en un seul paramètre JSON : D1 plafonne à 100 paramètres liés par
    // requête, une page de 500 clés en IN (?, ?, …) serait refusée.
    const rows = await env.DB.prepare(
      "SELECT DISTINCT raw_key FROM messages WHERE raw_key IN (SELECT value FROM json_each(?))"
    ).bind(JSON.stringify(keys)).all<{ raw_key: string }>();
    known = new Set(rows.results.map((r) => r.raw_key));
  }

  return {
    orphans: page.objects
      .filter((o) => !known.has(o.key))
      .map((o) => ({ key: o.key, size: o.size, uploaded: o.uploaded.toISOString() })),
    cursor: page.truncated ? page.cursor : null,
  };
}

export type ParseErrorMessage = { id: number; rawKey: string; subject: string | null; receivedAt: number };

// Messages reçus que le parseur n'a pas compris, du plus récent au plus ancien. Pagination
// par clé (id décroissant) : le curseur est le dernier id renvoyé.
export async function listParseErrors(
  env: Env,
  opts: { cursor?: number; limit?: number } = {},
): Promise<{ messages: ParseErrorMessage[]; cursor: string | null }> {
  const limit = opts.limit ?? PARSE_ERRORS_PAGE_SIZE;
  const rows = await env.DB.prepare(
    `SELECT id, raw_key, subject, received_at FROM messages
      WHERE direction = 'in' AND parse_error = 1 AND (?1 IS NULL OR id < ?1)
      ORDER BY id DESC LIMIT ?2`
  ).bind(opts.cursor ?? null, limit + 1).all<{ id: number; raw_key: string; subject: string | null; received_at: number }>();

  const page = rows.results.slice(0, limit);
  const last = page[page.length - 1];
  return {
    messages: page.map((r) => ({ id: r.id, rawKey: r.raw_key, subject: r.subject, receivedAt: r.received_at })),
    cursor: rows.results.length > limit && last ? String(last.id) : null,
  };
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `pnpm vitest run test/admin/reimport.test.ts && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/admin/reimport.ts test/admin/reimport.test.ts
git commit -m "feat(admin): list orphaned raw messages and parse errors"
```

---

### Task 4: `reimportKey` with in-place re-parse; remove `reparse`

**Files:**
- Modify: `src/admin/reimport.ts`
- Modify: `src/email.ts` (delete `reparse` and the now-unused imports `parseEmail`, `IncomingState`)
- Modify: `test/email-handler.test.ts` (delete the `describe("reparse", …)` block; drop `reparse`, `moveToFolder`, `setRead` from imports if no longer used)
- Test: `test/admin/reimport.test.ts`

**Interfaces:**
- Consumes: `parseEmail` + `messageIdSynthetic` (Task 1); `storeIncoming`, `truncateBody`, `putAttachments`, `recipientStatements`, `attachmentStatements`, `StoredAttachment` (Task 2); `snippetOf` from `src/ingest/parse`.
- Produces:
  - `ORPHAN_ENVELOPE_FROM = "unknown@invalid"`
  - `type ReimportResult = { key: string; outcome: "imported" | "reparsed" | "duplicate"; messageIds: number[] } | { key: string; outcome: "not_found" } | { key: string; outcome: "error"; error: string }` (write it as a union of the five object shapes, one per outcome)
  - `reimportKey(env: Env, rawKey: string, by: string): Promise<ReimportResult>` — never throws; logs one JSON line `{ event: "reimport", ...result, by }`.

- [ ] **Step 1: Write the failing tests**

In `test/admin/reimport.test.ts`, extend the imports:

```ts
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { listOrphans, listParseErrors, reimportKey } from "../../src/admin/reimport";
import { storeIncoming } from "../../src/ingest/store";
import { moveToFolder, setRead } from "../../src/db/mutations";
```

Append:

```ts
// Ingère un brut comme le ferait handleEmail, sans redirection.
const ingest = async (raw: ArrayBuffer) => {
  const res = await storeIncoming(env, raw, { from: "zoe@example.com", to: "thomas@example.com" });
  return { id: res.messageId!, rawKey: res.rawKey };
};

const messageRow = (id: number) =>
  env.DB.prepare(
    "SELECT id, message_id, thread_id, folder, is_read, subject, parse_error FROM messages WHERE id = ?"
  ).bind(id).first<{
    id: number; message_id: string; thread_id: number; folder: string;
    is_read: number; subject: string | null; parse_error: number;
  }>();

const threadTotals = () =>
  env.DB.prepare("SELECT COUNT(*) AS n, SUM(message_count) AS mc, SUM(unread_count) AS uc FROM threads")
    .first<{ n: number; mc: number; uc: number }>();

const countMessages = async () =>
  (await env.DB.prepare("SELECT COUNT(*) AS n FROM messages").first<{ n: number }>())!.n;

const NO_MESSAGE_ID = "From: zoe@example.com\r\nTo: thomas@example.com\r\nSubject: Sans identifiant\r\n\r\nBonjour\r\n";

describe("reimportKey — orphelins", () => {
  it("importe un orphelin comme un message neuf, non lu, en boîte de réception", async () => {
    const raw = loadBytes("simple.eml");
    const key = await rawKeyOf(raw);
    await env.MAIL.put(key, raw);

    const result = await reimportKey(env, key, "dev@localhost");

    expect(result).toMatchObject({ key, outcome: "imported" });
    const id = (result as { messageIds: number[] }).messageIds[0];
    expect(await messageRow(id)).toMatchObject({ folder: "inbox", is_read: 0, message_id: "<simple-1@example.com>" });
  });

  it("signale en doublon un orphelin dont le Message-ID existe déjà sous un autre brut", async () => {
    const first = await ingest(loadBytes("simple.eml"));
    // Même message, octets différents (un en-tête Received de plus) : autre clé, même Message-ID.
    const copy = textBytes(`Received: from relay.example.com\r\n${new TextDecoder().decode(loadBytes("simple.eml"))}`);
    const key = await rawKeyOf(copy);
    await env.MAIL.put(key, copy);

    const result = await reimportKey(env, key, "dev@localhost");

    expect(result).toEqual({ key, outcome: "duplicate", messageIds: [first.id] });
    expect(await countMessages()).toBe(1);
  });

  it("renvoie not_found quand l'objet R2 n'existe pas", async () => {
    const key = `raw/${"0".repeat(64)}.eml`;
    expect(await reimportKey(env, key, "dev@localhost")).toEqual({ key, outcome: "not_found" });
  });
});

describe("reimportKey — réanalyse sur place", () => {
  it("remplace le contenu issu du parsing et conserve id, thread, dossier et état lu", async () => {
    const msg = await ingest(loadBytes("simple.eml"));
    await setRead(env.DB, msg.id, true);
    // Simule un ancien parsing défectueux.
    await env.DB.prepare("UPDATE messages SET subject = 'ancien', parse_error = 1 WHERE id = ?").bind(msg.id).run();
    const before = await messageRow(msg.id);
    const totalsBefore = await threadTotals();

    const result = await reimportKey(env, msg.rawKey, "dev@localhost");

    expect(result).toEqual({ key: msg.rawKey, outcome: "reparsed", messageIds: [msg.id] });
    expect(await messageRow(msg.id)).toMatchObject({
      id: msg.id,
      thread_id: before!.thread_id,
      folder: "inbox",
      is_read: 1,
      subject: "Facture réglée",
      parse_error: 0,
    });
    expect(await threadTotals()).toEqual(totalsBefore);
    expect(await countMessages()).toBe(1);
  });

  it("laisse un message de la corbeille à la corbeille sans toucher aux compteurs", async () => {
    const msg = await ingest(loadBytes("simple.eml"));
    await moveToFolder(env.DB, msg.id, "trash");
    const totalsBefore = await threadTotals();

    await reimportKey(env, msg.rawKey, "dev@localhost");

    expect(await messageRow(msg.id)).toMatchObject({ folder: "trash", is_read: 0 });
    expect(await threadTotals()).toEqual(totalsBefore);
  });

  it("ne duplique pas un message dont le Message-ID a été inventé", async () => {
    const msg = await ingest(loadBytes("malformed.eml"));
    const before = await messageRow(msg.id);

    const result = await reimportKey(env, msg.rawKey, "dev@localhost");

    expect(result).toMatchObject({ outcome: "reparsed", messageIds: [msg.id] });
    expect(await countMessages()).toBe(1);
    expect((await messageRow(msg.id))!.message_id).toBe(before!.message_id);
  });

  it("réanalyse chaque ligne qui partage le même brut", async () => {
    // Deux livraisons identiques d'un message sans Message-ID : même clé, deux lignes.
    const a = await ingest(textBytes(NO_MESSAGE_ID));
    const b = await ingest(textBytes(NO_MESSAGE_ID));
    expect(a.rawKey).toBe(b.rawKey);
    const ids = [(await messageRow(a.id))!.message_id, (await messageRow(b.id))!.message_id];

    const result = await reimportKey(env, a.rawKey, "dev@localhost");

    expect(result).toMatchObject({ outcome: "reparsed", messageIds: [a.id, b.id] });
    expect(await countMessages()).toBe(2);
    expect([(await messageRow(a.id))!.message_id, (await messageRow(b.id))!.message_id]).toEqual(ids);
  });

  it("supprime les anciennes pièces jointes remplacées, après validation", async () => {
    const msg = await ingest(loadBytes("attachment.eml"));
    // Simule une pièce jointe rangée sous une clé que le nouveau parsing ne produit plus.
    await env.MAIL.put("att/ancien/0-vieux.csv", "x");
    await env.DB.prepare("UPDATE attachments SET r2_key = 'att/ancien/0-vieux.csv' WHERE message_id = ?").bind(msg.id).run();

    await reimportKey(env, msg.rawKey, "dev@localhost");

    expect(await env.MAIL.head("att/ancien/0-vieux.csv")).toBeNull();
    const att = await env.DB.prepare("SELECT r2_key FROM attachments WHERE message_id = ?").bind(msg.id).first<{ r2_key: string }>();
    expect(att!.r2_key).toBe("att/att-1-example.com/0-data.csv");
    expect(await env.MAIL.head(att!.r2_key)).not.toBeNull();
  });

  it("échoue sans rien modifier quand le nouveau Message-ID appartient à un autre message", async () => {
    const msg = await ingest(loadBytes("simple.eml"));
    await env.DB.prepare("UPDATE messages SET message_id = '<ancien@example.com>' WHERE id = ?").bind(msg.id).run();
    const other = await insertRow({ rawKey: "raw/autre.eml", messageId: "<simple-1@example.com>" });

    const result = await reimportKey(env, msg.rawKey, "dev@localhost");

    expect(result).toMatchObject({ key: msg.rawKey, outcome: "error" });
    expect((result as { error: string }).error).toContain(`#${other}`);
    expect((await messageRow(msg.id))!.message_id).toBe("<ancien@example.com>");
  });

  it("nettoie les pièces jointes écrites si le lot D1 échoue", async () => {
    const msg = await ingest(loadBytes("attachment.eml"));
    // Ancienne clé différente de celle que le nouveau parsing va écrire.
    await env.DB.batch([
      env.DB.prepare("UPDATE messages SET message_id = '<att-ancien@example.com>' WHERE id = ?").bind(msg.id),
      env.DB.prepare("UPDATE attachments SET r2_key = 'att/att-ancien-example.com/0-data.csv' WHERE message_id = ?").bind(msg.id),
    ]);
    await env.MAIL.put("att/att-ancien-example.com/0-data.csv", "a,b,c");
    await env.MAIL.delete("att/att-1-example.com/0-data.csv");
    const failingDb = new Proxy(env.DB, {
      get(target, prop) {
        if (prop === "batch") return async () => { throw new Error("D1 indisponible"); };
        const value = Reflect.get(target, prop);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });

    const result = await reimportKey({ ...env, DB: failingDb }, msg.rawKey, "dev@localhost");

    expect(result).toMatchObject({ outcome: "error", error: "D1 indisponible" });
    expect(await env.MAIL.head("att/att-1-example.com/0-data.csv")).toBeNull();
    expect(await env.MAIL.head("att/att-ancien-example.com/0-data.csv")).not.toBeNull();
  });
});

describe("reimportKey — garanties", () => {
  it("ne lit ni ne modifie les règles de redirection", async () => {
    await env.DB.prepare(
      "INSERT INTO forward_rules (match_local, destination, enabled, created_at) VALUES ('*', 'ext@example.com', 1, 0)"
    ).run();
    const raw = loadBytes("simple.eml");
    const key = await rawKeyOf(raw);
    await env.MAIL.put(key, raw);

    await reimportKey(env, key, "dev@localhost");

    const rule = await env.DB.prepare("SELECT last_attempt_at FROM forward_rules").first<{ last_attempt_at: number | null }>();
    expect(rule!.last_attempt_at).toBeNull();
  });

  it("ne supprime jamais le brut", async () => {
    const msg = await ingest(loadBytes("simple.eml"));
    await reimportKey(env, msg.rawKey, "dev@localhost");
    expect(await env.MAIL.head(msg.rawKey)).not.toBeNull();
  });

  it("journalise chaque réimport avec son auteur", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const key = `raw/${"0".repeat(64)}.eml`;

    await reimportKey(env, key, "dev@localhost");

    const lines = log.mock.calls.map(([line]) => JSON.parse(String(line)));
    expect(lines).toContainEqual({ event: "reimport", key, outcome: "not_found", by: "dev@localhost" });
    log.mockRestore();
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm vitest run test/admin/reimport.test.ts`
Expected: FAIL — `reimportKey` is not exported.

- [ ] **Step 3: Implement**

In `src/admin/reimport.ts`, replace the import line with:

```ts
import type { Env } from "../env";
import { parseEmail, snippetOf } from "../ingest/parse";
import {
  attachmentStatements,
  putAttachments,
  recipientStatements,
  storeIncoming,
  truncateBody,
} from "../ingest/store";
```

Append to the file:

```ts
// Expéditeur d'enveloppe d'un orphelin : l'enveloppe n'est stockée nulle part. L'en-tête
// From prime ; cette valeur n'apparaît que si le message est totalement illisible. .invalid
// est le TLD réservé à cet usage (RFC 2606).
export const ORPHAN_ENVELOPE_FROM = "unknown@invalid";

export type ReimportResult =
  | { key: string; outcome: "imported"; messageIds: number[] }
  | { key: string; outcome: "reparsed"; messageIds: number[] }
  | { key: string; outcome: "duplicate"; messageIds: number[] }
  | { key: string; outcome: "not_found" }
  | { key: string; outcome: "error"; error: string };

type ExistingRow = { id: number; message_id: string; from_addr: string };

// Supprime des objets R2 sans jamais lever : un échec ici ne laisse qu'un objet de pièce
// jointe inutilisé, jamais une perte de contenu.
async function deleteQuietly(env: Env, keys: string[], rawKey: string): Promise<void> {
  if (keys.length === 0) return;
  try {
    await env.MAIL.delete(keys);
  } catch (err) {
    console.error(JSON.stringify({
      event: "reimport_cleanup_failed",
      key: rawKey,
      objects: keys,
      error: err instanceof Error ? err.message : String(err),
    }));
  }
}

// Réanalyse une ligne existante sur place. Seules les colonnes issues du parsing sont
// réécrites : id, thread_id, folder, is_read, direction et raw_key ne bougent jamais, donc
// les compteurs du thread non plus, et aucun thread ne peut se retrouver vide.
async function reparseInPlace(env: Env, rawKey: string, raw: ArrayBuffer, row: ExistingRow): Promise<void> {
  const msg = await parseEmail(raw, row.from_addr);
  // Un identifiant inventé change à chaque parsing : on garde celui déjà en base.
  const messageId = msg.messageIdSynthetic ? row.message_id : msg.messageId;

  if (messageId !== row.message_id) {
    const clash = await env.DB.prepare("SELECT id FROM messages WHERE message_id = ? AND id != ?")
      .bind(messageId, row.id).first<{ id: number }>();
    if (clash) throw new Error(`Message-ID déjà utilisé par le message #${clash.id}`);
  }

  const oldKeys = (await env.DB.prepare("SELECT r2_key FROM attachments WHERE message_id = ?")
    .bind(row.id).all<{ r2_key: string }>()).results.map((r) => r.r2_key);

  // R2 d'abord : les nouvelles pièces jointes existent avant la ligne qui les référence.
  const stored = await putAttachments(env, messageId, msg.attachments);
  const newKeys = stored.map((s) => s.r2Key);

  const text = truncateBody(msg.text);
  const html = truncateBody(msg.html);

  try {
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE messages
            SET message_id = ?, in_reply_to = ?, from_addr = ?, from_name = ?, subject = ?,
                text_body = ?, html_body = ?, snippet = ?, received_at = ?, has_attachments = ?,
                parse_error = ?, body_truncated = ?
          WHERE id = ?`
      ).bind(
        messageId, msg.inReplyTo, msg.from.address, msg.from.name, msg.subject,
        text.value, html.value, snippetOf(msg.text || msg.subject), msg.date,
        msg.attachments.length > 0 ? 1 : 0, msg.parseError ? 1 : 0,
        text.truncated || html.truncated ? 1 : 0, row.id,
      ),
      env.DB.prepare("DELETE FROM recipients WHERE message_id = ?").bind(row.id),
      ...recipientStatements(env.DB, row.id, msg),
      env.DB.prepare("DELETE FROM attachments WHERE message_id = ?").bind(row.id),
      ...attachmentStatements(env.DB, row.id, stored),
      // La date du message a pu changer : on recalcule celle du thread sur ses messages.
      env.DB.prepare(
        `UPDATE threads
            SET last_message_at = (SELECT MAX(received_at) FROM messages WHERE thread_id = threads.id)
          WHERE id = (SELECT thread_id FROM messages WHERE id = ?)`
      ).bind(row.id),
    ]);
  } catch (err) {
    // Lot annulé : la ligne pointe toujours vers les anciennes clés. On retire les objets
    // écrits pour rien ; une clé commune aux deux ensembles a été réécrite avec des octets
    // tirés du même brut, rien n'est perdu.
    await deleteQuietly(env, newKeys.filter((k) => !oldKeys.includes(k)), rawKey);
    throw err;
  }

  // Lot validé : plus rien ne référence les anciennes clés absentes du nouvel ensemble.
  await deleteQuietly(env, oldKeys.filter((k) => !newKeys.includes(k)), rawKey);
}

async function reimport(env: Env, rawKey: string): Promise<ReimportResult> {
  const obj = await env.MAIL.get(rawKey);
  if (!obj) return { key: rawKey, outcome: "not_found" };
  const raw = await obj.arrayBuffer();

  const rows = await env.DB.prepare(
    "SELECT id, message_id, from_addr FROM messages WHERE raw_key = ? AND direction = 'in' ORDER BY id"
  ).bind(rawKey).all<ExistingRow>();

  if (rows.results.length === 0) {
    // Orphelin : même chemin qu'un message qui arrive. Son écriture R2 est un no-op (clé
    // adressée par contenu, objet déjà présent). Aucune redirection n'est rejouée.
    const res = await storeIncoming(env, raw, { from: ORPHAN_ENVELOPE_FROM, to: "" });
    const ids = res.messageId === null ? [] : [res.messageId];
    return { key: rawKey, outcome: res.duplicate ? "duplicate" : "imported", messageIds: ids };
  }

  for (const row of rows.results) await reparseInPlace(env, rawKey, raw, row);
  return { key: rawKey, outcome: "reparsed", messageIds: rows.results.map((r) => r.id) };
}

// Point d'entrée unique du réimport. Ne lève jamais : un échec devient un résultat, pour
// qu'un message défaillant ne masque pas les autres clés du même lot.
export async function reimportKey(env: Env, rawKey: string, by: string): Promise<ReimportResult> {
  let result: ReimportResult;
  try {
    result = await reimport(env, rawKey);
  } catch (err) {
    result = { key: rawKey, outcome: "error", error: err instanceof Error ? err.message : String(err) };
  }
  console.log(JSON.stringify({ event: "reimport", ...result, by }));
  return result;
}
```

In `src/email.ts`: delete the whole `reparse` function (and its comment block), remove `import { parseEmail } from "./ingest/parse";`, and change the store import back to `import { storeIncoming } from "./ingest/store";`.

In `test/email-handler.test.ts`: delete the entire `describe("reparse", () => { … });` block, change the import to `import { FORWARD_TIMEOUT_MS, handleEmail } from "../src/email";`, and remove the `import { moveToFolder, setRead } from "../src/db/mutations";` line if nothing else in the file uses them (`grep -n "moveToFolder\|setRead" test/email-handler.test.ts` to check).

- [ ] **Step 4: Run to verify they pass**

Run: `pnpm vitest run && pnpm typecheck`
Expected: PASS — the whole Worker suite, no reference to `reparse` left (`grep -rn "reparse(" src test` returns nothing).

- [ ] **Step 5: Commit**

```bash
git add src/admin/reimport.ts src/email.ts test/admin/reimport.test.ts test/email-handler.test.ts
git commit -m "feat(admin): re-import raw messages, re-parsing existing rows in place"
```

---

### Task 5: `/api/admin/*` routes

**Files:**
- Modify: `src/api/routes.ts`
- Create: `test/api/admin.test.ts`

**Interfaces:**
- Consumes: `listOrphans`, `listParseErrors`, `reimportKey`, `RAW_KEY_PATTERN` (Tasks 3–4).
- Produces (HTTP, all behind `requireAccess()` via the existing `app.use("/api/*", …)`):
  - `GET /api/admin/orphans?cursor=` → 200 `{ orphans: Orphan[], cursor: string | null }`; 400 `invalid_query`; 503 `storage_unavailable`.
  - `GET /api/admin/parse-errors?cursor=` → 200 `{ messages: ParseErrorMessage[], cursor: string | null }`; 400; 503.
  - `POST /api/admin/reimport` body `{ keys: string[] }` → 200 `{ results: ReimportResult[] }` (in request order, duplicates collapsed); 400 `invalid_body`.

- [ ] **Step 1: Write the failing tests**

Create `test/api/admin.test.ts`:

```ts
import { env, applyD1Migrations } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { app } from "../../src/index";

interface TestEnv {
  TEST_FIXTURES: Record<string, string>;
  TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
}

const testEnv = env as unknown as TestEnv;

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

const withEnv = (over: Record<string, unknown> = {}) => ({ ...env, DEV_BYPASS_AUTH: "1", MAIL_DOMAIN: "example.com", ...over });

const req = (path: string, init?: RequestInit, over?: Record<string, unknown>) =>
  app.request(`https://example.com${path}`, init ?? {}, withEnv(over));

const postReimport = (body: unknown) =>
  req("/api/admin/reimport", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const key = (c: string) => `raw/${c.repeat(64)}.eml`;

const loadBytes = (name: string): ArrayBuffer => {
  const binary = atob(testEnv.TEST_FIXTURES[name]);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
};

describe("accès", () => {
  it("refuse les routes d'administration sans jeton Access", async () => {
    const res = await app.request("https://example.com/api/admin/orphans", {}, { ...env, DEV_BYPASS_AUTH: "" });
    expect(res.status).toBe(401);
  });
});

describe("GET /api/admin/orphans", () => {
  it("renvoie les orphelins et le curseur", async () => {
    await env.MAIL.put(key("a"), loadBytes("simple.eml"));
    const res = await req("/api/admin/orphans");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ orphans: [{ key: key("a") }], cursor: null });
  });

  it("refuse un curseur démesuré", async () => {
    const res = await req(`/api/admin/orphans?cursor=${"x".repeat(2000)}`);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: "invalid_query" } });
  });

  it("répond 503 quand R2 est indisponible", async () => {
    const brokenMail = { list: async () => { throw new Error("r2 down"); } };
    const res = await req("/api/admin/orphans", {}, { MAIL: brokenMail });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: { code: "storage_unavailable" } });
  });
});

describe("GET /api/admin/parse-errors", () => {
  it("refuse un curseur non numérique", async () => {
    const res = await req("/api/admin/parse-errors?cursor=abc");
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: "invalid_query", message: "Curseur invalide" } });
  });

  it("renvoie une liste vide quand aucun message n'est en erreur", async () => {
    const res = await req("/api/admin/parse-errors");
    expect(await res.json()).toEqual({ messages: [], cursor: null });
  });
});

describe("POST /api/admin/reimport", () => {
  it.each([
    ["une liste vide", { keys: [] }],
    ["plus de dix clés", { keys: Array.from({ length: 11 }, (_, i) => key(i.toString(16))) }],
    ["une clé de message envoyé", { keys: ["sent/<a@example.com>"] }],
    ["une clé de pièce jointe", { keys: ["att/a-example.com/0-data.csv"] }],
    ["un chemin détourné", { keys: ["raw/../att/x.eml"] }],
    ["un corps absent", null],
  ])("refuse %s", async (_label, body) => {
    const res = await postReimport(body);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: "invalid_body" } });
  });

  it("répond 200 avec un résultat par clé, même quand certaines échouent", async () => {
    await env.MAIL.put(key("a"), loadBytes("simple.eml"));

    const res = await postReimport({ keys: [key("a"), key("b"), key("a")] });

    expect(res.status).toBe(200);
    const body = await res.json() as { results: { key: string; outcome: string }[] };
    expect(body.results.map((r) => [r.key, r.outcome])).toEqual([
      [key("a"), "imported"],
      [key("b"), "not_found"],
    ]);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm vitest run test/api/admin.test.ts`
Expected: FAIL — routes return 404.

- [ ] **Step 3: Implement**

In `src/api/routes.ts`, add the import:

```ts
import { RAW_KEY_PATTERN, listOrphans, listParseErrors, reimportKey } from "../admin/reimport";
```

Add next to the other zod schemas:

```ts
// Un lot de réimport reste petit : chaque clé coûte plusieurs sous-requêtes R2 et D1, et
// c'est le SPA qui enchaîne les lots pour une sélection plus grande.
const REIMPORT_MAX_KEYS = 10;

const orphansQuery = z.object({ cursor: z.string().min(1).max(1024).optional() });

const parseErrorsQuery = z.object({
  cursor: z.string().refine((v) => /^\d{1,15}$/.test(v), { message: "Curseur invalide" }).optional(),
});

const reimportBody = z.object({
  keys: z.array(z.string()).min(1).max(REIMPORT_MAX_KEYS).refine(
    (keys) => keys.every((k) => RAW_KEY_PATTERN.test(k)),
    { message: "Clé invalide : seuls les bruts de messages reçus (raw/<sha256>.eml) sont réimportables" },
  ),
});
```

Add next to `routingUnavailableResponse`:

```ts
// Une panne R2 ou D1 pendant un listage d'administration : « je ne sais pas », pas une liste
// vide qui ferait croire qu'il n'y a aucun orphelin. Le détail part dans les logs.
const storageUnavailableResponse = (path: string, err: unknown) => {
  console.error(JSON.stringify({
    event: "admin_listing_failed",
    path,
    error: err instanceof Error ? err.message : String(err),
  }));
  return Response.json({
    error: {
      code: "storage_unavailable",
      message: "Impossible de lire le stockage des messages. Réessayez dans un instant.",
    },
  }, { status: 503 });
};
```

Add the routes at the end of the file:

```ts
api.get("/admin/orphans", async (c) => {
  const parsed = orphansQuery.safeParse(c.req.query());
  if (!parsed.success) {
    return c.json({ error: { code: "invalid_query", message: formatValidationError(parsed.error) } }, 400);
  }
  try {
    return c.json(await listOrphans(c.env, { cursor: parsed.data.cursor }));
  } catch (err) {
    return storageUnavailableResponse("/admin/orphans", err);
  }
});

api.get("/admin/parse-errors", async (c) => {
  const parsed = parseErrorsQuery.safeParse(c.req.query());
  if (!parsed.success) {
    return c.json({ error: { code: "invalid_query", message: formatValidationError(parsed.error) } }, 400);
  }
  const cursor = parsed.data.cursor === undefined ? undefined : Number(parsed.data.cursor);
  try {
    return c.json(await listParseErrors(c.env, { cursor }));
  } catch (err) {
    return storageUnavailableResponse("/admin/parse-errors", err);
  }
});

// Réimporte des bruts un par un, dans l'ordre de la requête. 200 même si certaines clés
// échouent : chaque clé porte son propre résultat (voir reimportKey).
api.post("/admin/reimport", async (c) => {
  const parsed = reimportBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: { code: "invalid_body", message: formatValidationError(parsed.error) } }, 400);
  }
  const by = c.get("identity").email;
  const results = [];
  for (const key of new Set(parsed.data.keys)) results.push(await reimportKey(c.env, key, by));
  return c.json({ results });
});
```

Check the error code the existing POST routes use for a bad body (`grep -n "invalid_body\|invalid_request" src/api/routes.ts`); if they use a different code than `invalid_body`, use theirs here and in the test.

- [ ] **Step 4: Run to verify they pass**

Run: `pnpm vitest run && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/api/routes.ts test/api/admin.test.ts
git commit -m "feat(api): admin routes to list orphans and parse errors and re-import"
```

---

### Task 6: `rawKey` on message detail and SPA client functions

**Files:**
- Modify: `src/db/queries.ts` (`MessageDetail`, `getThread`)
- Modify: `test/api/read.test.ts`
- Modify: `web/src/api/client.ts`
- Create: `web/src/lib/reimport.ts`
- Modify: `web/src/components/ThreadView.test.tsx`, `web/src/components/Composer.test.tsx` (add `rawKey` to every `MessageDetail` literal)
- Test: `web/src/api/client.test.tsx`, `web/src/lib/reimport.test.ts`

**Interfaces:**
- Produces (Worker): `MessageDetail.rawKey: string`.
- Produces (`web/src/api/client.ts`):
  - `MessageDetail.rawKey: string`
  - types `Orphan`, `OrphansPage`, `ParseErrorMessage`, `ReimportResult` (mirrors of the Worker types)
  - `REIMPORT_BATCH_SIZE = 10`
  - `fetchOrphans(cursor: string | null): Promise<OrphansPage>`
  - `reimportKeys(keys: string[]): Promise<ReimportResult[]>`
  - `reimportInBatches(keys: string[], onBatch: (results: ReimportResult[]) => void): Promise<void>` — sequential batches of 10; rejects on the first failed request, after `onBatch` has run for the earlier batches.
  - `useParseErrors()` — `useQuery` keyed `["parseErrors"]`, returns every page flattened as `ParseErrorMessage[]`.
  - `useReimportMessage()` — `useMutation` taking a raw key, resolving to one `ReimportResult`, invalidating `["threads"]`, `["thread"]`, `["parseErrors"]` on settle.
- Produces (`web/src/lib/reimport.ts`): `outcomeLabel(result: ReimportResult): string`.

- [ ] **Step 1: Write the failing tests**

In `test/api/read.test.ts`, inside `describe("getThread", …)`, add (reusing the file's existing setup that inserts thread 1; read the first existing `getThread` test to see what `raw_key` it inserts and use that value):

```ts
  it("expose la clé du brut de chaque message", async () => {
    const t = await getThread(env.DB, 1);
    expect(t!.messages[0].rawKey).toEqual(expect.any(String));
    expect(t!.messages[0].rawKey.length).toBeGreaterThan(0);
  });
```

Append to `web/src/api/client.test.tsx`:

```ts
import { reimportInBatches, type ReimportResult } from "./client";

describe("reimportInBatches", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("envoie les clés par lots de dix et remonte les résultats lot par lot", async () => {
    const bodies: string[][] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      const { keys } = JSON.parse(String(init!.body)) as { keys: string[] };
      bodies.push(keys);
      return Response.json({ results: keys.map((key) => ({ key, outcome: "not_found" })) });
    }));
    const keys = Array.from({ length: 12 }, (_, i) => `raw/${String(i).padStart(64, "0")}.eml`);
    const batches: ReimportResult[][] = [];

    await reimportInBatches(keys, (r) => batches.push(r));

    expect(bodies.map((b) => b.length)).toEqual([10, 2]);
    expect(batches.flat().map((r) => r.key)).toEqual(keys);
  });

  it("s'arrête au premier lot en échec après avoir remonté les précédents", async () => {
    let call = 0;
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      call++;
      if (call === 2) return Response.json({ error: { code: "internal_error", message: "Erreur interne" } }, { status: 500 });
      const { keys } = JSON.parse(String(init!.body)) as { keys: string[] };
      return Response.json({ results: keys.map((key) => ({ key, outcome: "imported", messageIds: [1] })) });
    }));
    const keys = Array.from({ length: 15 }, (_, i) => `raw/${String(i).padStart(64, "0")}.eml`);
    const batches: ReimportResult[][] = [];

    await expect(reimportInBatches(keys, (r) => batches.push(r))).rejects.toThrow("Erreur interne");
    expect(batches).toHaveLength(1);
  });
});
```

(Merge the `vitest` imports — `afterEach`, `describe`, `expect`, `it`, `vi` — with the file's existing import line.)

Create `web/src/lib/reimport.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { ReimportResult } from "../api/client";
import { outcomeLabel } from "./reimport";

const key = "raw/x.eml";
const cases: [ReimportResult, string][] = [
  [{ key, outcome: "imported", messageIds: [3] }, "Importé"],
  [{ key, outcome: "reparsed", messageIds: [3] }, "Réanalysé"],
  [{ key, outcome: "duplicate", messageIds: [7] }, "Déjà présent (message #7)"],
  [{ key, outcome: "not_found" }, "Introuvable dans le stockage"],
  [{ key, outcome: "error", error: "D1 indisponible" }, "Échec : D1 indisponible"],
];

describe("outcomeLabel", () => {
  it.each(cases)("libelle %o", (result, label) => {
    expect(outcomeLabel(result)).toBe(label);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm vitest run test/api/read.test.ts && pnpm --filter web test`
Expected: FAIL — `rawKey` undefined; `reimportInBatches` and `./reimport` missing.

- [ ] **Step 3: Implement**

`src/db/queries.ts`:
- Add `rawKey: string;` to `MessageDetail` (after `bodyTruncated: boolean;`).
- In `getThread`'s SQL add `raw_key` to the selected columns (after `body_truncated`), add `raw_key: string;` to the row type, and `rawKey: m.raw_key,` to the mapped object (after `bodyTruncated`).

`web/src/api/client.ts`:
- Add `rawKey: string;` to `MessageDetail` after `bodyTruncated: boolean;`, with the comment `// Clé du brut dans R2 : sert au réimport d'un message reçu.`
- Append:

```ts
// Miroirs volontaires de src/admin/reimport.ts, comme les types ci-dessus.
export type Orphan = { key: string; size: number; uploaded: string };
export type OrphansPage = { orphans: Orphan[]; cursor: string | null };
export type ParseErrorMessage = { id: number; rawKey: string; subject: string | null; receivedAt: number };
type ParseErrorsPage = { messages: ParseErrorMessage[]; cursor: string | null };
export type ReimportResult =
  | { key: string; outcome: "imported"; messageIds: number[] }
  | { key: string; outcome: "reparsed"; messageIds: number[] }
  | { key: string; outcome: "duplicate"; messageIds: number[] }
  | { key: string; outcome: "not_found" }
  | { key: string; outcome: "error"; error: string };

// Taille maximale d'un lot accepté par POST /api/admin/reimport.
export const REIMPORT_BATCH_SIZE = 10;

const withCursor = (path: string, cursor: string | null) =>
  cursor === null ? path : `${path}?cursor=${encodeURIComponent(cursor)}`;

export const fetchOrphans = (cursor: string | null) =>
  api<OrphansPage>(withCursor("/admin/orphans", cursor));

export const reimportKeys = (keys: string[]) =>
  api<{ results: ReimportResult[] }>("/admin/reimport", {
    method: "POST",
    body: JSON.stringify({ keys }),
  }).then((r) => r.results);

// Enchaîne les lots séquentiellement et remonte chaque lot dès sa réponse : si un lot
// échoue, les résultats des lots précédents sont déjà affichés.
export async function reimportInBatches(
  keys: string[],
  onBatch: (results: ReimportResult[]) => void,
): Promise<void> {
  for (let i = 0; i < keys.length; i += REIMPORT_BATCH_SIZE) {
    onBatch(await reimportKeys(keys.slice(i, i + REIMPORT_BATCH_SIZE)));
  }
}

// Toutes les pages d'un coup : la liste sert à « Tout réimporter », qui a besoin de toutes
// les clés, et le nombre de messages en erreur d'analyse reste faible.
export const useParseErrors = () =>
  useQuery({
    queryKey: ["parseErrors"],
    queryFn: async () => {
      const all: ParseErrorMessage[] = [];
      let cursor: string | null = null;
      do {
        const page: ParseErrorsPage = await api<ParseErrorsPage>(withCursor("/admin/parse-errors", cursor));
        all.push(...page.messages);
        cursor = page.cursor;
      } while (cursor !== null);
      return all;
    },
  });

export const useReimportMessage = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (rawKey: string) => reimportKeys([rawKey]).then((r) => r[0]),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ["threads"] });
      qc.invalidateQueries({ queryKey: ["thread"] });
      qc.invalidateQueries({ queryKey: ["parseErrors"] });
    },
  });
};
```

Create `web/src/lib/reimport.ts`:

```ts
import type { ReimportResult } from "../api/client";

// Libellé affiché pour le résultat du réimport d'une clé.
export function outcomeLabel(result: ReimportResult): string {
  switch (result.outcome) {
    case "imported":
      return "Importé";
    case "reparsed":
      return "Réanalysé";
    case "duplicate":
      return `Déjà présent (message #${result.messageIds[0]})`;
    case "not_found":
      return "Introuvable dans le stockage";
    case "error":
      return `Échec : ${result.error}`;
  }
}
```

In `web/src/components/ThreadView.test.tsx` and `web/src/components/Composer.test.tsx`, add a `rawKey` to every object literal that has `bodyTruncated:` (`grep -n "bodyTruncated" web/src/components/*.test.tsx` lists them). In `ThreadView.test.tsx` use exactly `rawKey: "raw/a.eml"` for message `id: 10` and `rawKey: "raw/b.eml"` for message `id: 11` (Task 8's tests rely on these); in `Composer.test.tsx` any distinct `"raw/<letter>.eml"` value.

- [ ] **Step 4: Run to verify they pass**

Run: `pnpm vitest run && pnpm typecheck && pnpm --filter web test && pnpm build`
Expected: PASS; `pnpm build` confirms the SPA typechecks with the new required field.

- [ ] **Step 5: Commit**

```bash
git add src/db/queries.ts test/api/read.test.ts web/src/api/client.ts web/src/api/client.test.tsx web/src/lib/reimport.ts web/src/lib/reimport.test.ts web/src/components/ThreadView.test.tsx web/src/components/Composer.test.tsx
git commit -m "feat(web): client calls for listing and re-importing raw messages"
```

---

### Task 7: Maintenance view

**Files:**
- Create: `web/src/components/MaintenanceSettings.tsx`
- Create: `web/src/components/MaintenanceSettings.test.tsx`
- Modify: `web/src/components/Sidebar.tsx`, `web/src/App.tsx`

**Interfaces:**
- Consumes: `fetchOrphans`, `reimportInBatches`, `useParseErrors`, types (Task 6); `outcomeLabel` (Task 6).
- Produces: `MaintenanceSettings` component; view id `"maintenance"` in `App.tsx` and `Sidebar.tsx`.

- [ ] **Step 1: Write the failing tests**

Create `web/src/components/MaintenanceSettings.test.tsx`:

```tsx
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MaintenanceSettings } from "./MaintenanceSettings";

afterEach(() => vi.unstubAllGlobals());

const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    {children}
  </QueryClientProvider>
);

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const k = (n: number) => `raw/${String(n).padStart(64, "0")}.eml`;
const orphan = (n: number) => ({ key: k(n), size: 2048, uploaded: "2026-09-20T10:00:00.000Z" });

type Stub = {
  orphanPages?: Record<string, unknown>; // curseur ("" pour la première page) -> réponse
  failOrphanCursor?: string;
  parseErrors?: unknown[];
  reimport?: (keys: string[]) => unknown[];
};

const stubApi = (opts: Stub) => {
  const posts: string[][] = [];
  const failed = new Set<string>();
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (url.startsWith("/api/admin/orphans")) {
      const cursor = new URL(url, "https://x").searchParams.get("cursor") ?? "";
      // Échoue une seule fois, pour tester la reprise.
      if (cursor === opts.failOrphanCursor && !failed.has(cursor)) {
        failed.add(cursor);
        return json({ error: { code: "storage_unavailable", message: "Stockage indisponible" } }, 503);
      }
      return json(opts.orphanPages?.[cursor] ?? { orphans: [], cursor: null });
    }
    if (url.startsWith("/api/admin/parse-errors")) {
      return json({ messages: opts.parseErrors ?? [], cursor: null });
    }
    if (url === "/api/admin/reimport") {
      const { keys } = JSON.parse(String(init!.body)) as { keys: string[] };
      posts.push(keys);
      return json({ results: (opts.reimport ?? ((ks) => ks.map((key) => ({ key, outcome: "imported", messageIds: [1] }))))(keys) });
    }
    return json({});
  }));
  return posts;
};

describe("MaintenanceSettings — orphelins", () => {
  it("parcourt toutes les pages de l'analyse", async () => {
    stubApi({
      orphanPages: {
        "": { orphans: [orphan(1)], cursor: "c1" },
        c1: { orphans: [], cursor: "c2" },
        c2: { orphans: [orphan(2)], cursor: null },
      },
    });
    render(<MaintenanceSettings />, { wrapper });

    await userEvent.click(screen.getByRole("button", { name: "Analyser le stockage" }));

    expect(await screen.findByText(k(1))).toBeDefined();
    expect(await screen.findByText(k(2))).toBeDefined();
  });

  it("annonce l'absence d'orphelin", async () => {
    stubApi({});
    render(<MaintenanceSettings />, { wrapper });
    await userEvent.click(screen.getByRole("button", { name: "Analyser le stockage" }));
    expect(await screen.findByText("Aucun message orphelin.")).toBeDefined();
  });

  it("garde les orphelins trouvés et reprend depuis la page en échec", async () => {
    stubApi({
      orphanPages: {
        "": { orphans: [orphan(1)], cursor: "c1" },
        c1: { orphans: [orphan(2)], cursor: null },
      },
      failOrphanCursor: "c1",
    });
    render(<MaintenanceSettings />, { wrapper });

    await userEvent.click(screen.getByRole("button", { name: "Analyser le stockage" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Stockage indisponible");
    expect(screen.getByText(k(1))).toBeDefined();

    await userEvent.click(screen.getByRole("button", { name: "Reprendre" }));
    expect(await screen.findByText(k(2))).toBeDefined();
    expect(screen.getAllByText(k(1))).toHaveLength(1);
  });

  it("réimporte la sélection par lots de dix et affiche chaque résultat", async () => {
    const orphans = Array.from({ length: 12 }, (_, i) => orphan(i));
    const posts = stubApi({
      orphanPages: { "": { orphans, cursor: null } },
      reimport: (keys) => keys.map((key) =>
        key === k(0) ? { key, outcome: "duplicate", messageIds: [7] } : { key, outcome: "imported", messageIds: [1] }),
    });
    render(<MaintenanceSettings />, { wrapper });
    await userEvent.click(screen.getByRole("button", { name: "Analyser le stockage" }));
    await screen.findByText(k(11));

    await userEvent.click(screen.getByRole("checkbox", { name: "Tout sélectionner" }));
    await userEvent.click(screen.getByRole("button", { name: "Réimporter la sélection (12)" }));

    await waitFor(() => expect(posts.map((p) => p.length)).toEqual([10, 2]));
    const row = screen.getByText(k(0)).closest("li")!;
    expect(await within(row).findByText("Déjà présent (message #7)")).toBeDefined();
    expect(screen.getAllByText("Importé")).toHaveLength(11);
  });
});

describe("MaintenanceSettings — erreurs d'analyse", () => {
  it("liste les messages en erreur et les réimporte tous", async () => {
    const posts = stubApi({
      parseErrors: [
        { id: 2, rawKey: k(2), subject: "Relevé", receivedAt: 1757318400 },
        { id: 1, rawKey: k(1), subject: null, receivedAt: 1757318400 },
      ],
      reimport: (keys) => keys.map((key) =>
        key === k(1) ? { key, outcome: "error", error: "D1 indisponible" } : { key, outcome: "reparsed", messageIds: [2] }),
    });
    render(<MaintenanceSettings />, { wrapper });

    expect(await screen.findByText("Relevé")).toBeDefined();
    expect(screen.getByText("(sans objet)")).toBeDefined();

    await userEvent.click(screen.getByRole("button", { name: "Tout réimporter (2)" }));

    await waitFor(() => expect(posts).toEqual([[k(2), k(1)]]));
    expect(await screen.findByText("1 réanalysé(s), 1 échec(s)")).toBeDefined();
    expect(screen.getByText(`${k(1)} — Échec : D1 indisponible`)).toBeDefined();
  });

  it("annonce l'absence de message en erreur", async () => {
    stubApi({});
    render(<MaintenanceSettings />, { wrapper });
    expect(await screen.findByText("Aucun message en erreur d'analyse.")).toBeDefined();
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter web test`
Expected: FAIL — cannot resolve `./MaintenanceSettings`.

- [ ] **Step 3: Implement**

Create `web/src/components/MaintenanceSettings.tsx`:

```tsx
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
  fetchOrphans,
  reimportInBatches,
  useParseErrors,
  type Orphan,
  type ReimportResult,
} from "../api/client";
import { outcomeLabel } from "../lib/reimport";
import { Button } from "./ui/button";

const formatSize = (bytes: number) =>
  bytes < 1024 ? `${bytes} o` : bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} Ko` : `${(bytes / 1024 / 1024).toFixed(1)} Mo`;

const formatDate = (value: string | number) =>
  new Date(typeof value === "number" ? value * 1000 : value).toLocaleString("fr-FR", {
    day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit",
  });

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

// Messages présents dans R2 mais absents de la base : l'analyse parcourt tout le bucket page
// par page, et une page en échec peut être reprise sans perdre les orphelins déjà trouvés.
function OrphansPanel() {
  const qc = useQueryClient();
  const [orphans, setOrphans] = useState<Orphan[]>([]);
  const [scanned, setScanned] = useState(false);
  const [scanning, setScanning] = useState(false);
  // Curseur de la page à redemander après un échec (null : repartir du début).
  const [resumeCursor, setResumeCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [results, setResults] = useState<Map<string, ReimportResult>>(new Map());
  const [importing, setImporting] = useState(false);

  const scan = async (from: string | null) => {
    setScanning(true);
    setError(null);
    if (from === null) {
      setOrphans([]);
      setSelected(new Set());
      setResults(new Map());
      setScanned(false);
    }
    let cursor = from;
    try {
      do {
        const page = await fetchOrphans(cursor);
        setOrphans((prev) => [...prev, ...page.orphans]);
        cursor = page.cursor;
        setResumeCursor(cursor);
      } while (cursor !== null);
      setScanned(true);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setScanning(false);
    }
  };

  const toggle = (key: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const allSelected = orphans.length > 0 && selected.size === orphans.length;

  const reimportSelected = async () => {
    setImporting(true);
    setError(null);
    try {
      await reimportInBatches([...selected], (batch) =>
        setResults((prev) => {
          const next = new Map(prev);
          for (const r of batch) next.set(r.key, r);
          return next;
        }),
      );
      setSelected(new Set());
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setImporting(false);
      qc.invalidateQueries({ queryKey: ["threads"] });
    }
  };

  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-base font-semibold">Messages orphelins</h2>
      <p className="text-sm text-muted-foreground">
        Messages conservés dans le stockage mais absents de la boîte, après un échec lors de leur réception.
      </p>
      <div className="flex gap-2">
        <Button type="button" onClick={() => scan(null)} disabled={scanning || importing}>
          {scanning ? "Analyse en cours…" : "Analyser le stockage"}
        </Button>
        {error !== null && !scanning && resumeCursor !== null && (
          <Button type="button" variant="outline" onClick={() => scan(resumeCursor)}>
            Reprendre
          </Button>
        )}
      </div>

      {error !== null && (
        <p role="alert" className="text-sm text-destructive">{error}</p>
      )}

      {scanned && orphans.length === 0 && (
        <p className="text-sm text-muted-foreground">Aucun message orphelin.</p>
      )}

      {orphans.length > 0 && (
        <>
          <div className="flex items-center justify-between gap-2">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={allSelected}
                onChange={() => setSelected(allSelected ? new Set() : new Set(orphans.map((o) => o.key)))}
              />
              Tout sélectionner
            </label>
            <Button type="button" onClick={reimportSelected} disabled={selected.size === 0 || importing || scanning}>
              {importing ? "Réimport en cours…" : `Réimporter la sélection (${selected.size})`}
            </Button>
          </div>
          <ul className="flex flex-col">
            {orphans.map((o) => {
              const result = results.get(o.key);
              return (
                <li key={o.key} className="flex items-center gap-3 border-b border-border py-2 text-sm">
                  <input
                    type="checkbox"
                    aria-label={`Sélectionner ${o.key}`}
                    checked={selected.has(o.key)}
                    onChange={() => toggle(o.key)}
                  />
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-mono text-xs">{o.key}</p>
                    <p className="text-xs text-muted-foreground">
                      {formatSize(o.size)} — reçu le {formatDate(o.uploaded)}
                    </p>
                  </div>
                  {result && (
                    <span className={result.outcome === "error" || result.outcome === "not_found" ? "text-xs text-destructive" : "text-xs"}>
                      {outcomeLabel(result)}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        </>
      )}
    </section>
  );
}

// Messages que le parseur n'a pas compris : à réimporter après une correction du parseur.
function ParseErrorsPanel() {
  const qc = useQueryClient();
  const { data, error, isLoading } = useParseErrors();
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState<ReimportResult[] | null>(null);
  const [runError, setRunError] = useState<string | null>(null);

  const run = async () => {
    if (!data) return;
    setRunning(true);
    setRunError(null);
    const collected: ReimportResult[] = [];
    try {
      await reimportInBatches([...new Set(data.map((m) => m.rawKey))], (batch) => {
        collected.push(...batch);
        setResults([...collected]);
      });
    } catch (err) {
      setRunError(errorMessage(err));
    } finally {
      setRunning(false);
      qc.invalidateQueries({ queryKey: ["parseErrors"] });
      qc.invalidateQueries({ queryKey: ["threads"] });
    }
  };

  const failures = results?.filter((r) => r.outcome === "error" || r.outcome === "not_found") ?? [];
  const succeeded = (results?.length ?? 0) - failures.length;

  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-base font-semibold">Erreurs d'analyse</h2>
      <p className="text-sm text-muted-foreground">
        Messages reçus qui n'ont pas pu être analysés. Réimportez-les après une mise à jour de Cloudmail.
      </p>

      {isLoading && <p className="text-sm text-muted-foreground">Chargement…</p>}
      {error && <p role="alert" className="text-sm text-destructive">{error.message}</p>}
      {data && data.length === 0 && results === null && (
        <p className="text-sm text-muted-foreground">Aucun message en erreur d'analyse.</p>
      )}

      {data && data.length > 0 && (
        <>
          <div>
            <Button type="button" onClick={run} disabled={running}>
              {running ? "Réimport en cours…" : `Tout réimporter (${data.length})`}
            </Button>
          </div>
          <ul className="flex flex-col">
            {data.map((m) => (
              <li key={m.id} className="flex items-baseline justify-between gap-3 border-b border-border py-2 text-sm">
                <span className="truncate">{m.subject || "(sans objet)"}</span>
                <time className="shrink-0 text-xs text-muted-foreground">{formatDate(m.receivedAt)}</time>
              </li>
            ))}
          </ul>
        </>
      )}

      {runError !== null && <p role="alert" className="text-sm text-destructive">{runError}</p>}

      {results !== null && (
        <div className="flex flex-col gap-1 text-sm">
          <p>{`${succeeded} réanalysé(s), ${failures.length} échec(s)`}</p>
          <ul className="flex flex-col gap-1 text-xs text-destructive">
            {failures.map((r) => (
              <li key={r.key}>{`${r.key} — ${outcomeLabel(r)}`}</li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

export function MaintenanceSettings() {
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-8 p-6">
      <h1 className="text-lg font-semibold">Maintenance</h1>
      <OrphansPanel />
      <ParseErrorsPanel />
    </div>
  );
}
```

Check `web/src/components/ui/button.tsx` for the `variant` prop; if `"outline"` is not a variant, use the same variant `ForwardingSettings.tsx` uses for secondary buttons.

In `web/src/components/Sidebar.tsx`:
- Change both occurrences of the view union to `"mail" | "forwarding" | "identities" | "maintenance"`.
- Add a third `<li>` after the "Redirections" one:

```tsx
        <li>
          <button
            type="button"
            aria-current={view === "maintenance" ? "true" : undefined}
            onClick={() => onSelectView("maintenance")}
            className="w-full rounded px-3 py-2 text-left text-sm hover:bg-accent aria-[current=true]:bg-accent aria-[current=true]:font-semibold"
          >
            Maintenance
          </button>
        </li>
```

In `web/src/App.tsx`:
- Import `import { MaintenanceSettings } from "./components/MaintenanceSettings";`
- Change the state to `useState<"mail" | "forwarding" | "identities" | "maintenance">("mail")`.
- Replace the settings branch:

```tsx
      {view !== "mail" ? (
        <div className="col-span-1 overflow-y-auto lg:col-span-2">
          {view === "forwarding" ? (
            <ForwardingSettings />
          ) : view === "identities" ? (
            <IdentitiesSettings />
          ) : (
            <MaintenanceSettings />
          )}
        </div>
      ) : (
```

- [ ] **Step 4: Run to verify they pass**

Run: `pnpm --filter web test && pnpm build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/components/MaintenanceSettings.tsx web/src/components/MaintenanceSettings.test.tsx web/src/components/Sidebar.tsx web/src/App.tsx
git commit -m "feat(web): maintenance view to recover orphans and re-import parse errors"
```

---

### Task 8: Re-import action on incoming messages

**Files:**
- Modify: `web/src/components/ThreadView.tsx` (`MessageItem`)
- Test: `web/src/components/ThreadView.test.tsx`

**Interfaces:**
- Consumes: `useReimportMessage` (Task 6), `outcomeLabel` (Task 6), `MessageDetail.rawKey`.

- [ ] **Step 1: Write the failing tests**

In `web/src/components/ThreadView.test.tsx`, extend the `fetchMock` in `beforeEach` with a branch before the final `return Response.json({});`:

```ts
      if (url === "/api/admin/reimport") {
        const { keys } = JSON.parse(String(init!.body)) as { keys: string[] };
        return Response.json({ results: keys.map((key) => ({ key, outcome: "reparsed", messageIds: [11] })) });
      }
```

Add `import userEvent from "@testing-library/user-event";` at the top, then append inside `describe("ThreadView", …)`:

```ts
  it("réimporte un message reçu et recharge la conversation", async () => {
    renderThreadView();
    const button = await screen.findByRole("button", { name: "Réimporter" });
    const threadFetchesBefore = fetchMock.mock.calls.filter(([url]) => url === "/api/threads/1").length;

    await userEvent.click(button);

    await waitFor(() => {
      const post = fetchMock.mock.calls.find(([url]) => url === "/api/admin/reimport");
      expect(JSON.parse(String((post![1] as RequestInit).body))).toEqual({ keys: ["raw/b.eml"] });
    });
    await waitFor(() => {
      const after = fetchMock.mock.calls.filter(([url]) => url === "/api/threads/1").length;
      expect(after).toBeGreaterThan(threadFetchesBefore);
    });
  });

  it("affiche le résultat quand le réimport n'aboutit pas", async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === "/api/threads/1") return Response.json(thread);
      if (url === "/api/admin/reimport") {
        return Response.json({ results: [{ key: "raw/b.eml", outcome: "not_found" }] });
      }
      if (url.endsWith("/body")) return Response.json({ html: null, text: "corps", hasRemoteImages: false });
      if (init?.method === "PATCH") return Response.json({ ok: true });
      return Response.json({});
    });
    renderThreadView();

    await userEvent.click(await screen.findByRole("button", { name: "Réimporter" }));

    expect(await screen.findByText("Introuvable dans le stockage")).toBeDefined();
  });

  it("ne propose pas le réimport pour un message envoyé", async () => {
    const sent = { ...thread, messages: [{ ...thread.messages[1], direction: "out" as const, rawKey: "sent/<b@example.com>" }] };
    fetchMock.mockImplementation(async (url: string) =>
      url === "/api/threads/1" ? Response.json(sent) : Response.json({ html: null, text: "corps", hasRemoteImages: false }),
    );
    renderThreadView();

    await screen.findByRole("button", { name: /Répondre/ });
    expect(screen.queryByRole("button", { name: "Réimporter" })).toBeNull();
  });
```

(These rely on the fixture's second message — `id: 11`, expanded by default — having `rawKey: "raw/b.eml"`, set in Task 6.)

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter web test -- ThreadView`
Expected: FAIL — no "Réimporter" button.

- [ ] **Step 3: Implement**

In `web/src/components/ThreadView.tsx`:
- Change the client import to `import { useReimportMessage, useThread, useUpdateMessage, type MessageDetail } from "../api/client";` and add `import { outcomeLabel } from "../lib/reimport";`.
- In `MessageItem`, below `const updateMessage = useUpdateMessage();` add `const reimport = useReimportMessage();`.
- In the actions `<div className="flex gap-2 border-t border-border px-4 py-2">`, after the "Supprimer" button, add:

```tsx
            {/* Un message envoyé n'a pas de brut dans R2 (clé sent/…) : rien à réimporter. */}
            {message.direction === "in" && (
              <button
                type="button"
                className="rounded border border-border px-2 py-1 text-xs hover:bg-accent disabled:opacity-50"
                disabled={reimport.isPending}
                onClick={() => reimport.mutate(message.rawKey)}
              >
                {reimport.isPending ? "Réimport…" : "Réimporter"}
              </button>
            )}
```

- Right after that actions `</div>`, add the feedback (success is visible through the refetched content; only non-successes are spelled out):

```tsx
          {reimport.isError && (
            <p role="alert" className="px-4 pb-2 text-xs text-destructive">
              Réimport impossible : {reimport.error.message}
            </p>
          )}
          {reimport.data && reimport.data.outcome !== "reparsed" && reimport.data.outcome !== "imported" && (
            <p role="status" className="px-4 pb-2 text-xs text-destructive">
              {outcomeLabel(reimport.data)}
            </p>
          )}
```

- [ ] **Step 4: Run to verify they pass**

Run: `pnpm --filter web test && pnpm build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/components/ThreadView.tsx web/src/components/ThreadView.test.tsx
git commit -m "feat(web): re-import action on received messages"
```

---

### Task 9: Documentation

**Files:**
- Modify: `AGENTS.md`
- Modify: `README.md`

No code; verify by reading the result against the code.

- [ ] **Step 1: Update `AGENTS.md`**

1. **Architecture**, in the "HTTP API" bullet's list of resources, add "admin re-import" and mention `src/admin/reimport.ts`.
2. **"No received message is ever lost"**: replace the last two sentences (from "The README's "R2 ↔ D1 reconciliation" section…" to the end of the paragraph) with:
   > The Maintenance view (`GET /api/admin/orphans`, `src/admin/reimport.ts`) finds them by listing `raw/` through the R2 binding and diffing each page against D1; they are recovered by re-importing them.
3. **"Raw MIME storage"**: replace "there is no reverse index, and `wrangler r2 object` has no listing subcommand (only `get`, `put`, `delete` in wrangler 4.x). Listing `raw/` requires R2's S3-compatible API." with:
   > `messages.raw_key` is indexed (`idx_messages_raw_key`) for lookups by key. Inside the Worker, the R2 binding lists `raw/` (`env.MAIL.list`); from a terminal, `wrangler r2 object` has no listing subcommand, so listing requires R2's S3-compatible API.
4. Replace the whole **"Replaying a message (`reparse`)"** section with:

```markdown
## Re-importing a message (`src/admin/reimport.ts`)

`reimportKey(env, rawKey, by)` turns a stored raw MIME back into a message.
It is exposed through `POST /api/admin/reimport` (1 to 10 keys, each matching
`^raw/[0-9a-f]{64}\.eml$`) and the SPA's Maintenance view and message
"Réimporter" action. It never throws: each key gets its own outcome
(`imported`, `reparsed`, `duplicate`, `not_found`, `error`) and one
`{ event: "reimport", …, by }` log line.

- **No row for the key (orphan)**: `storeIncoming`, exactly like new mail —
  inbox, unread, normal threading, envelope sender `unknown@invalid`. If its
  `Message-ID` already belongs to another row (same mail delivered twice with
  different bytes), the outcome is `duplicate` and the orphan stays.
- **Rows exist**: each is re-parsed **in place**, in one atomic D1 batch.
  Only parse-derived columns, recipients and attachments are rewritten; `id`,
  `thread_id`, `folder`, `is_read`, `direction` and `raw_key` never are, so
  thread counters never move and no thread is ever emptied. Rows are found by
  `raw_key`, not by the freshly parsed `Message-ID`: an invented ID
  (`messageIdSynthetic`) changes on every parse, and looking it up used to
  insert a duplicate. An invented ID never overwrites the stored one.
- **Attachment order**: new objects are written before the batch; old keys
  absent from the new set are deleted after it commits; if the batch fails,
  new keys absent from the old set are deleted.
- **It never forwards**, never touches `forward_rules`, and never deletes a
  raw MIME object.
```

5. **Tests section**: update the file counts ("20 files" / "8 files") to the actual counts (`ls test/**/*.test.ts | wc -l` style check: `find test -name '*.test.ts' | wc -l` and `find web/src -name '*.test.ts*' | wc -l`).

- [ ] **Step 2: Update `README.md`**

1. **"Checking that no mail was lost"**: add before the shell block:
   > Open **Maintenance** in the sidebar and click **Analyser le stockage**: it lists every message stored in R2 but missing from the app, and lets you re-import them. The manual procedure below does the same from a terminal and stays useful if the Worker itself can't run.
2. Replace the **"Re-importing a message"** section body with:
   > Any received message can be re-imported from its original copy in R2 — useful after an update that fixes how some messages are parsed. Use **Réimporter** on the message, or **Maintenance → Erreurs d'analyse → Tout réimporter** for every message that failed to parse. Re-importing keeps the message's folder, read state and conversation, and never forwards it again.
3. **Roadmap**: remove the line "An admin entry point for re-importing messages, instead of a temporary route".
4. Wherever the README tells existing installations how to upgrade (search for `migrate:remote`), make sure it says to run `pnpm run migrate:remote` before `pnpm run deploy`; this release adds `migrations/0003_raw_key_index.sql`.

- [ ] **Step 3: Verify**

Run: `grep -n "reparse\|S3-compatible\|no admin route\|Never deploy such a route" AGENTS.md README.md`
Expected: no stale claim remains (the S3 mention survives only as the terminal-listing note and in the README's manual procedure).

Run: `pnpm test && pnpm typecheck && pnpm build`
Expected: PASS — full final check.

- [ ] **Step 4: Commit**

```bash
git add AGENTS.md README.md
git commit -m "docs: document the admin re-import entry point"
```
