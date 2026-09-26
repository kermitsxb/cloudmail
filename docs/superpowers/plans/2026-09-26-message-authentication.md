# Message authentication and Spam folder Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Read Cloudflare's SPF/DKIM/DMARC verdicts on every received message, file DMARC failures in a new Spam folder (purged like the trash), and show a spoofing warning in the SPA.

**Architecture:** Migration `0006` rebuilds `messages` (plus its two child tables, to avoid the `ON DELETE CASCADE` trap) to add `'spam'` to the `folder` `CHECK` and four verdict columns. A pure parser (`src/ingest/auth.ts`) reads only the first `Authentication-Results` header and only if it comes from `mx.cloudflare.net`; `storeIncoming` files `dmarc=fail` as spam. Spam joins the trash as a folder outside the thread counters and inside the retention purge, through one helper in `src/db/folders.ts`.

**Tech Stack:** Cloudflare Workers, D1 (SQLite), R2, Hono, zod, postal-mime, Vitest (`@cloudflare/vitest-plugin` for the Worker, jsdom for `web/`), React + TanStack Query.

**Spec:** `docs/superpowers/specs/2026-09-26-message-authentication-design.md` (issue #26). Read it before starting; `AGENTS.md` holds the project invariants.

## Global Constraints

- The `email()` handler never calls `setReject()`; spam is received, archived, and only filed away.
- Raw MIME is written to R2 before any parsing or D1 write — do not reorder `storeIncoming`.
- Applied migrations are immutable: all schema changes go in the new `migrations/0006_message_authentication.sql`.
- Verdict columns: `auth_spf`, `auth_dkim`, `auth_dmarc` (TEXT, nullable, one of `pass`, `fail`, `softfail`, `neutral`, `none`, `temperror`, `permerror`), `spam_score` (INTEGER, nullable).
- Folder values: `'inbox','sent','trash','spam'`.
- Trust rule: only the **first** `authentication-results` header, only if its authserv-id equals `mx.cloudflare.net` (case-insensitive).
- `dmarc === "fail"` → `spam`; nothing else classifies. `spam_score` is stored, never used, never exposed.
- `trashed_at` = time of entry into `trash` **or** `spam`; column is not renamed.
- `message_count` / `unread_count` count only messages whose folder is neither `trash` nor `spam`.
- Re-parse in place never writes `folder`; forwarding is unchanged.
- Every visible SPA string goes through `useI18n().t`, in `fr.ts` and `en.ts`.
- Tests and docs use neutral values (`example.com`, `you@example.com`); never a real address.
- Test names are in French, code comments in French, like the rest of the repo. Commit messages in English, Conventional Commits, no session URL, no Co-Authored-By.

## Review Focus

- **An authserv-id that only looks like Cloudflare's** (`mx.cloudflare.net.example.com`, `mx.cloudflare.net2`) must yield `NULL` verdicts — test in Task 2.
- **A folded `Authentication-Results` value** (CRLF + tab between clauses, as delivered on the real installation) must parse the same as a single-line one — test in Task 2.
- **A spoofed reply joining an existing inbox thread** must leave that thread's counters and its presence in the inbox list unchanged — test in Task 3.
- **Spam → trash → restore to inbox** must bring the counters back exactly, and **trash → spam** must not touch them — test in Task 4.
- **Messages received before `0006`** (all verdicts `NULL`) must come back with `auth: null` from the API and show no banner — tests in Task 5 and Task 6.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `migrations/0006_message_authentication.sql` (new) | Rebuild `messages`/`recipients`/`attachments`, new columns, `spam` folder |
| `test/db/migration-0006.test.ts` (new) | Migration on a seeded `0005` database, on a dedicated D1 binding |
| `vitest.config.ts` | Adds the `MIGRATION_DB` test-only D1 binding |
| `src/ingest/auth.ts` (new) | Pure `parseAuthentication(headers)` |
| `test/ingest/auth.test.ts` (new) | Parser cases |
| `src/ingest/parse.ts` | `ParsedMessage.auth` |
| `src/ingest/store.ts` | `parsedColumns` verdicts, spam classification |
| `src/admin/reimport.ts` | Re-parse writes the verdict columns |
| `src/db/folders.ts` (new) | `Folder` type, `countsInThread`, `RETAINED_FOLDERS` |
| `src/db/mutations.ts` | `setRead`, `moveToFolder`, `purgeMessage` with spam |
| `src/maintenance/trash.ts` | Purge covers spam |
| `src/api/routes.ts`, `src/db/queries.ts` | `folder: "spam"`, `auth` in thread detail |
| `web/src/api/client.ts` | `auth` type, `spam` folder in mutation |
| `web/src/components/Sidebar.tsx`, `TrashNotice.tsx`, `ThreadView.tsx`, `web/src/App.tsx` | UI |
| `web/src/i18n/fr.ts`, `en.ts` | Strings |
| `AGENTS.md`, `README.md` | Docs |

---

### Task 1: Migration `0006` and its test

**Files:**
- Create: `migrations/0006_message_authentication.sql`
- Create: `test/db/migration-0006.test.ts`
- Modify: `vitest.config.ts` (miniflare options)

**Interfaces:**
- Consumes: nothing.
- Produces: columns `messages.auth_spf`, `auth_dkim`, `auth_dmarc` (TEXT NULL), `spam_score` (INTEGER NULL); `folder` accepts `'spam'`. All later tasks rely on these names.

Why a dedicated D1 binding: Worker test files share storage and every other file applies all migrations in `beforeAll`, so `env.DB` may already be at `0006`. `MIGRATION_DB` is touched by this file only. (Verified: adding `d1Databases` under `miniflare` keeps the wrangler `DB` binding.)

- [ ] **Step 1: Add the test-only binding**

In `vitest.config.ts`, inside `cloudflareTest({ … miniflare: { … } })`, add `d1Databases` before `bindings`:

```ts
        miniflare: {
          // Base D1 réservée au test de la migration 0006 (test/db/migration-0006.test.ts) :
          // elle doit partir d'un schéma 0005, alors que les autres fichiers appliquent toutes
          // les migrations sur DB.
          d1Databases: { MIGRATION_DB: "migration-test" },
          bindings: {
```

- [ ] **Step 2: Write the failing test**

Create `test/db/migration-0006.test.ts`:

```ts
import { env, applyD1Migrations } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

type Migrations = Parameters<typeof applyD1Migrations>[1];
interface TestEnv {
  MIGRATION_DB: D1Database;
  TEST_MIGRATIONS: Migrations;
}

const testEnv = env as unknown as TestEnv;
const db = testEnv.MIGRATION_DB;

// Données posées sur un schéma 0005, puis migration 0006 : on vérifie que la reconstruction
// de messages ne perd ni destinataires ni pièces jointes (piège du DROP TABLE qui déclenche
// ON DELETE CASCADE), et que l'index FTS reste utilisable.
beforeAll(async () => {
  const all = testEnv.TEST_MIGRATIONS;
  const upTo0005 = all.filter((m) => m.name < "0006");
  expect(upTo0005.length).toBe(5);
  await applyD1Migrations(db, upTo0005);

  await db.batch([
    db.prepare("INSERT INTO threads (id, subject_norm, last_message_at, message_count, unread_count) VALUES (1, 'facture', 100, 2, 1)"),
    db.prepare(
      `INSERT INTO messages (id, thread_id, message_id, direction, folder, from_addr, from_name, subject, text_body,
                             snippet, received_at, is_read, has_attachments, raw_key, trashed_at)
       VALUES (1, 1, '<a@example.com>', 'in', 'inbox', 'zoe@example.com', 'Zoé', 'Facture de septembre',
               'Voici la facture réglée', 'Voici', 100, 0, 1, 'raw/a.eml', NULL)`
    ),
    db.prepare(
      `INSERT INTO messages (id, thread_id, message_id, direction, folder, from_addr, subject, received_at, is_read, raw_key, trashed_at)
       VALUES (2, 1, '<b@example.com>', 'in', 'trash', 'zoe@example.com', 'Relance', 90, 1, 'raw/b.eml', 555)`
    ),
    db.prepare(
      `INSERT INTO messages (id, thread_id, message_id, direction, folder, from_addr, subject, received_at, is_read, raw_key)
       VALUES (3, 1, '<c@example.com>', 'out', 'sent', 'you@example.com', 'Re: Facture', 110, 1, 'sent/<c@example.com>')`
    ),
    db.prepare("INSERT INTO recipients (id, message_id, kind, address, name) VALUES (10, 1, 'to', 'you@example.com', NULL)"),
    db.prepare("INSERT INTO recipients (id, message_id, kind, address, name) VALUES (11, 1, 'cc', 'bob@example.com', 'Bob')"),
    db.prepare("INSERT INTO recipients (id, message_id, kind, address, name) VALUES (12, 3, 'to', 'zoe@example.com', NULL)"),
    db.prepare(
      `INSERT INTO attachments (id, message_id, filename, mime_type, size, content_id, r2_key)
       VALUES (20, 1, 'facture.pdf', 'application/pdf', 1234, NULL, 'att/a/0-facture.pdf')`
    ),
    db.prepare("INSERT INTO purge_claims (raw_key, message_id, claimed_at) VALUES ('raw/b.eml', 2, 777)"),
  ]);

  await applyD1Migrations(db, all);
});

const count = async (table: string) =>
  (await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>())?.n;

describe("migration 0006", () => {
  it("conserve toutes les lignes et leurs identifiants", async () => {
    expect(await count("messages")).toBe(3);
    expect(await count("recipients")).toBe(3);
    expect(await count("attachments")).toBe(1);
    expect(await count("purge_claims")).toBe(1);
    const m2 = await db.prepare("SELECT folder, trashed_at, is_read FROM messages WHERE id = 2")
      .first<{ folder: string; trashed_at: number; is_read: number }>();
    expect(m2).toEqual({ folder: "trash", trashed_at: 555, is_read: 1 });
    const att = await db.prepare("SELECT message_id, r2_key FROM attachments WHERE id = 20")
      .first<{ message_id: number; r2_key: string }>();
    expect(att).toEqual({ message_id: 1, r2_key: "att/a/0-facture.pdf" });
  });

  it("ajoute les colonnes de verdict, vides pour les messages existants", async () => {
    const m = await db.prepare("SELECT auth_spf, auth_dkim, auth_dmarc, spam_score FROM messages WHERE id = 1")
      .first();
    expect(m).toEqual({ auth_spf: null, auth_dkim: null, auth_dmarc: null, spam_score: null });
  });

  it("accepte le dossier spam et refuse un dossier inconnu", async () => {
    await db.prepare("UPDATE messages SET folder = 'spam' WHERE id = 1").run();
    await expect(db.prepare("UPDATE messages SET folder = 'junk' WHERE id = 1").run()).rejects.toThrow();
    await db.prepare("UPDATE messages SET folder = 'inbox' WHERE id = 1").run();
  });

  it("garde l'index de recherche valide et ses triggers actifs", async () => {
    const hit = await db.prepare(
      "SELECT m.id FROM messages_fts f JOIN messages m ON m.id = f.rowid WHERE messages_fts MATCH ?"
    ).bind("reglee").first<{ id: number }>();
    expect(hit?.id).toBe(1);

    await db.prepare("UPDATE messages SET subject = 'Devis' WHERE id = 3").run();
    const updated = await db.prepare("SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?").bind("devis").first();
    expect(updated).not.toBeNull();
  });

  it("rattache les tables enfants à la nouvelle table messages", async () => {
    const sql = await db.prepare("SELECT sql FROM sqlite_master WHERE name = 'recipients'").first<{ sql: string }>();
    expect(sql?.sql).toMatch(/REFERENCES "?messages"?\s*\(id\)/);
    expect(sql?.sql).not.toMatch(/messages_new/);
    await expect(
      db.prepare("INSERT INTO recipients (message_id, kind, address) VALUES (999, 'to', 'x@example.com')").run()
    ).rejects.toThrow();
  });

  it("supprime en cascade les destinataires et pièces jointes", async () => {
    await db.prepare("DELETE FROM messages WHERE id = 1").run();
    expect(await count("recipients")).toBe(1);
    expect(await count("attachments")).toBe(0);
    const gone = await db.prepare("SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?").bind("reglee").first();
    expect(gone).toBeNull();
  });

  it("recrée tous les index", async () => {
    const rows = await db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_%'")
      .all<{ name: string }>();
    expect(rows.results.map((r) => r.name).sort()).toEqual([
      "idx_attachments_message",
      "idx_forward_rules_match",
      "idx_forward_rules_pair",
      "idx_messages_folder",
      "idx_messages_in_reply_to",
      "idx_messages_raw_key",
      "idx_messages_thread",
      "idx_messages_trashed_at",
      "idx_recipients_address",
      "idx_recipients_message",
      "idx_threads_last",
    ]);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `pnpm vitest run test/db/migration-0006.test.ts`
Expected: FAIL — the verdict columns do not exist (`no such column: auth_spf`) and `'spam'` violates the `CHECK`.

- [ ] **Step 4: Write the migration**

Create `migrations/0006_message_authentication.sql`:

```sql
-- Verdicts d'authentification (SPF, DKIM, DMARC) et dossier Spam.
--
-- Une contrainte CHECK ne se modifie pas en SQLite : ajouter 'spam' impose de reconstruire
-- messages. D1 applique les clés étrangères sans permettre de les désactiver, d'où deux
-- pièges vérifiés sur un D1 local :
--   - DROP TABLE messages fait un DELETE implicite qui déclenche ON DELETE CASCADE : la
--     reconstruction habituelle viderait recipients et attachments ;
--   - ALTER TABLE … RENAME réécrit les clés étrangères des tables enfants vers le nouveau nom.
-- On reconstruit donc aussi les deux tables enfants, et on supprime les enfants AVANT
-- messages : au moment du DROP de messages, plus rien ne le référence. Les id sont conservés,
-- donc messages_fts (table à contenu externe indexée par rowid) reste valide sans être touchée.
--
-- trashed_at change de sens sans changer de nom : date d'entrée dans la corbeille OU dans
-- Spam, point de départ de la purge planifiée (src/maintenance/trash.ts).

CREATE TABLE messages_new (
  id INTEGER PRIMARY KEY,
  thread_id INTEGER NOT NULL REFERENCES threads(id),
  message_id TEXT NOT NULL UNIQUE,
  in_reply_to TEXT,
  direction TEXT NOT NULL CHECK (direction IN ('in','out')),
  folder TEXT NOT NULL CHECK (folder IN ('inbox','sent','trash','spam')),
  from_addr TEXT NOT NULL,
  from_name TEXT,
  subject TEXT,
  text_body TEXT,
  html_body TEXT,
  snippet TEXT,
  received_at INTEGER NOT NULL,
  is_read INTEGER NOT NULL DEFAULT 0,
  has_attachments INTEGER NOT NULL DEFAULT 0,
  raw_key TEXT NOT NULL,
  parse_error INTEGER NOT NULL DEFAULT 0,
  body_truncated INTEGER NOT NULL DEFAULT 0,
  trashed_at INTEGER,
  -- Verdicts lus dans le premier en-tête Authentication-Results, s'il vient de
  -- mx.cloudflare.net (src/ingest/auth.ts). NULL : aucun verdict de confiance.
  auth_spf TEXT,
  auth_dkim TEXT,
  auth_dmarc TEXT,
  -- X-CF-SpamH-Score, conservé sans être utilisé : Cloudflare n'en documente pas l'échelle.
  spam_score INTEGER
);

CREATE TABLE recipients_new (
  id INTEGER PRIMARY KEY,
  message_id INTEGER NOT NULL REFERENCES messages_new(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('to','cc','reply-to')),
  address TEXT NOT NULL,
  name TEXT
);

CREATE TABLE attachments_new (
  id INTEGER PRIMARY KEY,
  message_id INTEGER NOT NULL REFERENCES messages_new(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  content_id TEXT,
  r2_key TEXT NOT NULL
);

INSERT INTO messages_new
  (id, thread_id, message_id, in_reply_to, direction, folder, from_addr, from_name, subject,
   text_body, html_body, snippet, received_at, is_read, has_attachments, raw_key, parse_error,
   body_truncated, trashed_at)
SELECT id, thread_id, message_id, in_reply_to, direction, folder, from_addr, from_name, subject,
       text_body, html_body, snippet, received_at, is_read, has_attachments, raw_key, parse_error,
       body_truncated, trashed_at
  FROM messages;

INSERT INTO recipients_new (id, message_id, kind, address, name)
SELECT id, message_id, kind, address, name FROM recipients;

INSERT INTO attachments_new (id, message_id, filename, mime_type, size, content_id, r2_key)
SELECT id, message_id, filename, mime_type, size, content_id, r2_key FROM attachments;

-- Enfants d'abord : le DROP de messages ne doit plus rien trouver à supprimer en cascade.
-- Les triggers FTS (messages_ai, messages_ad, messages_au) disparaissent avec messages.
DROP TABLE recipients;
DROP TABLE attachments;
DROP TABLE messages;

ALTER TABLE messages_new RENAME TO messages;
ALTER TABLE recipients_new RENAME TO recipients;
ALTER TABLE attachments_new RENAME TO attachments;

CREATE INDEX idx_messages_folder ON messages(folder, received_at DESC);
CREATE INDEX idx_messages_thread ON messages(thread_id);
CREATE INDEX idx_messages_in_reply_to ON messages(in_reply_to);
CREATE INDEX idx_messages_raw_key ON messages(raw_key);
CREATE INDEX idx_messages_trashed_at ON messages(folder, trashed_at);
CREATE INDEX idx_recipients_message ON recipients(message_id);
CREATE INDEX idx_recipients_address ON recipients(address);
CREATE INDEX idx_attachments_message ON attachments(message_id);

CREATE TRIGGER messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, subject, from_addr, text_body)
  VALUES (new.id, new.subject, new.from_addr, new.text_body);
END;

CREATE TRIGGER messages_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, subject, from_addr, text_body)
  VALUES ('delete', old.id, old.subject, old.from_addr, old.text_body);
END;

CREATE TRIGGER messages_au AFTER UPDATE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, subject, from_addr, text_body)
  VALUES ('delete', old.id, old.subject, old.from_addr, old.text_body);
  INSERT INTO messages_fts(rowid, subject, from_addr, text_body)
  VALUES (new.id, new.subject, new.from_addr, new.text_body);
END;
```

- [ ] **Step 5: Run the migration test, then the whole Worker suite**

Run: `pnpm vitest run test/db/migration-0006.test.ts`
Expected: PASS (7 tests).

Run: `pnpm vitest run`
Expected: PASS — every existing file now runs on the rebuilt schema.

- [ ] **Step 6: Check it applies with Wrangler on a fresh local database**

Run:
```bash
rm -rf .wrangler/state/v3/d1 .wrangler/state/v3/r2
pnpm wrangler d1 migrations apply cloudmail --local
pnpm wrangler d1 execute cloudmail --local --command "PRAGMA foreign_key_check"
```
Expected: six migrations applied, `foreign_key_check` returns no rows.

- [ ] **Step 7: Commit**

```bash
git add migrations/0006_message_authentication.sql test/db/migration-0006.test.ts vitest.config.ts
git commit -m "feat(db): add authentication verdicts and a spam folder (migration 0006)"
```

---

### Task 2: Authentication-Results parser

**Files:**
- Create: `src/ingest/auth.ts`
- Test: `test/ingest/auth.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```ts
  export type AuthVerdict = "pass" | "fail" | "softfail" | "neutral" | "none" | "temperror" | "permerror";
  export type AuthResults = { spf: AuthVerdict | null; dkim: AuthVerdict | null; dmarc: AuthVerdict | null; spamScore: number | null };
  export const NO_AUTH: AuthResults; // les quatre à null
  export function parseAuthentication(headers: { key: string; value: string }[]): AuthResults;
  ```
  `headers` is postal-mime's `email.headers`: top to bottom, `key` lowercased.

- [ ] **Step 1: Write the failing tests**

Create `test/ingest/auth.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { NO_AUTH, parseAuthentication } from "../../src/ingest/auth";

const h = (key: string, value: string) => ({ key, value });

// Forme réelle relevée sur une installation (adresses remplacées), avec le repliement
// CRLF + tabulation tel que livré.
const CLOUDFLARE =
  "mx.cloudflare.net;\r\n\tdkim=pass header.d=example.com header.s=s1 header.b=abc;\r\n" +
  "\tdmarc=pass header.from=example.com policy.dmarc=none;\r\n" +
  "\tspf=none (mx.cloudflare.net: no SPF records found for postmaster@mail.example.com) smtp.helo=mail.example.com;\r\n" +
  "\tspf=pass (mx.cloudflare.net: domain of zoe@example.com designates 2001:db8::1 as permitted sender) smtp.mailfrom=zoe@example.com";

describe("parseAuthentication", () => {
  it("lit les verdicts de l'en-tête Cloudflare réel", () => {
    expect(parseAuthentication([
      h("received", "from mail.example.com by cloudflare-email.net"),
      h("authentication-results", CLOUDFLARE),
      h("x-cf-spamh-score", "0"),
    ])).toEqual({ spf: "pass", dkim: "pass", dmarc: "pass", spamScore: 0 });
  });

  it("lit une valeur sur une seule ligne comme une valeur repliée", () => {
    const oneLine = CLOUDFLARE.replace(/\r\n\t/g, " ");
    expect(parseAuthentication([h("authentication-results", oneLine)]))
      .toEqual(parseAuthentication([h("authentication-results", CLOUDFLARE)]));
  });

  it("ne lit que le premier en-tête : un en-tête falsifié placé plus bas est ignoré", () => {
    const res = parseAuthentication([
      h("authentication-results", "mx.cloudflare.net; dmarc=fail header.from=bank.example; spf=fail smtp.mailfrom=x@bank.example"),
      h("authentication-results", "mx.cloudflare.net; dmarc=pass header.from=bank.example; spf=pass smtp.mailfrom=x@bank.example"),
    ]);
    expect(res.dmarc).toBe("fail");
    expect(res.spf).toBe("fail");
  });

  it("ignore tout quand le premier en-tête ne vient pas de Cloudflare", () => {
    expect(parseAuthentication([
      h("authentication-results", "mx.example.com; dmarc=pass"),
      h("authentication-results", "mx.cloudflare.net; dmarc=fail"),
    ])).toEqual({ ...NO_AUTH });
  });

  it("refuse un identifiant qui ressemble seulement à celui de Cloudflare", () => {
    for (const id of ["mx.cloudflare.net.example.com", "mx.cloudflare.net2", "cloudflare.net"]) {
      const res = parseAuthentication([h("authentication-results", `${id}; dmarc=pass; spf=pass; dkim=pass`)]);
      expect(res).toEqual({ ...NO_AUTH });
    }
  });

  it("accepte l'identifiant Cloudflare quelle que soit la casse, suivi d'une version", () => {
    expect(parseAuthentication([h("authentication-results", "MX.Cloudflare.NET 1; dmarc=fail")]).dmarc).toBe("fail");
  });

  it("préfère le résultat SPF de smtp.mailfrom, sinon prend le premier", () => {
    expect(parseAuthentication([h("authentication-results", "mx.cloudflare.net; spf=pass smtp.helo=a; spf=softfail smtp.mailfrom=b")]).spf)
      .toBe("softfail");
    expect(parseAuthentication([h("authentication-results", "mx.cloudflare.net; spf=neutral smtp.helo=a")]).spf)
      .toBe("neutral");
  });

  it("retient pass si l'une des signatures DKIM est valide, sinon la première", () => {
    expect(parseAuthentication([h("authentication-results", "mx.cloudflare.net; dkim=fail header.d=a; dkim=pass header.d=b")]).dkim)
      .toBe("pass");
    expect(parseAuthentication([h("authentication-results", "mx.cloudflare.net; dkim=permerror header.d=a; dkim=fail header.d=b")]).dkim)
      .toBe("permerror");
  });

  it("ignore les commentaires qui contiennent ; et =", () => {
    const res = parseAuthentication([
      h("authentication-results", "mx.cloudflare.net; spf=pass (note; dmarc=fail) smtp.mailfrom=a; dmarc=pass"),
    ]);
    expect(res).toMatchObject({ spf: "pass", dmarc: "pass" });
  });

  it("met en minuscules et écarte les valeurs inconnues", () => {
    const res = parseAuthentication([h("authentication-results", "mx.cloudflare.net; DMARC=FAIL; dkim=bestguesspass; spf=policy")]);
    expect(res).toEqual({ spf: null, dkim: null, dmarc: "fail", spamScore: null });
  });

  it("renvoie des verdicts vides pour « none » sans méthode, ou sans en-tête", () => {
    expect(parseAuthentication([h("authentication-results", "mx.cloudflare.net; none")])).toEqual({ ...NO_AUTH });
    expect(parseAuthentication([])).toEqual({ ...NO_AUTH });
  });

  it("ne garde qu'un score entier", () => {
    expect(parseAuthentication([h("x-cf-spamh-score", "12")]).spamScore).toBe(12);
    expect(parseAuthentication([h("x-cf-spamh-score", "-3")]).spamScore).toBe(-3);
    expect(parseAuthentication([h("x-cf-spamh-score", "1.5")]).spamScore).toBeNull();
    expect(parseAuthentication([h("x-cf-spamh-score", "élevé")]).spamScore).toBeNull();
  });

  it("ne lève jamais, même sur une valeur vide", () => {
    expect(() => parseAuthentication([h("authentication-results", ""), h("x-cf-spamh-score", "")])).not.toThrow();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run test/ingest/auth.test.ts`
Expected: FAIL — `Cannot find module '../../src/ingest/auth'`.

- [ ] **Step 3: Implement**

Create `src/ingest/auth.ts`:

```ts
// Verdicts SPF, DKIM et DMARC posés par le MX de Cloudflare sur chaque message reçu.
//
// Règle de confiance : un MTA ajoute ses en-têtes en tête du message, donc celui de Cloudflare
// est au-dessus de tout ce que l'expéditeur a pu écrire. On ne lit que le PREMIER
// Authentication-Results, et seulement si son identifiant est exactement mx.cloudflare.net.
// Un expéditeur qui glisse « Authentication-Results: mx.cloudflare.net; dmarc=pass » se
// retrouve sous celui de Cloudflare et n'est jamais lu.

export type AuthVerdict = "pass" | "fail" | "softfail" | "neutral" | "none" | "temperror" | "permerror";

export type AuthResults = {
  spf: AuthVerdict | null;
  dkim: AuthVerdict | null;
  dmarc: AuthVerdict | null;
  spamScore: number | null;
};

export const NO_AUTH: AuthResults = Object.freeze({ spf: null, dkim: null, dmarc: null, spamScore: null });

const TRUSTED_AUTHSERV_ID = "mx.cloudflare.net";

const VERDICTS = new Set<string>(["pass", "fail", "softfail", "neutral", "none", "temperror", "permerror"]);

type Clause = { method: string; result: string; props: string };

// Retire les commentaires entre parenthèses (RFC 5322, imbrication comprise) : ils contiennent
// librement « ; » et « = », qui fausseraient le découpage.
const stripComments = (value: string): string => {
  let depth = 0;
  let out = "";
  for (const ch of value) {
    if (ch === "(") depth++;
    else if (ch === ")" && depth > 0) depth--;
    else if (depth === 0) out += ch;
  }
  return out;
};

const toVerdict = (result: string | undefined): AuthVerdict | null =>
  result && VERDICTS.has(result) ? (result as AuthVerdict) : null;

function parseClauses(value: string): { authservId: string; clauses: Clause[] } {
  const [head = "", ...rest] = stripComments(value).replace(/\s+/g, " ").split(";");
  const authservId = head.trim().split(" ")[0]?.toLowerCase() ?? "";
  const clauses: Clause[] = [];
  for (const part of rest) {
    const m = /^\s*([a-z0-9-]+)\s*=\s*([a-z0-9-]+)(.*)$/i.exec(part);
    if (m) clauses.push({ method: m[1].toLowerCase(), result: m[2].toLowerCase(), props: m[3].toLowerCase() });
  }
  return { authservId, clauses };
}

function spamScoreOf(headers: { key: string; value: string }[]): number | null {
  const raw = headers.find((h) => h.key === "x-cf-spamh-score")?.value.trim() ?? "";
  return /^-?\d+$/.test(raw) ? Number(raw) : null;
}

export function parseAuthentication(headers: { key: string; value: string }[]): AuthResults {
  const spamScore = spamScoreOf(headers);
  const first = headers.find((h) => h.key === "authentication-results");
  if (!first) return { ...NO_AUTH, spamScore };

  const { authservId, clauses } = parseClauses(first.value);
  if (authservId !== TRUSTED_AUTHSERV_ID) return { ...NO_AUTH, spamScore };

  const of = (method: string) => clauses.filter((c) => c.method === method);
  const spf = of("spf");
  const dkim = of("dkim");

  return {
    // Deux résultats SPF possibles (HELO et MAIL FROM) : seul celui de MAIL FROM compte.
    spf: toVerdict((spf.find((c) => c.props.includes("smtp.mailfrom=")) ?? spf[0])?.result),
    // Plusieurs signatures possibles : une seule valide suffit.
    dkim: toVerdict(dkim.some((c) => c.result === "pass") ? "pass" : dkim[0]?.result),
    dmarc: toVerdict(of("dmarc")[0]?.result),
    spamScore,
  };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm vitest run test/ingest/auth.test.ts`
Expected: PASS (13 tests).

- [ ] **Step 5: Commit**

```bash
git add src/ingest/auth.ts test/ingest/auth.test.ts
git commit -m "feat(ingest): parse Cloudflare authentication verdicts"
```

---

### Task 3: Store verdicts and file DMARC failures as spam

**Files:**
- Create: `src/db/folders.ts`
- Create: `test/fixtures/spoofed.eml`, `test/fixtures/authenticated.eml`
- Modify: `src/ingest/parse.ts` (type `ParsedMessage`, `fallback()`, return value)
- Modify: `src/ingest/store.ts` (`parsedColumns`, `storeIncoming`)
- Modify: `src/admin/reimport.ts:173-182` (re-parse `UPDATE`)
- Test: `test/ingest/parse.test.ts`, `test/ingest/store.test.ts`, `test/admin/reimport.test.ts`

**Interfaces:**
- Consumes: `parseAuthentication`, `AuthResults`, `NO_AUTH` from `src/ingest/auth.ts` (Task 2); columns from Task 1.
- Produces:
  - `src/db/folders.ts`:
    ```ts
    export const FOLDERS: readonly ["inbox", "sent", "trash", "spam"]; // tuple `as const`, utilisable par z.enum
    export type Folder = (typeof FOLDERS)[number];
    export const RETAINED_FOLDERS: readonly Folder[]; // ["trash", "spam"] — hors compteurs, purgés
    export function countsInThread(folder: string): boolean; // false pour trash et spam
    export const RETAINED_FOLDERS_SQL: string; // "'trash','spam'"
    ```
  - `ParsedMessage.auth: AuthResults`.
  - `parsedColumns(...)` additionally returns `authSpf`, `authDkim`, `authDmarc` (`string | null`) and `spamScore` (`number | null`).

- [ ] **Step 1: Create the fixtures**

`test/fixtures/spoofed.eml` (CRLF not required; keep LF like the other fixtures):

```
Authentication-Results: mx.cloudflare.net;
	dkim=fail header.d=bank.example header.s=s1;
	dmarc=fail header.from=bank.example policy.dmarc=none;
	spf=fail smtp.mailfrom=alerts@bank.example
X-CF-SpamH-Score: 7
Authentication-Results: mx.cloudflare.net; dkim=pass; dmarc=pass; spf=pass smtp.mailfrom=alerts@bank.example
From: Banque <alerts@bank.example>
To: you@example.com
Subject: Votre compte est suspendu
Message-ID: <spoofed-1@bank.example>
Date: Mon, 08 Sep 2026 10:00:00 +0200
Content-Type: text/plain; charset=utf-8

Cliquez ici pour réactiver votre compte.
```

`test/fixtures/authenticated.eml`:

```
Authentication-Results: mx.cloudflare.net;
	dkim=pass header.d=example.com header.s=s1;
	dmarc=pass header.from=example.com policy.dmarc=none;
	spf=pass smtp.mailfrom=zoe@example.com
X-CF-SpamH-Score: 0
From: Zoé Martin <zoe@example.com>
To: you@example.com
Subject: Rendez-vous
Message-ID: <authenticated-1@example.com>
Date: Mon, 08 Sep 2026 11:00:00 +0200
Content-Type: text/plain; charset=utf-8

À demain.
```

- [ ] **Step 2: Write the failing tests**

In `test/ingest/parse.test.ts`, add (reuse the file's existing fixture loader — read its top to find its name; the example below assumes `load(name): Promise<ArrayBuffer>` as in `store.test.ts`, adapt the call if it differs):

```ts
describe("parseEmail — verdicts d'authentification", () => {
  it("lit les verdicts du premier en-tête Cloudflare", async () => {
    const msg = await parseEmail(await load("spoofed.eml"), "alerts@bank.example");
    expect(msg.auth).toEqual({ spf: "fail", dkim: "fail", dmarc: "fail", spamScore: 7 });
  });

  it("n'a aucun verdict sans en-tête Cloudflare", async () => {
    const msg = await parseEmail(await load("simple.eml"), "zoe@example.com");
    expect(msg.auth).toEqual({ spf: null, dkim: null, dmarc: null, spamScore: null });
  });

  it("n'a aucun verdict pour un message illisible", async () => {
    const msg = await parseEmail(await load("malformed.eml"), "zoe@example.com");
    expect(msg.parseError).toBe(true);
    expect(msg.auth).toEqual({ spf: null, dkim: null, dmarc: null, spamScore: null });
  });
});
```

In `test/ingest/store.test.ts`, add:

```ts
describe("storeIncoming — authentification et spam", () => {
  const row = (id: number | null) =>
    env.DB.prepare(
      "SELECT folder, trashed_at, auth_spf, auth_dkim, auth_dmarc, spam_score, thread_id FROM messages WHERE id = ?"
    ).bind(id).first<Record<string, unknown>>();

  it("classe un échec DMARC dans Spam, daté, sans toucher aux compteurs du fil", async () => {
    const before = Math.floor(Date.now() / 1000);
    const res = await storeIncoming(env, await load("spoofed.eml"), envelope);
    const m = await row(res.messageId);
    expect(m).toMatchObject({ folder: "spam", auth_spf: "fail", auth_dkim: "fail", auth_dmarc: "fail", spam_score: 7 });
    expect(m?.trashed_at as number).toBeGreaterThanOrEqual(before - 1);
    const t = await env.DB.prepare("SELECT message_count, unread_count FROM threads WHERE id = ?")
      .bind(m?.thread_id).first<{ message_count: number; unread_count: number }>();
    expect(t).toEqual({ message_count: 0, unread_count: 0 });
  });

  it("laisse un message authentifié en boîte de réception avec ses verdicts", async () => {
    const res = await storeIncoming(env, await load("authenticated.eml"), envelope);
    expect(await row(res.messageId)).toMatchObject({
      folder: "inbox", trashed_at: null, auth_spf: "pass", auth_dkim: "pass", auth_dmarc: "pass", spam_score: 0,
    });
  });

  it("laisse en boîte de réception un message sans verdict", async () => {
    const res = await storeIncoming(env, await load("simple.eml"), envelope);
    expect(await row(res.messageId)).toMatchObject({ folder: "inbox", auth_dmarc: null });
  });

  it("une réponse usurpée rattachée à un fil existant ne change ni ses compteurs ni sa présence en boîte de réception", async () => {
    const legit = await storeIncoming(env, await load("simple.eml"), envelope);
    const threadId = (await row(legit.messageId))?.thread_id as number;
    const before = await env.DB.prepare("SELECT message_count, unread_count FROM threads WHERE id = ?")
      .bind(threadId).first();

    const reply = new TextEncoder().encode(
      [
        "Authentication-Results: mx.cloudflare.net; dmarc=fail header.from=example.com",
        "From: Zoé Martin <zoe@example.com>",
        "To: thomas@example.com",
        "Subject: Re: Facture réglée",
        "Message-ID: <spoofed-reply@example.com>",
        "In-Reply-To: <simple-1@example.com>",
        "Date: Mon, 08 Sep 2026 12:00:00 +0200",
        "Content-Type: text/plain; charset=utf-8",
        "",
        "Nouveau RIB en pièce jointe.",
      ].join("\r\n"),
    ).buffer as ArrayBuffer;
    const spoofed = await storeIncoming(env, reply, envelope);

    const m = await row(spoofed.messageId);
    expect(m).toMatchObject({ folder: "spam", thread_id: threadId });
    expect(await env.DB.prepare("SELECT message_count, unread_count FROM threads WHERE id = ?").bind(threadId).first())
      .toEqual(before);
    const inbox = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM messages WHERE thread_id = ? AND folder = 'inbox'"
    ).bind(threadId).first<{ n: number }>();
    expect(inbox?.n).toBe(1);
  });
});
```

In `test/admin/reimport.test.ts`, inside `describe("reimportKey — réanalyse sur place", …)`, add:

```ts
  it("renseigne les verdicts sans jamais changer de dossier", async () => {
    const raw = loadBytes("spoofed.eml");
    const res = await storeIncoming(env, raw, { from: "alerts@bank.example", to: "you@example.com" });
    // Simule un message reçu avant la migration 0006 : en boîte de réception, sans verdict.
    await env.DB.prepare(
      "UPDATE messages SET folder = 'inbox', trashed_at = NULL, auth_spf = NULL, auth_dkim = NULL, auth_dmarc = NULL, spam_score = NULL WHERE id = ?"
    ).bind(res.messageId).run();

    const outcome = await reimportKey(env, res.rawKey, "test");
    expect(outcome.outcome).toBe("reparsed");

    const m = await env.DB.prepare(
      "SELECT folder, trashed_at, auth_spf, auth_dkim, auth_dmarc, spam_score FROM messages WHERE id = ?"
    ).bind(res.messageId).first();
    expect(m).toEqual({ folder: "inbox", trashed_at: null, auth_spf: "fail", auth_dkim: "fail", auth_dmarc: "fail", spam_score: 7 });
  });
```

Check `reimportKey`'s exact signature and outcome shape at the top of `src/admin/reimport.ts` and in the neighbouring tests, and match them (the neighbouring tests show how the third argument and the result are used).

- [ ] **Step 3: Run to verify failure**

Run: `pnpm vitest run test/ingest/parse.test.ts test/ingest/store.test.ts test/admin/reimport.test.ts`
Expected: FAIL — `msg.auth` is undefined, spoofed message lands in `inbox`, verdict columns stay `NULL`.

- [ ] **Step 4: Add `src/db/folders.ts`**

```ts
// Dossiers d'un message. trash et spam sont des dossiers « retenus » : leurs messages ne
// comptent pas dans message_count/unread_count du fil, et la maintenance planifiée les purge
// après TRASH_RETENTION_DAYS (trashed_at date leur entrée).
// Tuple `as const` : z.enum (src/api/routes.ts) exige un tuple littéral non vide.
export const FOLDERS = ["inbox", "sent", "trash", "spam"] as const;

export type Folder = (typeof FOLDERS)[number];

export const RETAINED_FOLDERS: readonly Folder[] = ["trash", "spam"];

// Pour les requêtes : folder IN (…). Littéraux fixes, jamais une saisie.
export const RETAINED_FOLDERS_SQL = RETAINED_FOLDERS.map((f) => `'${f}'`).join(",");

export const countsInThread = (folder: string): boolean => !(RETAINED_FOLDERS as readonly string[]).includes(folder);
```

- [ ] **Step 5: Add `auth` to `ParsedMessage`**

In `src/ingest/parse.ts`:

```ts
import { NO_AUTH, parseAuthentication, type AuthResults } from "./auth";
```

Add to `ParsedMessage`, after `parseError: boolean;`:

```ts
  auth: AuthResults; // Verdicts SPF/DKIM/DMARC de Cloudflare ; tous null sans en-tête de confiance.
```

In `fallback()`, after `parseError: true,` add `auth: { ...NO_AUTH },`. In the returned object of the success path, after `parseError: false,` add:

```ts
    auth: parseAuthentication(email.headers ?? []),
```

- [ ] **Step 6: Extend `parsedColumns` and classify in `storeIncoming`**

In `src/ingest/store.ts`, add at the end of the object returned by `parsedColumns`:

```ts
    authSpf: msg.auth.spf,
    authDkim: msg.auth.dkim,
    authDmarc: msg.auth.dmarc,
    spamScore: msg.auth.spamScore,
```

Add the import `import { countsInThread, type Folder } from "../db/folders";`.

In `storeIncoming`, just before the `INSERT OR IGNORE`, add:

```ts
  // Seul un échec DMARC classe en spam : c'est le cas « usurpation probable », déterministe.
  // Les échecs plus faibles (SPF ou DKIM seuls) restent en boîte de réception avec un
  // avertissement côté interface. Le message est toujours archivé, jamais rejeté.
  const folder: Folder = msg.auth.dmarc === "fail" ? "spam" : "inbox";
```

Replace the `INSERT OR IGNORE` statement with:

```ts
  const inserted = await env.DB.prepare(
    `INSERT OR IGNORE INTO messages
       (thread_id, message_id, in_reply_to, direction, folder, from_addr, from_name,
        subject, text_body, html_body, snippet, received_at, is_read, has_attachments, raw_key,
        parse_error, body_truncated, trashed_at, auth_spf, auth_dkim, auth_dmarc, spam_score)
     VALUES (?, ?, ?, 'in', ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?,
             CASE WHEN ? = 'spam' THEN unixepoch() END, ?, ?, ?, ?)`
  ).bind(
    threadId, cols.messageId, cols.inReplyTo, folder, cols.fromAddr, cols.fromName,
    cols.subject, cols.textBody, cols.htmlBody, cols.snippet,
    cols.receivedAt, cols.hasAttachments, rawKey, cols.parseError,
    cols.bodyTruncated, folder, cols.authSpf, cols.authDkim, cols.authDmarc, cols.spamScore
  ).run();
```

Replace the thread counter statement at the end with:

```ts
  // Un message qui vient d'arriver est toujours non lu. En boîte de réception, les deux
  // compteurs du thread progressent d'une unité ; en spam, dossier hors compteurs, seule la
  // date du fil bouge.
  const counted = countsInThread(folder) ? 1 : 0;
  statements.push(
    env.DB.prepare(
      `UPDATE threads
         SET message_count = message_count + ?,
             unread_count = unread_count + ?,
             last_message_at = MAX(last_message_at, ?)
       WHERE id = ?`
    ).bind(counted, counted, msg.date, threadId)
  );
```

- [ ] **Step 7: Write the verdicts on re-parse**

In `src/admin/reimport.ts`, the `UPDATE messages` of the re-parse batch becomes:

```ts
      env.DB.prepare(
        `UPDATE messages
            SET message_id = ?, in_reply_to = ?, from_addr = ?, from_name = ?, subject = ?,
                text_body = ?, html_body = ?, snippet = ?, received_at = ?, has_attachments = ?,
                parse_error = ?, body_truncated = ?,
                auth_spf = ?, auth_dkim = ?, auth_dmarc = ?, spam_score = ?
          WHERE id = ?`
      ).bind(
        cols.messageId, cols.inReplyTo, cols.fromAddr, cols.fromName, cols.subject,
        cols.textBody, cols.htmlBody, cols.snippet, cols.receivedAt, cols.hasAttachments,
        cols.parseError, cols.bodyTruncated,
        cols.authSpf, cols.authDkim, cols.authDmarc, cols.spamScore, row.id,
      ),
```

Do **not** add `folder` or `trashed_at`: a re-parse never moves a message (AGENTS.md, "Re-importing a message").

- [ ] **Step 8: Run to verify pass**

Run: `pnpm vitest run test/ingest test/admin test/email-handler.test.ts`
Expected: PASS.

Run: `pnpm typecheck`
Expected: no errors.

- [ ] **Step 9: Commit**

```bash
git add src/db/folders.ts src/ingest/parse.ts src/ingest/store.ts src/admin/reimport.ts test/fixtures/spoofed.eml test/fixtures/authenticated.eml test/ingest test/admin/reimport.test.ts
git commit -m "feat(ingest): store verdicts and file DMARC failures in spam"
```

---

### Task 4: Spam in folder moves, counters and the scheduled purge

**Files:**
- Modify: `src/db/mutations.ts` (`setRead`, `moveToFolder`, `purgeMessage`)
- Modify: `src/maintenance/trash.ts` (`purgeExpiredTrash`)
- Test: `test/api/mutations.test.ts`, `test/maintenance/trash.test.ts`

**Interfaces:**
- Consumes: `Folder`, `countsInThread`, `RETAINED_FOLDERS_SQL` from `src/db/folders.ts` (Task 3).
- Produces: `moveToFolder(db: D1Database, messageId: number, folder: Folder): Promise<boolean>` — same behaviour for existing folders, plus `spam`.

- [ ] **Step 1: Write the failing tests**

In `test/api/mutations.test.ts` (the `beforeEach` seeds thread 1 with `message_count = 2, unread_count = 2` and two unread inbox messages 1 and 2), add:

```ts
describe("dossier spam", () => {
  const counters = () =>
    env.DB.prepare("SELECT message_count, unread_count FROM threads WHERE id = 1")
      .first<{ message_count: number; unread_count: number }>();
  const trashedAt = async (id: number) =>
    (await env.DB.prepare("SELECT trashed_at FROM messages WHERE id = ?").bind(id)
      .first<{ trashed_at: number | null }>())?.trashed_at;

  it("sort un message signalé des compteurs et date son entrée", async () => {
    const before = Math.floor(Date.now() / 1000);
    expect(await moveToFolder(env.DB, 1, "spam")).toBe(true);
    expect(await counters()).toEqual({ message_count: 1, unread_count: 1 });
    expect(await trashedAt(1)).toBeGreaterThanOrEqual(before - 1);
  });

  it("« Ce n'est pas un spam » rétablit les compteurs et efface la date", async () => {
    await moveToFolder(env.DB, 1, "spam");
    await moveToFolder(env.DB, 1, "inbox");
    expect(await counters()).toEqual({ message_count: 2, unread_count: 2 });
    expect(await trashedAt(1)).toBeNull();
  });

  it("spam -> corbeille -> restauration ramène les compteurs exactement", async () => {
    await moveToFolder(env.DB, 1, "spam");
    await moveToFolder(env.DB, 1, "trash");
    expect(await counters()).toEqual({ message_count: 1, unread_count: 1 });
    await moveToFolder(env.DB, 1, "inbox");
    expect(await counters()).toEqual({ message_count: 2, unread_count: 2 });
  });

  it("corbeille -> spam ne touche pas aux compteurs mais redémarre le délai", async () => {
    await moveToFolder(env.DB, 1, "trash");
    await env.DB.prepare("UPDATE messages SET trashed_at = 1000 WHERE id = 1").run();
    await moveToFolder(env.DB, 1, "spam");
    expect(await counters()).toEqual({ message_count: 1, unread_count: 1 });
    expect(await trashedAt(1)).toBeGreaterThan(1000);
  });

  it("lire un spam ne touche pas unread_count", async () => {
    await moveToFolder(env.DB, 1, "spam");
    await setRead(env.DB, 1, true);
    expect(await counters()).toEqual({ message_count: 1, unread_count: 1 });
  });

  it("purger un spam ne décrémente pas une seconde fois les compteurs", async () => {
    await moveToFolder(env.DB, 1, "spam");
    expect(await purgeMessage(env, 1)).toBe(true);
    expect(await counters()).toEqual({ message_count: 1, unread_count: 1 });
  });

  it("accepte folder: spam via PATCH", async () => {
    const res = await app.request(
      "https://example.com/api/messages/1",
      { method: "PATCH", body: JSON.stringify({ folder: "spam" }), headers: { "Content-Type": "application/json" } },
      { ...env, DEV_BYPASS_AUTH: "1" }
    );
    expect(res.status).toBe(200);
    const m = await env.DB.prepare("SELECT folder FROM messages WHERE id = 1").first<{ folder: string }>();
    expect(m?.folder).toBe("spam");
  });
});
```

Check how `purgeMessage` is called elsewhere in this file (its first argument is the Worker `env`, possibly cast as `Env`) and match it.

In `test/maintenance/trash.test.ts`, widen the helper's parameter type to `folder: "inbox" | "sent" | "trash" | "spam"` and add:

```ts
describe("purgeExpiredTrash — spam", () => {
  it("purge un spam expiré et garde un spam récent", async () => {
    const old = await insertMessage({ folder: "spam", trashedAt: NOW - 31 * DAY });
    const recent = await insertMessage({ folder: "spam", trashedAt: NOW - 1 * DAY });
    const res = await purgeExpiredTrash(workerEnv, NOW, 30);
    expect(res).toEqual({ purged: 1, failed: 0, remaining: 0 });
    expect(await exists(old.id)).toBe(false);
    expect(await env.MAIL.get(old.rawKey)).toBeNull();
    expect(await exists(recent.id)).toBe(true);
  });

  it("ne purge jamais la boîte de réception, même avec une date ancienne", async () => {
    const inbox = await insertMessage({ folder: "inbox", trashedAt: NOW - 90 * DAY });
    await purgeExpiredTrash(workerEnv, NOW, 30);
    expect(await exists(inbox.id)).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run test/api/mutations.test.ts test/maintenance/trash.test.ts`
Expected: FAIL — `PATCH` with `spam` returns 400; spam moves leave counters unchanged; the expired spam is not purged. (`moveToFolder(…, "spam")` may also be a type error — the test run itself still executes.)

- [ ] **Step 3: Update `setRead`, `moveToFolder`, `purgeMessage`**

In `src/db/mutations.ts`, import `import { countsInThread, RETAINED_FOLDERS_SQL, type Folder } from "./folders";`.

`setRead`: replace `if (row.folder !== "trash") {` with `if (countsInThread(row.folder)) {` and update its comment to "hors corbeille et hors spam".

`moveToFolder`: change the signature to `folder: Folder`. Replace

```ts
  const wasTrash = row.folder === "trash";
  const goingToTrash = folder === "trash";
```

with

```ts
  const wasCounted = countsInThread(row.folder);
  const willCount = countsInThread(folder);
```

The `UPDATE` becomes:

```ts
    db.prepare(
      `UPDATE messages
          SET folder = ?1,
              trashed_at = CASE WHEN ?1 IN (${RETAINED_FOLDERS_SQL}) THEN unixepoch() ELSE NULL END
        WHERE id = ?2 AND folder = ?3
          AND NOT EXISTS (SELECT 1 FROM purge_claims WHERE raw_key = messages.raw_key)`
    ).bind(folder, messageId, row.folder),
```

and the counter block:

```ts
  // message_count et unread_count ne comptabilisent que les messages hors corbeille et hors
  // spam. Seul un passage entre un dossier compté (inbox, sent) et un dossier retenu (trash,
  // spam) les fait varier : inbox <-> sent et trash <-> spam n'y touchent pas.
  if (wasCounted !== willCount) {
    const delta = willCount ? 1 : -1;
```

(keep the rest of the block as is). Update the `trashed_at` comment above it: "date l'entrée en corbeille ou en spam … remis à l'heure courante à chaque entrée (y compris corbeille -> spam) et effacé à chaque sortie."

`purgeMessage`: the eligibility clause becomes

```ts
        WHERE id = ?1 AND (?2 IS NULL OR (folder IN (${RETAINED_FOLDERS_SQL}) AND trashed_at < ?2))`
```

and the decrement guard `if (row.folder !== "trash") {` becomes `if (countsInThread(row.folder)) {`, with its comment "Un message à la corbeille ou en spam a déjà été retiré …".

- [ ] **Step 4: Update the scheduled purge**

In `src/maintenance/trash.ts`, import `RETAINED_FOLDERS_SQL` from `../db/folders` and replace the `expired` fragment with:

```ts
  // Corbeille et spam partagent la même rétention : trashed_at date l'entrée dans l'un ou l'autre.
  const expired = `FROM messages WHERE folder IN (${RETAINED_FOLDERS_SQL}) AND trashed_at IS NOT NULL AND trashed_at < ?`;
```

Update the function comment: "Purge les messages entrés en corbeille ou en spam avant now − days …".

- [ ] **Step 5: Accept `spam` in the API**

In `src/api/routes.ts`, import `FOLDERS` from `../db/folders` and replace both enums:

```ts
const listQuery = z.object({
  folder: z.enum(FOLDERS).default("inbox"),
```

```ts
const patchBody = z.object({
  isRead: z.boolean().optional(),
  folder: z.enum(FOLDERS).optional(),
```

Update the comment above `patchBody` ("Les quatre dossiers sont acceptés …").

- [ ] **Step 6: Run to verify pass**

Run: `pnpm vitest run` then `pnpm typecheck`
Expected: all PASS, no type errors.

- [ ] **Step 7: Commit**

```bash
git add src/db/mutations.ts src/maintenance/trash.ts src/api/routes.ts test/api/mutations.test.ts test/maintenance/trash.test.ts
git commit -m "feat: move messages to and from spam, purge expired spam"
```

---

### Task 5: Verdicts in the thread detail API

**Files:**
- Modify: `src/db/queries.ts` (`MessageDetail`, `getThread`)
- Test: `test/api/read.test.ts`

**Interfaces:**
- Consumes: columns from Task 1, `AuthVerdict` from `src/ingest/auth.ts`.
- Produces: `MessageDetail.auth: { spf: AuthVerdict | null; dkim: AuthVerdict | null; dmarc: AuthVerdict | null } | null` — `null` when all three are `NULL`. Task 6 mirrors this type.

- [ ] **Step 1: Write the failing tests**

In `test/api/read.test.ts`, inside `describe("getThread", …)` (look at its existing setup to reuse its thread/message helpers), add:

```ts
  it("expose les verdicts d'authentification d'un message", async () => {
    await env.DB.prepare(
      "UPDATE messages SET auth_spf = 'pass', auth_dkim = 'fail', auth_dmarc = 'fail', spam_score = 7 WHERE id = 1"
    ).run();
    const t = await getThread(env.DB, 1);
    const m = t?.messages.find((x) => x.id === 1);
    expect(m?.auth).toEqual({ spf: "pass", dkim: "fail", dmarc: "fail" });
    expect(m).not.toHaveProperty("spamScore");
  });

  it("renvoie auth: null pour un message reçu avant la migration 0006", async () => {
    await env.DB.prepare(
      "UPDATE messages SET auth_spf = NULL, auth_dkim = NULL, auth_dmarc = NULL WHERE id = 1"
    ).run();
    const t = await getThread(env.DB, 1);
    expect(t?.messages.find((x) => x.id === 1)?.auth).toBeNull();
  });
```

If message 1 is not in thread 1 in that `describe`'s fixtures, use the ids it seeds.

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run test/api/read.test.ts`
Expected: FAIL — `auth` is `undefined`.

- [ ] **Step 3: Implement**

In `src/db/queries.ts`, `import type { AuthVerdict } from "../ingest/auth";`, add to `MessageDetail` after `rawKey: string;`:

```ts
  // null : aucun verdict de confiance (message envoyé, reçu avant 0006, sans en-tête Cloudflare).
  auth: { spf: AuthVerdict | null; dkim: AuthVerdict | null; dmarc: AuthVerdict | null } | null;
```

In `getThread`, add `auth_spf, auth_dkim, auth_dmarc` to the `SELECT` column list and to the row type (`auth_spf: AuthVerdict | null; auth_dkim: AuthVerdict | null; auth_dmarc: AuthVerdict | null;`), and in the mapping, after `rawKey: m.raw_key,`:

```ts
      auth: m.auth_spf === null && m.auth_dkim === null && m.auth_dmarc === null
        ? null
        : { spf: m.auth_spf, dkim: m.auth_dkim, dmarc: m.auth_dmarc },
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm vitest run test/api/read.test.ts` then `pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/db/queries.ts test/api/read.test.ts
git commit -m "feat(api): expose authentication verdicts in thread detail"
```

---

### Task 6: SPA — Spam folder, warning banners, actions

**Files:**
- Modify: `web/src/api/client.ts` (`MessageDetail.auth`, `useUpdateMessage` folder type)
- Modify: `web/src/i18n/fr.ts`, `web/src/i18n/en.ts`
- Modify: `web/src/components/Sidebar.tsx` (`FOLDERS`)
- Modify: `web/src/components/TrashNotice.tsx` (prop `folder`)
- Modify: `web/src/App.tsx:70`
- Modify: `web/src/components/ThreadView.tsx` (`MessageItem`)
- Test: `web/src/components/ThreadView.test.tsx`, `web/src/components/TrashNotice.test.tsx`, `web/src/components/Sidebar.test.tsx`

**Interfaces:**
- Consumes: API shape from Task 5 (`auth`), `PATCH /api/messages/:id` with `folder: "spam"` (Task 4).
- Produces: `TrashNotice({ folder }: { folder: "trash" | "spam" })`.

- [ ] **Step 1: Write the failing tests**

In `web/src/components/ThreadView.test.tsx`, add `auth: null,` to both messages of the `thread` fixture (after `rawKey`). Then add a `describe` at the end of the file:

```tsx
describe("ThreadView — authentification", () => {
  const withMessage = (patch: Partial<ThreadDetail["messages"][number]>) => {
    const one: ThreadDetail = { ...thread, messages: [{ ...thread.messages[1], ...patch }] };
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/threads/1") return Response.json(one);
      if (url.endsWith("/body")) return Response.json({ html: null, text: "corps", hasRemoteImages: false });
      if (init?.method === "PATCH") return Response.json({ ok: true });
      return Response.json({});
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  };
  const patches = (fetchMock: ReturnType<typeof vi.fn>) =>
    fetchMock.mock.calls
      .filter(([, init]) => (init as RequestInit | undefined)?.method === "PATCH")
      .map(([, init]) => JSON.parse(String((init as RequestInit).body)));

  afterEach(() => vi.unstubAllGlobals());

  it("avertit d'une usurpation probable quand DMARC échoue", async () => {
    withMessage({ from: { address: "alerts@bank.example", name: "Banque" }, auth: { spf: "fail", dkim: "fail", dmarc: "fail" } });
    renderThreadView();
    expect(await screen.findByText(
      "Usurpation probable : ce message prétend venir de bank.example mais échoue à la vérification DMARC.",
    )).toBeDefined();
    expect(screen.getByText("Authentification : SPF fail · DKIM fail · DMARC fail")).toBeDefined();
  });

  it("signale une authentification partielle sans échec DMARC", async () => {
    withMessage({ auth: { spf: "softfail", dkim: "pass", dmarc: "pass" } });
    renderThreadView();
    expect(await screen.findByText("Authentification partielle : SPF en échec.")).toBeDefined();
    expect(screen.queryByText(/Usurpation probable/)).toBeNull();
  });

  it("n'affiche ni bandeau ni verdicts pour un message sans verdict", async () => {
    withMessage({ auth: null });
    renderThreadView();
    await screen.findByRole("button", { name: /Répondre/ });
    expect(screen.queryByText(/Usurpation probable|Authentification/)).toBeNull();
  });

  it("n'affiche aucun bandeau quand tout est valide, seulement les verdicts", async () => {
    withMessage({ auth: { spf: "pass", dkim: "pass", dmarc: "pass" } });
    renderThreadView();
    expect(await screen.findByText("Authentification : SPF pass · DKIM pass · DMARC pass")).toBeDefined();
    expect(screen.queryByText(/Usurpation probable|partielle/)).toBeNull();
  });

  it("signale un message reçu comme spam", async () => {
    const fetchMock = withMessage({ folder: "inbox", isRead: true });
    renderThreadView();
    await userEvent.click(await screen.findByRole("button", { name: "Signaler comme spam" }));
    await waitFor(() => expect(patches(fetchMock)).toContainEqual({ id: 11, folder: "spam" }));
    expect(screen.queryByRole("button", { name: "Ce n'est pas un spam" })).toBeNull();
  });

  it("remet un spam en boîte de réception", async () => {
    const fetchMock = withMessage({ folder: "spam", isRead: true });
    renderThreadView();
    await userEvent.click(await screen.findByRole("button", { name: "Ce n'est pas un spam" }));
    await waitFor(() => expect(patches(fetchMock)).toContainEqual({ id: 11, folder: "inbox" }));
    expect(screen.queryByRole("button", { name: "Signaler comme spam" })).toBeNull();
  });

  it("ne propose aucune action spam pour un message envoyé", async () => {
    withMessage({ direction: "out", folder: "sent", rawKey: "sent/<b@example.com>", isRead: true });
    renderThreadView();
    await screen.findByRole("button", { name: /Répondre/ });
    expect(screen.queryByRole("button", { name: "Signaler comme spam" })).toBeNull();
  });

  it("s'affiche en anglais", async () => {
    withMessage({ from: { address: "alerts@bank.example", name: null }, auth: { spf: "pass", dkim: "fail", dmarc: "fail" } });
    renderThreadView({ locale: "en" });
    expect(await screen.findByText("Likely spoofed: this message claims to come from bank.example but fails DMARC.")).toBeDefined();
    expect(screen.getByRole("button", { name: "Report as spam" })).toBeDefined();
  });
});
```

Note: this `describe` sits outside `describe("ThreadView")`, so that block's `beforeEach` does not apply; `withMessage` installs the only `fetch` stub each test uses.

In `web/src/components/TrashNotice.test.tsx`, change the two existing renders to `<TrashNotice folder="trash" />` and add:

```tsx
  it("annonce le délai de suppression du dossier Spam", async () => {
    stubConfig(30);
    render(<TrashNotice folder="spam" />, { wrapper });
    expect(
      await screen.findByText("Les messages du dossier Spam sont supprimés définitivement après 30 jours."),
    ).toBeDefined();
  });
```

In `web/src/components/Sidebar.test.tsx`, add in the first `describe`:

```tsx
  it("liste le dossier Spam entre Envoyés et Corbeille", () => {
    render(<App />, { wrapper });
    const names = screen.getAllByRole("button").map((b) => b.textContent);
    const at = (n: string) => names.indexOf(n);
    expect(at("Spam")).toBeGreaterThan(at("Envoyés"));
    expect(at("Spam")).toBeLessThan(at("Corbeille"));
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter web test`
Expected: FAIL — no Spam button, no banner, `TrashNotice` ignores `folder`, and TypeScript-level fixture errors are ignored by Vitest but the assertions fail.

- [ ] **Step 3: Client types**

In `web/src/api/client.ts`, add to `MessageDetail` after `rawKey: string;`:

```ts
  // Verdicts SPF/DKIM/DMARC posés par Cloudflare ; null quand aucun n'est connu.
  auth: { spf: AuthVerdict | null; dkim: AuthVerdict | null; dmarc: AuthVerdict | null } | null;
```

and above the type:

```ts
export type AuthVerdict = "pass" | "fail" | "softfail" | "neutral" | "none" | "temperror" | "permerror";
export type Folder = "inbox" | "sent" | "trash" | "spam";
```

In `useUpdateMessage`, type `folder?: Folder` and update the comment ("L'API accepte les quatre dossiers").

- [ ] **Step 4: Strings**

`web/src/i18n/fr.ts`:

- `sidebar`: add `spam: "Spam",` after `sent`.
- `threadList`: add after `trashNotice`:
  ```ts
    spamNotice: (days: number) =>
      `Les messages du dossier Spam sont supprimés définitivement après ${days} ${plural.select(days) === "one" ? "jour" : "jours"}.`,
  ```
- `threadView`: add after `bodyTruncated`:
  ```ts
    spoofed: (domain: string) =>
      `Usurpation probable : ce message prétend venir de ${domain} mais échoue à la vérification DMARC.`,
    partialAuth: (checks: string) => `Authentification partielle : ${checks} en échec.`,
    authResults: (summary: string) => `Authentification : ${summary}`,
    reportSpam: "Signaler comme spam",
    notSpam: "Ce n'est pas un spam",
  ```

`web/src/i18n/en.ts` (same keys, same positions):

- `sidebar`: `spam: "Spam",`
- `threadList`:
  ```ts
    spamNotice: (days) =>
      `Messages in Spam are permanently deleted after ${days} ${plural.select(days) === "one" ? "day" : "days"}.`,
  ```
- `threadView`:
  ```ts
    spoofed: (domain) => `Likely spoofed: this message claims to come from ${domain} but fails DMARC.`,
    partialAuth: (checks) => `Partial authentication: ${checks} failed.`,
    authResults: (summary) => `Authentication: ${summary}`,
    reportSpam: "Report as spam",
    notSpam: "Not spam",
  ```

The verdict tokens (`SPF`, `pass`, `fail`…) are protocol values, shown as-is in both languages.

- [ ] **Step 5: Sidebar, notice, App**

`web/src/components/Sidebar.tsx`: `const FOLDERS = ["inbox", "sent", "spam", "trash"] as const;`

`web/src/components/TrashNotice.tsx`:

```tsx
// Rappel en tête de la corbeille et du dossier Spam : leur contenu est purgé par la
// maintenance planifiée. Masqué quand la purge est désactivée (trashRetentionDays null).
export function TrashNotice({ folder }: { folder: "trash" | "spam" }) {
  const { t } = useI18n();
  const { data } = useConfig();
  const days = data?.trashRetentionDays;
  if (!days) return null;
  const text = folder === "spam" ? t.threadList.spamNotice(days) : t.threadList.trashNotice(days);
  return <p className="border-b border-border px-3 py-2 text-xs text-muted-foreground">{text}</p>;
}
```

`web/src/App.tsx:70`: replace `{folder === "trash" && <TrashNotice />}` with

```tsx
            {(folder === "trash" || folder === "spam") && <TrashNotice folder={folder} />}
```

- [ ] **Step 6: Banners, verdict line and actions in `ThreadView.tsx`**

Above `MessageItem`, add:

```tsx
const FAILED = new Set(["fail", "softfail"]);

// Bandeau d'authentification : un échec DMARC signale une usurpation probable, où que soit le
// message ; un échec SPF ou DKIM seul, une authentification partielle. Rien quand tout est
// valide ou qu'aucun verdict n'est connu.
function AuthBanner({ message }: { message: MessageDetail }) {
  const { t } = useI18n();
  const auth = message.auth;
  if (!auth) return null;
  if (auth.dmarc === "fail") {
    const domain = message.from.address.split("@").pop() ?? message.from.address;
    return (
      <div role="alert" className="border-b bg-destructive/10 px-4 py-2 text-sm text-destructive">
        {t.threadView.spoofed(domain)}
      </div>
    );
  }
  const failed = [
    auth.spf && FAILED.has(auth.spf) ? "SPF" : null,
    auth.dkim && FAILED.has(auth.dkim) ? "DKIM" : null,
  ].filter(Boolean);
  if (failed.length === 0) return null;
  return (
    <div className="border-b bg-muted px-4 py-2 text-sm">{t.threadView.partialAuth(failed.join(", "))}</div>
  );
}

function AuthResults({ message }: { message: MessageDetail }) {
  const { t } = useI18n();
  if (!message.auth) return null;
  const { spf, dkim, dmarc } = message.auth;
  const summary = `SPF ${spf ?? "—"} · DKIM ${dkim ?? "—"} · DMARC ${dmarc ?? "—"}`;
  return <p className="px-4 pt-2 text-xs text-muted-foreground">{t.threadView.authResults(summary)}</p>;
}
```

In `MessageItem`, inside `{open && (<div>`, insert as the first children (before the `parseError` banner):

```tsx
          <AuthBanner message={message} />
          <AuthResults message={message} />
```

In the actions row, after the delete button, add:

```tsx
            {message.direction === "in" && message.folder !== "spam" && (
              <button
                type="button"
                className="rounded border border-border px-2 py-1 text-xs hover:bg-accent"
                onClick={() => updateMessage.mutate({ id: message.id, folder: "spam" })}
              >
                {t.threadView.reportSpam}
              </button>
            )}
            {message.folder === "spam" && (
              <button
                type="button"
                className="rounded border border-border px-2 py-1 text-xs hover:bg-accent"
                onClick={() => updateMessage.mutate({ id: message.id, folder: "inbox" })}
              >
                {t.threadView.notSpam}
              </button>
            )}
```

- [ ] **Step 7: Run to verify pass**

Run: `pnpm --filter web test`
Expected: PASS.

Run: `pnpm build`
Expected: succeeds — this is the only typecheck of `web/` and of the `fr`/`en` catalogue parity.

- [ ] **Step 8: Commit**

```bash
git add web/src
git commit -m "feat(web): spam folder, spoofing warning and verdicts"
```

---

### Task 7: Documentation and final check

**Files:**
- Modify: `AGENTS.md`
- Modify: `README.md`

**Interfaces:**
- Consumes: everything above. Produces: nothing for code.

- [ ] **Step 1: `AGENTS.md`**

Read the file, then:

1. In **Invariants**, add a section after "Forwarding is isolated from archiving":

   ```markdown
   ### Authentication verdicts come from Cloudflare's header only

   `parseAuthentication` (`src/ingest/auth.ts`) reads the **first**
   `Authentication-Results` header and only if its authserv-id is exactly
   `mx.cloudflare.net`. An MTA prepends its headers, so Cloudflare's sits above
   anything the sender wrote; a forged `mx.cloudflare.net` header further down
   is never read. Never search the headers for "any" Cloudflare line.

   Only `dmarc=fail` files a message in `spam` (`storeIncoming`). Email Routing
   already rejects SPF+DKIM failures and DMARC failures under
   `quarantine`/`reject`, so what reaches the Worker is the `p=none` grey zone.
   `spam_score` (`X-CF-SpamH-Score`) is stored and never used: its scale is
   undocumented. Forwarding ignores the verdict.
   ```

2. In **Purge order**, the "Deletion is two-step" paragraph: mention that `spam` is the second folder outside the counters (`src/db/folders.ts`, `countsInThread`) and that "Not spam" moves to `inbox`.

3. In **Migrations are immutable**, add:

   ```markdown
   Changing a `CHECK` on `messages` means rebuilding it (`0006`). D1 enforces
   foreign keys and won't let a migration disable them: `DROP TABLE messages`
   cascades into `recipients` and `attachments`, and `ALTER TABLE … RENAME`
   rewrites child foreign keys to the new name. Rebuild the child tables too,
   drop children first, rename after, keep ids so `messages_fts` stays valid,
   and recreate every index and FTS trigger.
   ```

4. In **Re-importing a message**, "Rows exist" bullet: add `auth_*` and `spam_score` to what a re-parse rewrites, and state again that `folder` never moves.

5. In **Scheduled maintenance**, "Trash purge": `folder IN ('trash','spam')`; `trashed_at` is set and cleared only by `moveToFolder` **and** by `storeIncoming` for a spam arrival — the two paths into a retained folder.

6. In **Deployment**, the migrate-before-deploy list: add "Without `0006`, every incoming message fails its D1 insert (unknown `auth_*` columns) and survives only as an orphan; the old code runs fine on a migrated schema, so migrate first."

7. In **Two test suites**: Worker files `26` → `28`.

- [ ] **Step 2: `README.md`**

Read the file, then:

1. In the features section, following its style, add a bullet: received messages show their SPF/DKIM/DMARC results; a message failing DMARC goes to **Spam** with a spoofing warning; "Report as spam" / "Not spam"; Spam is emptied after the same retention as the trash.
2. In the trash-retention paragraph of the configuration/operations sections, say `TRASH_RETENTION_DAYS` also applies to Spam.
3. In the upgrade notes (Operations), add: this release carries migration `0006`, which rebuilds the `messages` table; run `pnpm run migrate:remote` before `pnpm run deploy`. Messages received earlier have no verdicts until re-imported.
4. Replace the content of `## Roadmap` with: `Planned work is tracked in [GitHub issues](https://github.com/kermitsxb/cloudmail/issues?q=is%3Aissue+is%3Aopen+label%3Aenhancement).`

- [ ] **Step 3: Full verification**

Run: `pnpm test && pnpm typecheck && pnpm build`
Expected: both suites PASS, no type errors, build succeeds.

- [ ] **Step 4: Commit**

```bash
git add AGENTS.md README.md
git commit -m "docs: document authentication verdicts and the spam folder"
```
