# Cloudmail Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Construire un client webmail personnel sur `mail.planigramme.fr` qui reçoit les emails de `planigramme.fr` via Cloudflare Email Routing et les envoie via Cloudflare Email Sending.

**Architecture:** Un Worker unique porte trois responsabilités : un handler `email()` qui persiste les messages entrants (MIME brut en R2, métadonnées en D1), une API REST Hono sous `/api` protégée par Cloudflare Access, et le service du SPA React via le binding `assets`. Le MIME brut est écrit en R2 **avant** tout parsing, de sorte qu'aucun message ne peut être perdu.

**Tech Stack:** TypeScript, Cloudflare Workers (Wrangler 4), D1 (SQLite + FTS5), R2, Hono, Zod, postal-mime, React 19 + Vite + Tailwind + shadcn/ui + TanStack Query, Vitest avec `@cloudflare/vitest-plugin`.

**Spec:** `docs/superpowers/specs/2026-09-08-cloudmail-design.md`

## Global Constraints

- Domaine unique : `planigramme.fr`. Application déployée sur `mail.planigramme.fr`.
- Plan Workers Paid requis (Email Sending). Email Routing gratuit.
- **Limite dure de 5 MiB** par message envoyé, pièces jointes encodées en base64 comprises. Vérifiée côté front **et** côté Worker.
- Le handler `email()` ne doit **jamais** lever d'exception ni appeler `setReject()`.
- `message.raw` est un `ReadableStream` consommable **une seule fois** : il est bufferisé en `ArrayBuffer` puis réutilisé pour R2 et pour le parsing.
- Toutes les dates sont stockées en **epoch secondes** (`INTEGER`).
- Aucune route `/api` n'est servie sans JWT Cloudflare Access valide, sauf si `DEV_BYPASS_AUTH === "1"` (jamais défini en production).
- Le HTML des emails n'est **jamais** injecté dans le DOM de l'application : il est assaini côté Worker puis rendu dans une iframe `sandbox` sans `allow-scripts`.
- Gestionnaire de paquets : `pnpm`. Tous les commits suivent la convention `type: description` en français.
- Le code source vit dans `src/` (Worker) et `web/` (front). Les tests vivent dans `test/`.

---

## Structure des fichiers

**Worker**

| Fichier | Responsabilité |
|---|---|
| `src/index.ts` | Point d'entrée : export `fetch` (Hono) et `email` |
| `src/env.ts` | Type `Env` des bindings et variables |
| `src/email.ts` | Handler `email()` : buffer, R2, appel de `storeIncoming` |
| `src/ingest/parse.ts` | MIME brut → `ParsedMessage` normalisé ; helpers `normalizeSubject`, `safeKey` |
| `src/ingest/threading.ts` | Résolution du thread d'un message |
| `src/ingest/store.ts` | Persistance R2 + D1 d'un message entrant (idempotente) |
| `src/db/queries.ts` | Lectures : liste de threads, thread détaillé, identités |
| `src/db/mutations.ts` | Écritures API : lu/non-lu, dossier, purge, insertion d'un message sortant |
| `src/auth/access.ts` | Vérification du JWT Cloudflare Access + middleware Hono |
| `src/html/sanitize.ts` | Assainissement HTML via `HTMLRewriter` |
| `src/send/client.ts` | Client de l'API Email Sending |
| `src/api/routes.ts` | Déclaration des routes Hono et schémas Zod |
| `migrations/0001_initial.sql` | Schéma D1 complet |

**Front**

| Fichier | Responsabilité |
|---|---|
| `web/src/main.tsx`, `web/src/App.tsx` | Bootstrap React, routing, providers |
| `web/src/api/client.ts` | Fetch typé de l'API + hooks TanStack Query |
| `web/src/components/Sidebar.tsx` | Dossiers et identités |
| `web/src/components/ThreadList.tsx` | Liste des threads, recherche, pagination |
| `web/src/components/ThreadView.tsx` | Lecture d'un thread |
| `web/src/components/MessageBody.tsx` | Iframe sandbox + bandeau images distantes |
| `web/src/components/Composer.tsx` | Composition, réponse, pièces jointes |

---

### Task 1: Squelette du projet et harnais de test

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `tsconfig.json`, `wrangler.jsonc`, `vitest.config.ts`, `test/tsconfig.json`, `src/env.ts`, `src/index.ts`, `test/smoke.test.ts`, `.gitignore`
- Test: `test/smoke.test.ts`

**Interfaces:**
- Consumes: rien
- Produces: le type `Env` (bindings `DB: D1Database`, `MAIL: R2Bucket`, `ASSETS: Fetcher`, et les variables `CF_ACCOUNT_ID`, `CF_API_TOKEN`, `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`, `ALLOWED_EMAILS`, `DEV_BYPASS_AUTH`) ; un Worker exportant `fetch` ; une suite Vitest fonctionnelle avec D1 et R2 locales.

- [ ] **Step 1: Initialiser le projet et installer les dépendances**

```bash
cd /Users/thomas/Projets/Cloudmail
pnpm init
pnpm add hono zod postal-mime
pnpm add -D wrangler typescript vitest @cloudflare/vitest-plugin @cloudflare/workers-types
```

- [ ] **Step 2: Écrire `wrangler.jsonc`**

Remplacer `<D1_ID>` par l'identifiant retourné à l'étape 3.

```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "cloudmail",
  "main": "src/index.ts",
  "compatibility_date": "2026-09-08",
  "compatibility_flags": ["nodejs_compat"],
  "observability": { "enabled": true },
  "assets": {
    "directory": "./web/dist",
    "binding": "ASSETS",
    "not_found_handling": "single-page-application",
    "run_worker_first": ["/api/*"]
  },
  "d1_databases": [
    { "binding": "DB", "database_name": "cloudmail", "database_id": "<D1_ID>", "migrations_dir": "migrations" }
  ],
  "r2_buckets": [
    { "binding": "MAIL", "bucket_name": "cloudmail" }
  ],
  "vars": {
    "ACCESS_TEAM_DOMAIN": "",
    "ACCESS_AUD": "",
    "ALLOWED_EMAILS": "thomas.stocker.pro@gmail.com"
  }
}
```

- [ ] **Step 3: Créer les ressources distantes**

```bash
pnpm wrangler d1 create cloudmail       # copier database_id dans wrangler.jsonc
pnpm wrangler r2 bucket create cloudmail
```

- [ ] **Step 4: Écrire `src/env.ts`**

```ts
export interface Env {
  DB: D1Database;
  MAIL: R2Bucket;
  ASSETS: Fetcher;
  CF_ACCOUNT_ID: string;
  CF_API_TOKEN: string;
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUD: string;
  ALLOWED_EMAILS: string;
  DEV_BYPASS_AUTH?: string;
}
```

- [ ] **Step 5: Écrire `src/index.ts` minimal**

```ts
import { Hono } from "hono";
import type { Env } from "./env";

const app = new Hono<{ Bindings: Env }>();

app.get("/api/health", (c) => c.json({ ok: true }));

export default {
  fetch: app.fetch,
} satisfies ExportedHandler<Env>;
```

- [ ] **Step 6: Écrire `vitest.config.ts` et `test/tsconfig.json`**

```ts
// vitest.config.ts
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc" } })],
});
```

```jsonc
// test/tsconfig.json
{
  "extends": "../tsconfig.json",
  "compilerOptions": {
    "moduleResolution": "bundler",
    "types": ["@cloudflare/vitest-plugin/types"]
  },
  "include": ["./**/*.ts", "../src/**/*.ts"]
}
```

- [ ] **Step 7: Écrire le test de fumée**

```ts
// test/smoke.test.ts
import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("harnais", () => {
  it("sert /api/health", async () => {
    const res = await SELF.fetch("https://example.com/api/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("expose les bindings D1 et R2", async () => {
    const row = await env.DB.prepare("SELECT 1 AS n").first<{ n: number }>();
    expect(row?.n).toBe(1);
    await env.MAIL.put("probe.txt", "hello");
    const obj = await env.MAIL.get("probe.txt");
    expect(await obj?.text()).toBe("hello");
  });
});
```

- [ ] **Step 8: Lancer les tests**

Run: `pnpm vitest run`
Expected: 2 tests PASS.
Si l'import échoue sur `env` ou `SELF`, ils proviennent alors de `cloudflare:workers` — corriger l'import et relancer. Ne pas continuer tant que les deux tests ne passent pas.

- [ ] **Step 9: Committer**

```bash
git add -A
git commit -m "chore: initialise le Worker Cloudmail et le harnais Vitest"
```

---

### Task 2: Schéma D1 et recherche plein texte

**Files:**
- Create: `migrations/0001_initial.sql`, `test/db/schema.test.ts`
- Test: `test/db/schema.test.ts`

**Interfaces:**
- Consumes: le binding `DB` de la Task 1
- Produces: les tables `identities`, `threads`, `messages`, `recipients`, `attachments` et la table virtuelle `messages_fts` synchronisée par triggers. Toutes les tâches suivantes lisent et écrivent ce schéma.

- [ ] **Step 1: Écrire le test qui échoue**

```ts
// test/db/schema.test.ts
import { env, applyD1Migrations } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { readD1Migrations } from "@cloudflare/vitest-plugin/config";

beforeAll(async () => {
  await applyD1Migrations(env.DB, await readD1Migrations("./migrations"));
});

describe("schéma", () => {
  it("indexe automatiquement les messages dans FTS", async () => {
    await env.DB.prepare(
      `INSERT INTO threads (id, subject_norm, last_message_at) VALUES (1, 'facture', 1757318400)`
    ).run();
    await env.DB.prepare(
      `INSERT INTO messages (id, thread_id, message_id, direction, folder, from_addr, subject, text_body, received_at, raw_key)
       VALUES (1, 1, '<a@x>', 'in', 'inbox', 'zoe@example.com', 'Facture de septembre', 'Voici la facture réglée', 1757318400, 'raw/a.eml')`
    ).run();

    const hit = await env.DB.prepare(
      `SELECT m.id FROM messages_fts f JOIN messages m ON m.id = f.rowid WHERE messages_fts MATCH ?`
    ).bind("facture").first<{ id: number }>();
    expect(hit?.id).toBe(1);
  });

  it("ignore les accents dans la recherche", async () => {
    const hit = await env.DB.prepare(
      `SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?`
    ).bind("regle").first();
    expect(hit).not.toBeNull();
  });

  it("retire le message de FTS quand il est supprimé", async () => {
    await env.DB.prepare(`DELETE FROM messages WHERE id = 1`).run();
    const hit = await env.DB.prepare(
      `SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?`
    ).bind("facture").first();
    expect(hit).toBeNull();
  });

  it("refuse deux messages avec le même Message-ID", async () => {
    await env.DB.prepare(
      `INSERT INTO messages (thread_id, message_id, direction, folder, from_addr, received_at, raw_key)
       VALUES (1, '<dup@x>', 'in', 'inbox', 'a@b.c', 1, 'raw/d.eml')`
    ).run();
    const res = await env.DB.prepare(
      `INSERT OR IGNORE INTO messages (thread_id, message_id, direction, folder, from_addr, received_at, raw_key)
       VALUES (1, '<dup@x>', 'in', 'inbox', 'a@b.c', 1, 'raw/d.eml')`
    ).run();
    expect(res.meta.changes).toBe(0);
  });

  it("supprime les destinataires et pièces jointes en cascade", async () => {
    const { meta } = await env.DB.prepare(
      `INSERT INTO messages (thread_id, message_id, direction, folder, from_addr, received_at, raw_key)
       VALUES (1, '<casc@x>', 'in', 'inbox', 'a@b.c', 1, 'raw/c.eml')`
    ).run();
    const id = meta.last_row_id;
    await env.DB.prepare(
      `INSERT INTO recipients (message_id, kind, address) VALUES (?, 'to', 'x@y.z')`
    ).bind(id).run();
    await env.DB.prepare(`DELETE FROM messages WHERE id = ?`).bind(id).run();
    const left = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM recipients WHERE message_id = ?`
    ).bind(id).first<{ n: number }>();
    expect(left?.n).toBe(0);
  });
});
```

- [ ] **Step 2: Lancer le test pour vérifier qu'il échoue**

Run: `pnpm vitest run test/db/schema.test.ts`
Expected: FAIL — « no such table: threads ».

- [ ] **Step 3: Écrire la migration**

```sql
-- migrations/0001_initial.sql
PRAGMA foreign_keys = ON;

CREATE TABLE identities (
  id INTEGER PRIMARY KEY,
  address TEXT NOT NULL UNIQUE,
  display_name TEXT,
  is_default INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE threads (
  id INTEGER PRIMARY KEY,
  subject_norm TEXT NOT NULL,
  last_message_at INTEGER NOT NULL,
  message_count INTEGER NOT NULL DEFAULT 0,
  unread_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_threads_last ON threads(last_message_at DESC);

CREATE TABLE messages (
  id INTEGER PRIMARY KEY,
  thread_id INTEGER NOT NULL REFERENCES threads(id),
  message_id TEXT NOT NULL UNIQUE,
  in_reply_to TEXT,
  direction TEXT NOT NULL CHECK (direction IN ('in','out')),
  folder TEXT NOT NULL CHECK (folder IN ('inbox','sent','trash')),
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
  parse_error INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_messages_folder ON messages(folder, received_at DESC);
CREATE INDEX idx_messages_thread ON messages(thread_id);
CREATE INDEX idx_messages_in_reply_to ON messages(in_reply_to);

CREATE TABLE recipients (
  id INTEGER PRIMARY KEY,
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('to','cc','reply-to')),
  address TEXT NOT NULL,
  name TEXT
);
CREATE INDEX idx_recipients_message ON recipients(message_id);
CREATE INDEX idx_recipients_address ON recipients(address);

CREATE TABLE attachments (
  id INTEGER PRIMARY KEY,
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  filename TEXT,
  mime_type TEXT,
  size INTEGER,
  content_id TEXT,
  r2_key TEXT NOT NULL
);
CREATE INDEX idx_attachments_message ON attachments(message_id);

CREATE VIRTUAL TABLE messages_fts USING fts5(
  subject, from_addr, text_body,
  content='messages', content_rowid='id',
  tokenize="unicode61 remove_diacritics 2"
);

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

- [ ] **Step 4: Lancer les tests**

Run: `pnpm vitest run test/db/schema.test.ts`
Expected: 5 tests PASS.

- [ ] **Step 5: Appliquer la migration en local et en distant**

```bash
pnpm wrangler d1 migrations apply cloudmail --local
pnpm wrangler d1 migrations apply cloudmail --remote
```

- [ ] **Step 6: Committer**

```bash
git add migrations test/db
git commit -m "feat: ajoute le schéma D1 et l'index de recherche FTS5"
```

---

### Task 3: Parsing MIME vers un message normalisé

**Files:**
- Create: `src/ingest/parse.ts`, `test/fixtures/*.eml`, `test/ingest/parse.test.ts`
- Test: `test/ingest/parse.test.ts`

**Interfaces:**
- Consumes: rien
- Produces:

```ts
export type ParsedAddress = { address: string; name: string | null };
export type ParsedAttachment = {
  filename: string;
  mimeType: string;
  size: number;
  contentId: string | null;   // sans les chevrons
  content: ArrayBuffer;
};
export type ParsedMessage = {
  messageId: string;          // avec chevrons ; UUID synthétique si absent
  inReplyTo: string | null;
  references: string[];
  from: ParsedAddress;
  to: ParsedAddress[];
  cc: ParsedAddress[];
  replyTo: ParsedAddress[];
  subject: string;
  text: string;
  html: string | null;
  date: number;               // epoch secondes
  attachments: ParsedAttachment[];
  parseError: boolean;
};
export async function parseEmail(raw: ArrayBuffer, envelopeFrom: string): Promise<ParsedMessage>;
export function normalizeSubject(subject: string): string;
export function safeKey(messageId: string): string;
export function snippetOf(text: string): string;
```

- [ ] **Step 1: Créer les fixtures**

Créer six fichiers dans `test/fixtures/` avec ce contenu exact (les `.eml` utilisent des fins de ligne CRLF ; les écrire avec `printf '...\r\n'` ou vérifier que le parseur tolère LF — postal-mime tolère les deux).

```
simple.eml
---
From: Zoé Martin <zoe@example.com>
To: thomas@planigramme.fr
Subject: =?utf-8?B?RmFjdHVyZSByw6lnbMOpZQ==?=
Message-ID: <simple-1@example.com>
Date: Mon, 08 Sep 2026 10:00:00 +0200
Content-Type: text/plain; charset=utf-8

Bonjour, la facture est réglée.
```

```
multipart.eml
---
From: bot@example.com
To: thomas@planigramme.fr, autre@planigramme.fr
Cc: chef@example.com
Subject: Rapport
Message-ID: <multi-1@example.com>
Date: Mon, 08 Sep 2026 11:00:00 +0200
Content-Type: multipart/alternative; boundary="b1"

--b1
Content-Type: text/plain; charset=utf-8

Version texte
--b1
Content-Type: text/html; charset=utf-8

<p>Version <b>HTML</b></p>
--b1--
```

```
attachment.eml
---
From: a@example.com
To: thomas@planigramme.fr
Subject: Avec PJ
Message-ID: <att-1@example.com>
Date: Mon, 08 Sep 2026 12:00:00 +0200
Content-Type: multipart/mixed; boundary="b2"

--b2
Content-Type: text/plain; charset=utf-8

Voir la pièce jointe.
--b2
Content-Type: text/csv; name="data.csv"
Content-Disposition: attachment; filename="data.csv"
Content-Transfer-Encoding: base64

YSxiLGMKMSwyLDMK
--b2--
```

```
inline-image.eml
---
From: a@example.com
To: thomas@planigramme.fr
Subject: Image inline
Message-ID: <inline-1@example.com>
Date: Mon, 08 Sep 2026 13:00:00 +0200
Content-Type: multipart/related; boundary="b3"

--b3
Content-Type: text/html; charset=utf-8

<p>Logo : <img src="cid:logo123"></p>
--b3
Content-Type: image/png
Content-ID: <logo123>
Content-Disposition: inline; filename="logo.png"
Content-Transfer-Encoding: base64

iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==
--b3--
```

```
latin1.eml
---
From: a@example.com
To: thomas@planigramme.fr
Subject: =?ISO-8859-1?Q?R=E9union?=
Message-ID: <latin1-1@example.com>
Date: Mon, 08 Sep 2026 14:00:00 +0200
Content-Type: text/plain; charset=ISO-8859-1
Content-Transfer-Encoding: quoted-printable

R=E9union pr=E9vue =E0 14h.
```

```
malformed.eml
---
Ceci n'est pas un email valide, il n'y a aucun en-tête et pas de ligne vide de séparation.
```

- [ ] **Step 2: Écrire le test qui échoue**

```ts
// test/ingest/parse.test.ts
import { describe, expect, it } from "vitest";
import { parseEmail, normalizeSubject, safeKey, snippetOf } from "../../src/ingest/parse";

const load = async (name: string): Promise<ArrayBuffer> => {
  const mod = await import(`../fixtures/${name}?raw`);
  return new TextEncoder().encode(mod.default).buffer;
};

describe("parseEmail", () => {
  it("décode le sujet encodé et l'expéditeur", async () => {
    const m = await parseEmail(await load("simple.eml"), "zoe@example.com");
    expect(m.subject).toBe("Facture réglée");
    expect(m.from).toEqual({ address: "zoe@example.com", name: "Zoé Martin" });
    expect(m.messageId).toBe("<simple-1@example.com>");
    expect(m.text.trim()).toBe("Bonjour, la facture est réglée.");
    expect(m.parseError).toBe(false);
  });

  it("extrait les destinataires multiples et le HTML", async () => {
    const m = await parseEmail(await load("multipart.eml"), "bot@example.com");
    expect(m.to.map((a) => a.address)).toEqual(["thomas@planigramme.fr", "autre@planigramme.fr"]);
    expect(m.cc.map((a) => a.address)).toEqual(["chef@example.com"]);
    expect(m.html).toContain("<b>HTML</b>");
    expect(m.text).toContain("Version texte");
  });

  it("décode une pièce jointe base64", async () => {
    const m = await parseEmail(await load("attachment.eml"), "a@example.com");
    expect(m.attachments).toHaveLength(1);
    const att = m.attachments[0];
    expect(att.filename).toBe("data.csv");
    expect(att.mimeType).toBe("text/csv");
    expect(new TextDecoder().decode(att.content)).toBe("a,b,c\n1,2,3\n");
    expect(att.size).toBe(12);
  });

  it("expose le contentId d'une image inline sans chevrons", async () => {
    const m = await parseEmail(await load("inline-image.eml"), "a@example.com");
    expect(m.attachments[0].contentId).toBe("logo123");
  });

  it("décode le latin-1 en quoted-printable", async () => {
    const m = await parseEmail(await load("latin1.eml"), "a@example.com");
    expect(m.subject).toBe("Réunion");
    expect(m.text).toContain("Réunion prévue à 14h.");
  });

  it("dégrade proprement un message malformé", async () => {
    const m = await parseEmail(await load("malformed.eml"), "inconnu@example.com");
    expect(m.parseError).toBe(true);
    expect(m.from.address).toBe("inconnu@example.com");
    expect(m.messageId).toMatch(/^<[0-9a-f-]{36}@cloudmail\.local>$/);
  });
});

describe("normalizeSubject", () => {
  it("retire les préfixes de réponse et de transfert", () => {
    expect(normalizeSubject("Re: Fwd: RE : Tr: Facture")).toBe("facture");
    expect(normalizeSubject("")).toBe("");
  });
});

describe("safeKey", () => {
  it("réduit le Message-ID aux caractères sûrs", () => {
    expect(safeKey("<a/b c@ex.com>")).toBe("a-b-c-ex.com");
  });

  it("tronque à 200 caractères", () => {
    expect(safeKey("<" + "x".repeat(400) + ">").length).toBe(200);
  });
});

describe("snippetOf", () => {
  it("normalise les espaces et tronque à 200 caractères", () => {
    expect(snippetOf("  a\n\n  b  ")).toBe("a b");
    expect(snippetOf("y".repeat(300)).length).toBe(200);
  });
});
```

- [ ] **Step 3: Lancer le test pour vérifier qu'il échoue**

Run: `pnpm vitest run test/ingest/parse.test.ts`
Expected: FAIL — module `src/ingest/parse` introuvable.

- [ ] **Step 4: Implémenter `src/ingest/parse.ts`**

```ts
import PostalMime, { type Address } from "postal-mime";

export type ParsedAddress = { address: string; name: string | null };
export type ParsedAttachment = {
  filename: string;
  mimeType: string;
  size: number;
  contentId: string | null;
  content: ArrayBuffer;
};
export type ParsedMessage = {
  messageId: string;
  inReplyTo: string | null;
  references: string[];
  from: ParsedAddress;
  to: ParsedAddress[];
  cc: ParsedAddress[];
  replyTo: ParsedAddress[];
  subject: string;
  text: string;
  html: string | null;
  date: number;
  attachments: ParsedAttachment[];
  parseError: boolean;
};

const RE_PREFIX = /^\s*(re|ré|rép|rep|fw|fwd|tr)\s*(\[\d+\])?\s*:\s*/i;

export function normalizeSubject(subject: string): string {
  let s = (subject ?? "").trim();
  while (RE_PREFIX.test(s)) s = s.replace(RE_PREFIX, "");
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

export function safeKey(messageId: string): string {
  const stripped = messageId.replace(/^<|>$/g, "");
  const cleaned = stripped.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return (cleaned || "unknown").slice(0, 200);
}

export function snippetOf(text: string): string {
  return (text ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
}

const toAddresses = (list: Address[] | undefined): ParsedAddress[] =>
  (list ?? []).flatMap((a) =>
    "group" in a && Array.isArray((a as { group?: Address[] }).group)
      ? toAddresses((a as { group: Address[] }).group)
      : a.address
        ? [{ address: a.address.toLowerCase(), name: a.name || null }]
        : []
  );

export async function parseEmail(raw: ArrayBuffer, envelopeFrom: string): Promise<ParsedMessage> {
  const fallback = (): ParsedMessage => ({
    messageId: `<${crypto.randomUUID()}@cloudmail.local>`,
    inReplyTo: null,
    references: [],
    from: { address: envelopeFrom.toLowerCase(), name: null },
    to: [],
    cc: [],
    replyTo: [],
    subject: "(message illisible)",
    text: "",
    html: null,
    date: Math.floor(Date.now() / 1000),
    attachments: [],
    parseError: true,
  });

  let email;
  try {
    email = await PostalMime.parse(raw, { maxNestingDepth: 50 });
  } catch {
    return fallback();
  }

  // Un message sans expéditeur ni sujet ni corps n'a pas été réellement compris.
  if (!email.from?.address && !email.subject && !email.text && !email.html) {
    return fallback();
  }

  const date = email.date ? Math.floor(new Date(email.date).getTime() / 1000) : NaN;

  return {
    messageId: email.messageId ?? `<${crypto.randomUUID()}@cloudmail.local>`,
    inReplyTo: email.inReplyTo ?? null,
    references: (email.references ?? "").split(/\s+/).filter((r) => r.startsWith("<")),
    from: email.from?.address
      ? { address: email.from.address.toLowerCase(), name: email.from.name || null }
      : { address: envelopeFrom.toLowerCase(), name: null },
    to: toAddresses(email.to),
    cc: toAddresses(email.cc),
    replyTo: toAddresses(email.replyTo),
    subject: email.subject ?? "",
    text: email.text ?? "",
    html: email.html ?? null,
    date: Number.isFinite(date) ? date : Math.floor(Date.now() / 1000),
    attachments: (email.attachments ?? []).map((a) => {
      const content = a.content as ArrayBuffer;
      return {
        filename: a.filename || "sans-nom",
        mimeType: a.mimeType || "application/octet-stream",
        size: content.byteLength,
        contentId: a.contentId ? a.contentId.replace(/^<|>$/g, "") : null,
        content,
      };
    }),
    parseError: false,
  };
}
```

- [ ] **Step 5: Lancer les tests**

Run: `pnpm vitest run test/ingest/parse.test.ts`
Expected: 10 tests PASS. Si l'import `?raw` des fixtures échoue, remplacer le helper `load` par une lecture via `node:fs` dans un fichier `test/fixtures/index.ts` exécuté côté Node.

- [ ] **Step 6: Committer**

```bash
git add src/ingest/parse.ts test/fixtures test/ingest
git commit -m "feat: parse les emails MIME vers une structure normalisée"
```

---

### Task 4: Résolution des threads

**Files:**
- Create: `src/ingest/threading.ts`, `test/ingest/threading.test.ts`
- Test: `test/ingest/threading.test.ts`

**Interfaces:**
- Consumes: `ParsedMessage` (Task 3), le schéma D1 (Task 2)
- Produces:

```ts
export type ThreadResolution = { threadId: number; created: boolean };
export async function resolveThread(
  db: D1Database,
  msg: ParsedMessage,
  participants: string[],   // adresses en minuscules : expéditeur + destinataires
): Promise<ThreadResolution>;
```

- [ ] **Step 1: Écrire le test qui échoue**

```ts
// test/ingest/threading.test.ts
import { env, applyD1Migrations } from "cloudflare:test";
import { readD1Migrations } from "@cloudflare/vitest-plugin/config";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resolveThread } from "../../src/ingest/threading";
import type { ParsedMessage } from "../../src/ingest/parse";

beforeAll(async () => {
  await applyD1Migrations(env.DB, await readD1Migrations("./migrations"));
});

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM messages"),
    env.DB.prepare("DELETE FROM threads"),
  ]);
});

const msg = (over: Partial<ParsedMessage>): ParsedMessage => ({
  messageId: "<m1@x>", inReplyTo: null, references: [],
  from: { address: "zoe@example.com", name: null },
  to: [{ address: "thomas@planigramme.fr", name: null }],
  cc: [], replyTo: [], subject: "Facture", text: "", html: null,
  date: 1757318400, attachments: [], parseError: false, ...over,
});

const seed = async (messageId: string, subject: string, threadId: number, at = 1757318400) => {
  await env.DB.prepare(
    `INSERT OR IGNORE INTO threads (id, subject_norm, last_message_at) VALUES (?, ?, ?)`
  ).bind(threadId, subject, at).run();
  await env.DB.prepare(
    `INSERT INTO messages (thread_id, message_id, direction, folder, from_addr, subject, received_at, raw_key)
     VALUES (?, ?, 'in', 'inbox', 'zoe@example.com', ?, ?, 'raw/x.eml')`
  ).bind(threadId, messageId, subject, at).run();
  await env.DB.prepare(
    `INSERT INTO recipients (message_id, kind, address)
     VALUES ((SELECT id FROM messages WHERE message_id = ?), 'to', 'thomas@planigramme.fr')`
  ).bind(messageId).run();
};

describe("resolveThread", () => {
  it("crée un thread quand rien ne correspond", async () => {
    const r = await resolveThread(env.DB, msg({}), ["zoe@example.com"]);
    expect(r.created).toBe(true);
    const t = await env.DB.prepare("SELECT subject_norm FROM threads WHERE id = ?")
      .bind(r.threadId).first<{ subject_norm: string }>();
    expect(t?.subject_norm).toBe("facture");
  });

  it("rattache via In-Reply-To", async () => {
    await seed("<parent@x>", "facture", 7);
    const r = await resolveThread(env.DB, msg({ messageId: "<m2@x>", inReplyTo: "<parent@x>" }), []);
    expect(r).toEqual({ threadId: 7, created: false });
  });

  it("rattache via References en partant du plus récent", async () => {
    await seed("<ancien@x>", "facture", 3);
    await seed("<recent@x>", "facture", 4);
    const r = await resolveThread(
      env.DB,
      msg({ messageId: "<m3@x>", references: ["<ancien@x>", "<recent@x>"] }),
      []
    );
    expect(r.threadId).toBe(4);
  });

  it("rattache par sujet normalisé et participant commun", async () => {
    await seed("<p@x>", "facture", 9);
    const r = await resolveThread(
      env.DB,
      msg({ messageId: "<m4@x>", subject: "Re: Facture" }),
      ["zoe@example.com"]
    );
    expect(r.threadId).toBe(9);
  });

  it("ne rattache pas par sujet au-delà de 30 jours", async () => {
    const vieux = 1757318400 - 31 * 86400;
    await seed("<vieux@x>", "facture", 11, vieux);
    const r = await resolveThread(env.DB, msg({ messageId: "<m5@x>", subject: "Re: Facture" }), ["zoe@example.com"]);
    expect(r.created).toBe(true);
    expect(r.threadId).not.toBe(11);
  });

  it("ne rattache pas par sujet sans participant commun", async () => {
    await seed("<p2@x>", "facture", 13);
    const r = await resolveThread(env.DB, msg({ messageId: "<m6@x>", subject: "Facture" }), ["inconnu@ailleurs.com"]);
    expect(r.created).toBe(true);
  });

  it("crée un thread pour un sujet vide plutôt que de tout regrouper", async () => {
    await seed("<p3@x>", "", 15);
    const r = await resolveThread(env.DB, msg({ messageId: "<m7@x>", subject: "" }), ["zoe@example.com"]);
    expect(r.created).toBe(true);
  });
});
```

- [ ] **Step 2: Lancer le test pour vérifier qu'il échoue**

Run: `pnpm vitest run test/ingest/threading.test.ts`
Expected: FAIL — module `src/ingest/threading` introuvable.

- [ ] **Step 3: Implémenter `src/ingest/threading.ts`**

```ts
import { normalizeSubject, type ParsedMessage } from "./parse";

export type ThreadResolution = { threadId: number; created: boolean };

const THIRTY_DAYS = 30 * 86400;

async function threadOfMessage(db: D1Database, messageId: string): Promise<number | null> {
  const row = await db
    .prepare("SELECT thread_id FROM messages WHERE message_id = ?")
    .bind(messageId)
    .first<{ thread_id: number }>();
  return row?.thread_id ?? null;
}

export async function resolveThread(
  db: D1Database,
  msg: ParsedMessage,
  participants: string[],
): Promise<ThreadResolution> {
  if (msg.inReplyTo) {
    const id = await threadOfMessage(db, msg.inReplyTo);
    if (id !== null) return { threadId: id, created: false };
  }

  for (const ref of [...msg.references].reverse()) {
    const id = await threadOfMessage(db, ref);
    if (id !== null) return { threadId: id, created: false };
  }

  const subjectNorm = normalizeSubject(msg.subject);
  if (subjectNorm && participants.length > 0) {
    const placeholders = participants.map(() => "?").join(",");
    const row = await db
      .prepare(
        `SELECT t.id FROM threads t
         JOIN messages m ON m.thread_id = t.id
         LEFT JOIN recipients r ON r.message_id = m.id
         WHERE t.subject_norm = ?
           AND t.last_message_at >= ?
           AND (m.from_addr IN (${placeholders}) OR r.address IN (${placeholders}))
         ORDER BY t.last_message_at DESC
         LIMIT 1`
      )
      .bind(subjectNorm, msg.date - THIRTY_DAYS, ...participants, ...participants)
      .first<{ id: number }>();
    if (row) return { threadId: row.id, created: false };
  }

  const inserted = await db
    .prepare("INSERT INTO threads (subject_norm, last_message_at) VALUES (?, ?)")
    .bind(subjectNorm, msg.date)
    .run();
  return { threadId: Number(inserted.meta.last_row_id), created: true };
}
```

- [ ] **Step 4: Lancer les tests**

Run: `pnpm vitest run test/ingest/threading.test.ts`
Expected: 7 tests PASS.

- [ ] **Step 5: Committer**

```bash
git add src/ingest/threading.ts test/ingest/threading.test.ts
git commit -m "feat: résout le thread d'un message entrant"
```

---

### Task 5: Persistance d'un message entrant

**Files:**
- Create: `src/ingest/store.ts`, `test/ingest/store.test.ts`
- Test: `test/ingest/store.test.ts`

**Interfaces:**
- Consumes: `parseEmail`, `safeKey`, `snippetOf` (Task 3), `resolveThread` (Task 4), schéma D1 (Task 2)
- Produces:

```ts
export type StoreResult = { messageId: number | null; duplicate: boolean; rawKey: string };
export async function storeIncoming(
  env: Env,
  raw: ArrayBuffer,
  envelope: { from: string; to: string },
): Promise<StoreResult>;
```

- [ ] **Step 1: Écrire le test qui échoue**

```ts
// test/ingest/store.test.ts
import { env, applyD1Migrations } from "cloudflare:test";
import { readD1Migrations } from "@cloudflare/vitest-plugin/config";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { storeIncoming } from "../../src/ingest/store";

beforeAll(async () => {
  await applyD1Migrations(env.DB, await readD1Migrations("./migrations"));
});

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM attachments"),
    env.DB.prepare("DELETE FROM recipients"),
    env.DB.prepare("DELETE FROM messages"),
    env.DB.prepare("DELETE FROM threads"),
  ]);
});

const load = async (name: string): Promise<ArrayBuffer> => {
  const mod = await import(`../fixtures/${name}?raw`);
  return new TextEncoder().encode(mod.default).buffer;
};

const envelope = { from: "zoe@example.com", to: "thomas@planigramme.fr" };

describe("storeIncoming", () => {
  it("écrit le MIME brut dans R2 et le message dans D1", async () => {
    const res = await storeIncoming(env, await load("simple.eml"), envelope);
    expect(res.duplicate).toBe(false);
    expect(res.rawKey).toBe("raw/simple-1-example.com.eml");

    const obj = await env.MAIL.get(res.rawKey);
    expect(obj).not.toBeNull();

    const m = await env.DB.prepare(
      "SELECT subject, from_addr, folder, direction, snippet, is_read, has_attachments FROM messages WHERE id = ?"
    ).bind(res.messageId).first<Record<string, unknown>>();
    expect(m).toMatchObject({
      subject: "Facture réglée",
      from_addr: "zoe@example.com",
      folder: "inbox",
      direction: "in",
      is_read: 0,
      has_attachments: 0,
    });
    expect(m?.snippet).toContain("la facture est réglée");
  });

  it("enregistre les destinataires To et Cc", async () => {
    const res = await storeIncoming(env, await load("multipart.eml"), envelope);
    const rows = await env.DB.prepare(
      "SELECT kind, address FROM recipients WHERE message_id = ? ORDER BY kind, address"
    ).bind(res.messageId).all<{ kind: string; address: string }>();
    expect(rows.results).toEqual([
      { kind: "cc", address: "chef@example.com" },
      { kind: "to", address: "autre@planigramme.fr" },
      { kind: "to", address: "thomas@planigramme.fr" },
    ]);
  });

  it("extrait les pièces jointes vers R2", async () => {
    const res = await storeIncoming(env, await load("attachment.eml"), envelope);
    const att = await env.DB.prepare(
      "SELECT filename, mime_type, size, r2_key FROM attachments WHERE message_id = ?"
    ).bind(res.messageId).first<{ filename: string; mime_type: string; size: number; r2_key: string }>();
    expect(att?.filename).toBe("data.csv");
    expect(att?.r2_key).toBe("att/att-1-example.com/0-data.csv");
    const obj = await env.MAIL.get(att!.r2_key);
    expect(await obj?.text()).toBe("a,b,c\n1,2,3\n");

    const m = await env.DB.prepare("SELECT has_attachments FROM messages WHERE id = ?")
      .bind(res.messageId).first<{ has_attachments: number }>();
    expect(m?.has_attachments).toBe(1);
  });

  it("est idempotent sur le Message-ID", async () => {
    const raw = await load("simple.eml");
    await storeIncoming(env, raw, envelope);
    const second = await storeIncoming(env, raw, envelope);
    expect(second.duplicate).toBe(true);
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM messages").first<{ n: number }>();
    expect(n?.n).toBe(1);
  });

  it("met à jour les compteurs du thread", async () => {
    const res = await storeIncoming(env, await load("simple.eml"), envelope);
    const t = await env.DB.prepare(
      "SELECT message_count, unread_count, last_message_at FROM threads WHERE id = (SELECT thread_id FROM messages WHERE id = ?)"
    ).bind(res.messageId).first<{ message_count: number; unread_count: number; last_message_at: number }>();
    expect(t).toMatchObject({ message_count: 1, unread_count: 1 });
    expect(t?.last_message_at).toBe(1788854400); // 2026-09-08T10:00:00+02:00
  });

  it("stocke quand même un message illisible avec parse_error", async () => {
    const res = await storeIncoming(env, await load("malformed.eml"), envelope);
    const m = await env.DB.prepare("SELECT parse_error, from_addr, raw_key FROM messages WHERE id = ?")
      .bind(res.messageId).first<{ parse_error: number; from_addr: string; raw_key: string }>();
    expect(m?.parse_error).toBe(1);
    expect(m?.from_addr).toBe("zoe@example.com");
    const obj = await env.MAIL.get(m!.raw_key);
    expect(obj).not.toBeNull();
  });

  it("écrit le brut dans R2 même si l'insertion D1 échoue", async () => {
    const broken = { ...env, DB: { prepare: () => { throw new Error("d1 down"); } } } as unknown as typeof env;
    await expect(storeIncoming(broken, await load("simple.eml"), envelope)).rejects.toThrow();
    const obj = await env.MAIL.get("raw/simple-1-example.com.eml");
    expect(obj).not.toBeNull();
  });
});
```

- [ ] **Step 2: Lancer le test pour vérifier qu'il échoue**

Run: `pnpm vitest run test/ingest/store.test.ts`
Expected: FAIL — module `src/ingest/store` introuvable.

- [ ] **Step 3: Implémenter `src/ingest/store.ts`**

```ts
import type { Env } from "../env";
import { parseEmail, safeKey, snippetOf, type ParsedMessage } from "./parse";
import { resolveThread } from "./threading";

export type StoreResult = { messageId: number | null; duplicate: boolean; rawKey: string };

const sanitizeFilename = (name: string): string =>
  name.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 120) || "fichier";

export async function storeIncoming(
  env: Env,
  raw: ArrayBuffer,
  envelope: { from: string; to: string },
): Promise<StoreResult> {
  // Le brut est écrit AVANT tout parsing : un message reste toujours rejouable.
  let msg: ParsedMessage;
  let rawKey: string;
  try {
    msg = await parseEmail(raw, envelope.from);
    rawKey = `raw/${safeKey(msg.messageId)}.eml`;
  } catch {
    msg = await parseEmail(new ArrayBuffer(0), envelope.from);
    rawKey = `raw/${safeKey(msg.messageId)}.eml`;
  }
  await env.MAIL.put(rawKey, raw);

  const key = safeKey(msg.messageId);
  const participants = [
    msg.from.address,
    ...msg.to.map((a) => a.address),
    ...msg.cc.map((a) => a.address),
  ];

  const existing = await env.DB.prepare("SELECT id FROM messages WHERE message_id = ?")
    .bind(msg.messageId)
    .first<{ id: number }>();
  if (existing) return { messageId: existing.id, duplicate: true, rawKey };

  const { threadId } = await resolveThread(env.DB, msg, participants);

  const inserted = await env.DB.prepare(
    `INSERT INTO messages
       (thread_id, message_id, in_reply_to, direction, folder, from_addr, from_name,
        subject, text_body, html_body, snippet, received_at, is_read, has_attachments, raw_key, parse_error)
     VALUES (?, ?, ?, 'in', 'inbox', ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`
  ).bind(
    threadId, msg.messageId, msg.inReplyTo, msg.from.address, msg.from.name,
    msg.subject, msg.text, msg.html, snippetOf(msg.text || msg.subject),
    msg.date, msg.attachments.length > 0 ? 1 : 0, rawKey, msg.parseError ? 1 : 0
  ).run();
  const messageId = Number(inserted.meta.last_row_id);

  const statements: D1PreparedStatement[] = [];
  for (const [kind, list] of [["to", msg.to], ["cc", msg.cc], ["reply-to", msg.replyTo]] as const) {
    for (const a of list) {
      statements.push(
        env.DB.prepare("INSERT INTO recipients (message_id, kind, address, name) VALUES (?, ?, ?, ?)")
          .bind(messageId, kind, a.address, a.name)
      );
    }
  }

  for (const [i, att] of msg.attachments.entries()) {
    const r2Key = `att/${key}/${i}-${sanitizeFilename(att.filename)}`;
    await env.MAIL.put(r2Key, att.content, { httpMetadata: { contentType: att.mimeType } });
    statements.push(
      env.DB.prepare(
        "INSERT INTO attachments (message_id, filename, mime_type, size, content_id, r2_key) VALUES (?, ?, ?, ?, ?, ?)"
      ).bind(messageId, att.filename, att.mimeType, att.size, att.contentId, r2Key)
    );
  }

  statements.push(
    env.DB.prepare(
      `UPDATE threads
         SET message_count = message_count + 1,
             unread_count = unread_count + 1,
             last_message_at = MAX(last_message_at, ?)
       WHERE id = ?`
    ).bind(msg.date, threadId)
  );

  await env.DB.batch(statements);
  return { messageId, duplicate: false, rawKey };
}
```

- [ ] **Step 4: Lancer les tests**

Run: `pnpm vitest run test/ingest/store.test.ts`
Expected: 7 tests PASS.

- [ ] **Step 5: Committer**

```bash
git add src/ingest/store.ts test/ingest/store.test.ts
git commit -m "feat: persiste les messages entrants dans R2 et D1"
```

---

### Task 6: Handler email() et rejeu

**Files:**
- Modify: `src/index.ts`
- Create: `src/email.ts`, `test/email-handler.test.ts`
- Test: `test/email-handler.test.ts`

**Interfaces:**
- Consumes: `storeIncoming` (Task 5)
- Produces: `export default { fetch, email }` — le Worker traite désormais les messages routés par Email Routing. Fonction exportée :

```ts
export async function handleEmail(message: ForwardableEmailMessage, env: Env): Promise<void>;
export async function reparse(env: Env, rawKey: string, envelopeFrom: string): Promise<void>;
```

- [ ] **Step 1: Écrire le test qui échoue**

```ts
// test/email-handler.test.ts
import { env, applyD1Migrations } from "cloudflare:test";
import { readD1Migrations } from "@cloudflare/vitest-plugin/config";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { handleEmail } from "../src/email";

beforeAll(async () => {
  await applyD1Migrations(env.DB, await readD1Migrations("./migrations"));
});

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM recipients"),
    env.DB.prepare("DELETE FROM messages"),
    env.DB.prepare("DELETE FROM threads"),
  ]);
});

const fakeMessage = async (fixture: string) => {
  const mod = await import(`./fixtures/${fixture}?raw`);
  const bytes = new TextEncoder().encode(mod.default);
  return {
    from: "zoe@example.com",
    to: "thomas@planigramme.fr",
    rawSize: bytes.byteLength,
    raw: new Response(bytes).body!,
    headers: new Headers(),
    setReject: vi.fn(),
    forward: vi.fn(),
    reply: vi.fn(),
  } as unknown as ForwardableEmailMessage & { setReject: ReturnType<typeof vi.fn> };
};

describe("handleEmail", () => {
  it("persiste un message reçu", async () => {
    await handleEmail(await fakeMessage("simple.eml"), env);
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM messages").first<{ n: number }>();
    expect(n?.n).toBe(1);
  });

  it("ne rejette jamais le message, même en cas d'erreur interne", async () => {
    const msg = await fakeMessage("simple.eml");
    const broken = { ...env, MAIL: { put: () => { throw new Error("r2 down"); } } } as unknown as typeof env;
    await expect(handleEmail(msg, broken)).resolves.toBeUndefined();
    expect(msg.setReject).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Lancer le test pour vérifier qu'il échoue**

Run: `pnpm vitest run test/email-handler.test.ts`
Expected: FAIL — module `src/email` introuvable.

- [ ] **Step 3: Implémenter `src/email.ts`**

```ts
import type { Env } from "./env";
import { storeIncoming } from "./ingest/store";

export async function handleEmail(message: ForwardableEmailMessage, env: Env): Promise<void> {
  try {
    const raw = await new Response(message.raw).arrayBuffer();
    const res = await storeIncoming(env, raw, { from: message.from, to: message.to });
    console.log(JSON.stringify({ event: "email_stored", ...res, from: message.from }));
  } catch (err) {
    // On n'appelle jamais setReject : un rejet renverrait un bounce à l'expéditeur.
    console.error(JSON.stringify({
      event: "email_failed",
      from: message.from,
      to: message.to,
      error: err instanceof Error ? err.message : String(err),
    }));
  }
}

export async function reparse(env: Env, rawKey: string, envelopeFrom: string): Promise<void> {
  const obj = await env.MAIL.get(rawKey);
  if (!obj) throw new Error(`objet R2 introuvable : ${rawKey}`);
  const raw = await obj.arrayBuffer();
  const parsed = await import("./ingest/parse").then((m) => m.parseEmail(raw, envelopeFrom));
  await env.DB.prepare("DELETE FROM messages WHERE message_id = ?").bind(parsed.messageId).run();
  await storeIncoming(env, raw, { from: envelopeFrom, to: "" });
}
```

- [ ] **Step 4: Brancher le handler dans `src/index.ts`**

```ts
import { Hono } from "hono";
import type { Env } from "./env";
import { handleEmail } from "./email";

const app = new Hono<{ Bindings: Env }>();

app.get("/api/health", (c) => c.json({ ok: true }));

export { app };

export default {
  fetch: app.fetch,
  email: handleEmail,
} satisfies ExportedHandler<Env>;
```

- [ ] **Step 5: Lancer les tests**

Run: `pnpm vitest run`
Expected: toute la suite PASS.

- [ ] **Step 6: Committer**

```bash
git add src/email.ts src/index.ts test/email-handler.test.ts
git commit -m "feat: branche le handler email() sur l'ingestion"
```

---

### Task 7: Authentification Cloudflare Access

**Files:**
- Create: `src/auth/access.ts`, `test/auth/access.test.ts`
- Modify: `src/index.ts`
- Test: `test/auth/access.test.ts`

**Interfaces:**
- Consumes: `Env` (Task 1)
- Produces:

```ts
export type AccessIdentity = { email: string };
export async function verifyAccessJwt(env: Env, token: string): Promise<AccessIdentity>;
export function requireAccess(): MiddlewareHandler<{ Bindings: Env; Variables: { identity: AccessIdentity } }>;
```
Toutes les routes API des tâches suivantes s'exécutent derrière ce middleware et peuvent lire `c.get("identity")`.

- [ ] **Step 1: Installer `jose`**

```bash
pnpm add jose
```

- [ ] **Step 2: Écrire le test qui échoue**

```ts
// test/auth/access.test.ts
import { SELF, env } from "cloudflare:test";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { verifyAccessJwt } from "../../src/auth/access";

let priv: CryptoKey;
let jwks: string;

beforeAll(async () => {
  const pair = await generateKeyPair("RS256", { extractable: true });
  priv = pair.privateKey;
  const jwk = await exportJWK(pair.publicKey);
  jwks = JSON.stringify({ keys: [{ ...jwk, kid: "k1", alg: "RS256" }] });
  vi.stubGlobal("fetch", async (input: RequestInfo) =>
    String(input).includes("/cdn-cgi/access/certs")
      ? new Response(jwks, { headers: { "content-type": "application/json" } })
      : new Response("nope", { status: 404 })
  );
});

const testEnv = () => ({
  ...env,
  ACCESS_TEAM_DOMAIN: "acme.cloudflareaccess.com",
  ACCESS_AUD: "aud-123",
  ALLOWED_EMAILS: "thomas.stocker.pro@gmail.com",
  DEV_BYPASS_AUTH: undefined,
});

const token = async (over: { email?: string; aud?: string; exp?: string } = {}) =>
  new SignJWT({ email: over.email ?? "thomas.stocker.pro@gmail.com" })
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setIssuer("https://acme.cloudflareaccess.com")
    .setAudience(over.aud ?? "aud-123")
    .setIssuedAt()
    .setExpirationTime(over.exp ?? "1h")
    .sign(priv);

describe("verifyAccessJwt", () => {
  it("accepte un jeton valide et retourne l'email", async () => {
    const id = await verifyAccessJwt(testEnv(), await token());
    expect(id.email).toBe("thomas.stocker.pro@gmail.com");
  });

  it("refuse une audience incorrecte", async () => {
    await expect(verifyAccessJwt(testEnv(), await token({ aud: "autre" }))).rejects.toThrow();
  });

  it("refuse un jeton expiré", async () => {
    await expect(verifyAccessJwt(testEnv(), await token({ exp: "-1h" }))).rejects.toThrow();
  });

  it("refuse un email non autorisé", async () => {
    await expect(verifyAccessJwt(testEnv(), await token({ email: "intrus@example.com" }))).rejects.toThrow(
      /non autorisé/
    );
  });

  it("refuse un jeton bidon", async () => {
    await expect(verifyAccessJwt(testEnv(), "pas.un.jwt")).rejects.toThrow();
  });
});

describe("middleware", () => {
  it("répond 401 sans en-tête Access", async () => {
    const res = await SELF.fetch("https://example.com/api/identities");
    expect(res.status).toBe(401);
  });
});
```

- [ ] **Step 3: Lancer le test pour vérifier qu'il échoue**

Run: `pnpm vitest run test/auth/access.test.ts`
Expected: FAIL — module `src/auth/access` introuvable.

- [ ] **Step 4: Implémenter `src/auth/access.ts`**

```ts
import { createRemoteJWKSet, jwtVerify } from "jose";
import type { MiddlewareHandler } from "hono";
import type { Env } from "../env";

export type AccessIdentity = { email: string };

const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function jwksFor(teamDomain: string) {
  const url = `https://${teamDomain}/cdn-cgi/access/certs`;
  let set = jwksCache.get(url);
  if (!set) {
    set = createRemoteJWKSet(new URL(url), { cacheMaxAge: 3600_000 });
    jwksCache.set(url, set);
  }
  return set;
}

export async function verifyAccessJwt(env: Env, token: string): Promise<AccessIdentity> {
  const { payload } = await jwtVerify(token, jwksFor(env.ACCESS_TEAM_DOMAIN), {
    issuer: `https://${env.ACCESS_TEAM_DOMAIN}`,
    audience: env.ACCESS_AUD,
  });
  const email = String(payload.email ?? "").toLowerCase();
  const allowed = env.ALLOWED_EMAILS.split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
  if (!email || !allowed.includes(email)) {
    throw new Error(`email non autorisé : ${email || "(absent)"}`);
  }
  return { email };
}

export function requireAccess(): MiddlewareHandler<{
  Bindings: Env;
  Variables: { identity: AccessIdentity };
}> {
  return async (c, next) => {
    if (c.env.DEV_BYPASS_AUTH === "1") {
      c.set("identity", { email: "dev@localhost" });
      return next();
    }
    const token =
      c.req.header("Cf-Access-Jwt-Assertion") ??
      c.req.raw.headers.get("cookie")?.match(/CF_Authorization=([^;]+)/)?.[1];
    if (!token) return c.json({ error: { code: "unauthenticated", message: "Jeton Access absent" } }, 401);
    try {
      c.set("identity", await verifyAccessJwt(c.env, token));
    } catch (err) {
      return c.json(
        { error: { code: "unauthenticated", message: err instanceof Error ? err.message : "Jeton invalide" } },
        401
      );
    }
    return next();
  };
}
```

- [ ] **Step 5: Appliquer le middleware dans `src/index.ts`**

Insérer avant la définition des routes :

```ts
import { requireAccess } from "./auth/access";

app.use("/api/*", requireAccess());
```

Puis déplacer `/api/health` hors du préfixe protégé en le renommant `/healthz` (sonde publique, sans donnée).

- [ ] **Step 6: Lancer les tests**

Run: `pnpm vitest run`
Expected: toute la suite PASS. Mettre à jour `test/smoke.test.ts` pour interroger `/healthz`.

- [ ] **Step 7: Committer**

```bash
git add -A
git commit -m "feat: protège l'API par la vérification du JWT Cloudflare Access"
```

---

### Task 8: Lectures — threads, messages, identités

**Files:**
- Create: `src/db/queries.ts`, `src/api/routes.ts`, `test/api/read.test.ts`
- Modify: `src/index.ts`
- Test: `test/api/read.test.ts`

**Interfaces:**
- Consumes: schéma D1 (Task 2), `requireAccess` (Task 7)
- Produces:

```ts
export type ThreadSummary = {
  id: number; subject: string; snippet: string; lastMessageAt: number;
  messageCount: number; unreadCount: number; participants: string[]; hasAttachments: boolean;
};
export type MessageDetail = {
  id: number; messageId: string; direction: "in" | "out"; folder: string;
  from: { address: string; name: string | null };
  to: { address: string; name: string | null }[];
  cc: { address: string; name: string | null }[];
  subject: string; text: string; html: string | null;
  receivedAt: number; isRead: boolean; parseError: boolean;
  attachments: { id: number; filename: string; mimeType: string; size: number }[];
};
export type ThreadDetail = { id: number; subject: string; messages: MessageDetail[] };

export async function listThreads(
  db: D1Database,
  opts: { folder: string; q?: string; cursor?: string; limit?: number },
): Promise<{ threads: ThreadSummary[]; cursor: string | null }>;
export async function getThread(db: D1Database, id: number): Promise<ThreadDetail | null>;
export async function listIdentities(db: D1Database): Promise<{ address: string; displayName: string | null; isDefault: boolean }[]>;
```

Le curseur est la chaîne `"<last_message_at>:<thread_id>"` encodée en base64url.

- [ ] **Step 1: Écrire le test qui échoue**

```ts
// test/api/read.test.ts
import { env, applyD1Migrations } from "cloudflare:test";
import { readD1Migrations } from "@cloudflare/vitest-plugin/config";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { listThreads, getThread, listIdentities } from "../../src/db/queries";

beforeAll(async () => {
  await applyD1Migrations(env.DB, await readD1Migrations("./migrations"));
});

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM attachments"),
    env.DB.prepare("DELETE FROM recipients"),
    env.DB.prepare("DELETE FROM messages"),
    env.DB.prepare("DELETE FROM threads"),
    env.DB.prepare("DELETE FROM identities"),
  ]);
});

const insertThread = async (id: number, subject: string, at: number) =>
  env.DB.prepare(
    "INSERT INTO threads (id, subject_norm, last_message_at, message_count, unread_count) VALUES (?, ?, ?, 1, 1)"
  ).bind(id, subject, at).run();

const insertMessage = async (
  id: number, threadId: number, over: Partial<{ subject: string; text: string; from: string; folder: string; at: number }> = {}
) =>
  env.DB.prepare(
    `INSERT INTO messages (id, thread_id, message_id, direction, folder, from_addr, subject, text_body, snippet, received_at, raw_key)
     VALUES (?, ?, ?, 'in', ?, ?, ?, ?, ?, ?, 'raw/x.eml')`
  ).bind(
    id, threadId, `<m${id}@x>`, over.folder ?? "inbox", over.from ?? "zoe@example.com",
    over.subject ?? "Facture", over.text ?? "corps du message", (over.text ?? "corps du message").slice(0, 200),
    over.at ?? 1757318400
  ).run();

describe("listThreads", () => {
  it("retourne les threads du dossier, du plus récent au plus ancien", async () => {
    await insertThread(1, "a", 100);
    await insertMessage(1, 1, { at: 100 });
    await insertThread(2, "b", 200);
    await insertMessage(2, 2, { at: 200 });

    const { threads } = await listThreads(env.DB, { folder: "inbox" });
    expect(threads.map((t) => t.id)).toEqual([2, 1]);
    expect(threads[0].unreadCount).toBe(1);
  });

  it("exclut les threads dont aucun message n'est dans le dossier", async () => {
    await insertThread(3, "c", 300);
    await insertMessage(3, 3, { folder: "trash" });
    const { threads } = await listThreads(env.DB, { folder: "inbox" });
    expect(threads).toHaveLength(0);
  });

  it("pagine par curseur", async () => {
    for (let i = 1; i <= 3; i++) {
      await insertThread(i, `t${i}`, i * 100);
      await insertMessage(i, i, { at: i * 100 });
    }
    const first = await listThreads(env.DB, { folder: "inbox", limit: 2 });
    expect(first.threads.map((t) => t.id)).toEqual([3, 2]);
    expect(first.cursor).not.toBeNull();
    const second = await listThreads(env.DB, { folder: "inbox", limit: 2, cursor: first.cursor! });
    expect(second.threads.map((t) => t.id)).toEqual([1]);
    expect(second.cursor).toBeNull();
  });

  it("filtre par recherche plein texte sans tenir compte des accents", async () => {
    await insertThread(1, "a", 100);
    await insertMessage(1, 1, { subject: "Réunion budget", text: "on parle du budget" });
    await insertThread(2, "b", 200);
    await insertMessage(2, 2, { subject: "Autre chose", text: "sans rapport" });

    const { threads } = await listThreads(env.DB, { folder: "inbox", q: "reunion" });
    expect(threads.map((t) => t.id)).toEqual([1]);
  });

  it("ne plante pas sur une requête contenant des caractères FTS spéciaux", async () => {
    await insertThread(1, "a", 100);
    await insertMessage(1, 1);
    await expect(listThreads(env.DB, { folder: "inbox", q: 'a" OR b*' })).resolves.toBeDefined();
  });
});

describe("getThread", () => {
  it("retourne les messages avec destinataires et pièces jointes", async () => {
    await insertThread(1, "facture", 100);
    await insertMessage(1, 1, { subject: "Facture" });
    await env.DB.prepare("INSERT INTO recipients (message_id, kind, address, name) VALUES (1, 'to', 'thomas@planigramme.fr', 'Thomas')").run();
    await env.DB.prepare("INSERT INTO attachments (id, message_id, filename, mime_type, size, r2_key) VALUES (1, 1, 'f.pdf', 'application/pdf', 42, 'att/x/0-f.pdf')").run();

    const t = await getThread(env.DB, 1);
    expect(t?.subject).toBe("Facture");
    expect(t?.messages[0].to).toEqual([{ address: "thomas@planigramme.fr", name: "Thomas" }]);
    expect(t?.messages[0].attachments).toEqual([{ id: 1, filename: "f.pdf", mimeType: "application/pdf", size: 42 }]);
  });

  it("retourne null pour un thread inexistant", async () => {
    expect(await getThread(env.DB, 999)).toBeNull();
  });
});

describe("listIdentities", () => {
  it("retourne l'identité par défaut en premier", async () => {
    await env.DB.prepare("INSERT INTO identities (address, display_name, is_default) VALUES ('b@planigramme.fr', 'B', 0), ('a@planigramme.fr', 'A', 1)").run();
    const ids = await listIdentities(env.DB);
    expect(ids[0]).toEqual({ address: "a@planigramme.fr", displayName: "A", isDefault: true });
  });
});
```

- [ ] **Step 2: Lancer le test pour vérifier qu'il échoue**

Run: `pnpm vitest run test/api/read.test.ts`
Expected: FAIL — module `src/db/queries` introuvable.

- [ ] **Step 3: Implémenter `src/db/queries.ts`**

```ts
export type ThreadSummary = {
  id: number; subject: string; snippet: string; lastMessageAt: number;
  messageCount: number; unreadCount: number; participants: string[]; hasAttachments: boolean;
};
export type MessageDetail = {
  id: number; messageId: string; direction: "in" | "out"; folder: string;
  from: { address: string; name: string | null };
  to: { address: string; name: string | null }[];
  cc: { address: string; name: string | null }[];
  subject: string; text: string; html: string | null;
  receivedAt: number; isRead: boolean; parseError: boolean;
  attachments: { id: number; filename: string; mimeType: string; size: number }[];
};
export type ThreadDetail = { id: number; subject: string; messages: MessageDetail[] };

const encodeCursor = (at: number, id: number) => btoa(`${at}:${id}`).replace(/=+$/, "");
const decodeCursor = (c: string): [number, number] => {
  const [at, id] = atob(c).split(":");
  return [Number(at), Number(id)];
};

// FTS5 interprète guillemets, astérisques et opérateurs : on cite chaque terme.
const ftsQuery = (q: string): string =>
  q.split(/\s+/).filter(Boolean).map((t) => `"${t.replace(/"/g, "")}"`).join(" ");

export async function listThreads(
  db: D1Database,
  opts: { folder: string; q?: string; cursor?: string; limit?: number },
): Promise<{ threads: ThreadSummary[]; cursor: string | null }> {
  const limit = Math.min(opts.limit ?? 30, 100);
  const params: unknown[] = [opts.folder];
  let where = `EXISTS (SELECT 1 FROM messages m WHERE m.thread_id = t.id AND m.folder = ?)`;

  if (opts.q && opts.q.trim()) {
    where += ` AND EXISTS (
      SELECT 1 FROM messages_fts f JOIN messages m2 ON m2.id = f.rowid
      WHERE m2.thread_id = t.id AND m2.folder = ? AND messages_fts MATCH ?
    )`;
    params.push(opts.folder, ftsQuery(opts.q));
  }

  if (opts.cursor) {
    const [at, id] = decodeCursor(opts.cursor);
    where += ` AND (t.last_message_at < ? OR (t.last_message_at = ? AND t.id < ?))`;
    params.push(at, at, id);
  }

  const rows = await db.prepare(
    `SELECT t.id, t.last_message_at, t.message_count, t.unread_count,
            (SELECT subject FROM messages WHERE thread_id = t.id ORDER BY received_at DESC LIMIT 1) AS subject,
            (SELECT snippet FROM messages WHERE thread_id = t.id ORDER BY received_at DESC LIMIT 1) AS snippet,
            (SELECT GROUP_CONCAT(DISTINCT from_addr) FROM messages WHERE thread_id = t.id) AS participants,
            (SELECT MAX(has_attachments) FROM messages WHERE thread_id = t.id) AS has_attachments
     FROM threads t
     WHERE ${where}
     ORDER BY t.last_message_at DESC, t.id DESC
     LIMIT ?`
  ).bind(...params, limit + 1).all<Record<string, never>>();

  const all = rows.results as unknown as {
    id: number; last_message_at: number; message_count: number; unread_count: number;
    subject: string | null; snippet: string | null; participants: string | null; has_attachments: number | null;
  }[];
  const page = all.slice(0, limit);
  const last = page[page.length - 1];

  return {
    threads: page.map((r) => ({
      id: r.id,
      subject: r.subject ?? "(sans objet)",
      snippet: r.snippet ?? "",
      lastMessageAt: r.last_message_at,
      messageCount: r.message_count,
      unreadCount: r.unread_count,
      participants: (r.participants ?? "").split(",").filter(Boolean),
      hasAttachments: Boolean(r.has_attachments),
    })),
    cursor: all.length > limit && last ? encodeCursor(last.last_message_at, last.id) : null,
  };
}

export async function getThread(db: D1Database, id: number): Promise<ThreadDetail | null> {
  const messages = await db.prepare(
    `SELECT id, message_id, direction, folder, from_addr, from_name, subject, text_body, html_body,
            received_at, is_read, parse_error
     FROM messages WHERE thread_id = ? ORDER BY received_at ASC`
  ).bind(id).all<{
    id: number; message_id: string; direction: "in" | "out"; folder: string;
    from_addr: string; from_name: string | null; subject: string | null;
    text_body: string | null; html_body: string | null;
    received_at: number; is_read: number; parse_error: number;
  }>();
  if (messages.results.length === 0) return null;

  const ids = messages.results.map((m) => m.id);
  const placeholders = ids.map(() => "?").join(",");
  const recipients = await db.prepare(
    `SELECT message_id, kind, address, name FROM recipients WHERE message_id IN (${placeholders})`
  ).bind(...ids).all<{ message_id: number; kind: string; address: string; name: string | null }>();
  const attachments = await db.prepare(
    `SELECT id, message_id, filename, mime_type, size FROM attachments WHERE message_id IN (${placeholders})`
  ).bind(...ids).all<{ id: number; message_id: number; filename: string; mime_type: string; size: number }>();

  return {
    id,
    subject: messages.results[messages.results.length - 1].subject ?? "(sans objet)",
    messages: messages.results.map((m) => ({
      id: m.id,
      messageId: m.message_id,
      direction: m.direction,
      folder: m.folder,
      from: { address: m.from_addr, name: m.from_name },
      to: recipients.results.filter((r) => r.message_id === m.id && r.kind === "to")
        .map((r) => ({ address: r.address, name: r.name })),
      cc: recipients.results.filter((r) => r.message_id === m.id && r.kind === "cc")
        .map((r) => ({ address: r.address, name: r.name })),
      subject: m.subject ?? "",
      text: m.text_body ?? "",
      html: m.html_body,
      receivedAt: m.received_at,
      isRead: Boolean(m.is_read),
      parseError: Boolean(m.parse_error),
      attachments: attachments.results.filter((a) => a.message_id === m.id)
        .map((a) => ({ id: a.id, filename: a.filename, mimeType: a.mime_type, size: a.size })),
    })),
  };
}

export async function listIdentities(db: D1Database) {
  const rows = await db.prepare(
    "SELECT address, display_name, is_default FROM identities ORDER BY is_default DESC, address ASC"
  ).all<{ address: string; display_name: string | null; is_default: number }>();
  return rows.results.map((r) => ({
    address: r.address,
    displayName: r.display_name,
    isDefault: Boolean(r.is_default),
  }));
}
```

- [ ] **Step 4: Implémenter les routes de lecture dans `src/api/routes.ts`**

```ts
import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../env";
import type { AccessIdentity } from "../auth/access";
import { getThread, listIdentities, listThreads } from "../db/queries";

export type ApiEnv = { Bindings: Env; Variables: { identity: AccessIdentity } };

const listQuery = z.object({
  folder: z.enum(["inbox", "sent", "trash"]).default("inbox"),
  q: z.string().max(200).optional(),
  cursor: z.string().max(200).optional(),
});

export const api = new Hono<ApiEnv>();

api.get("/threads", async (c) => {
  const parsed = listQuery.safeParse(c.req.query());
  if (!parsed.success) {
    return c.json({ error: { code: "invalid_query", message: parsed.error.message } }, 400);
  }
  return c.json(await listThreads(c.env.DB, parsed.data));
});

api.get("/threads/:id", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id)) return c.json({ error: { code: "invalid_id", message: "Identifiant invalide" } }, 400);
  const thread = await getThread(c.env.DB, id);
  if (!thread) return c.json({ error: { code: "not_found", message: "Thread introuvable" } }, 404);
  return c.json(thread);
});

api.get("/identities", async (c) => c.json(await listIdentities(c.env.DB)));
```

- [ ] **Step 5: Monter le routeur dans `src/index.ts`**

```ts
import { api } from "./api/routes";

app.route("/api", api);
```

- [ ] **Step 6: Lancer les tests**

Run: `pnpm vitest run`
Expected: toute la suite PASS.

- [ ] **Step 7: Committer**

```bash
git add -A
git commit -m "feat: expose les lectures de threads, messages et identités"
```

---

### Task 9: Mutations — lu/non-lu, dossier, purge

**Files:**
- Create: `src/db/mutations.ts`, `test/api/mutations.test.ts`
- Modify: `src/api/routes.ts`
- Test: `test/api/mutations.test.ts`

**Interfaces:**
- Consumes: schéma D1 (Task 2), `ApiEnv` (Task 8)
- Produces:

```ts
export async function setRead(db: D1Database, messageId: number, isRead: boolean): Promise<boolean>;
export async function moveToFolder(db: D1Database, messageId: number, folder: "inbox" | "trash"): Promise<boolean>;
export async function purgeMessage(env: Env, messageId: number): Promise<boolean>;
```
Routes ajoutées : `PATCH /api/messages/:id`, `DELETE /api/messages/:id`.

- [ ] **Step 1: Écrire le test qui échoue**

```ts
// test/api/mutations.test.ts
import { env, applyD1Migrations } from "cloudflare:test";
import { readD1Migrations } from "@cloudflare/vitest-plugin/config";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { setRead, moveToFolder, purgeMessage } from "../../src/db/mutations";

beforeAll(async () => {
  await applyD1Migrations(env.DB, await readD1Migrations("./migrations"));
});

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM attachments"),
    env.DB.prepare("DELETE FROM messages"),
    env.DB.prepare("DELETE FROM threads"),
  ]);
  await env.DB.prepare(
    "INSERT INTO threads (id, subject_norm, last_message_at, message_count, unread_count) VALUES (1, 'x', 100, 2, 2)"
  ).run();
  for (const id of [1, 2]) {
    await env.DB.prepare(
      `INSERT INTO messages (id, thread_id, message_id, direction, folder, from_addr, subject, received_at, raw_key)
       VALUES (?, 1, ?, 'in', 'inbox', 'a@b.c', 'x', 100, ?)`
    ).bind(id, `<m${id}@x>`, `raw/m${id}.eml`).run();
  }
});

describe("setRead", () => {
  it("marque lu et décrémente le compteur du thread", async () => {
    expect(await setRead(env.DB, 1, true)).toBe(true);
    const t = await env.DB.prepare("SELECT unread_count FROM threads WHERE id = 1").first<{ unread_count: number }>();
    expect(t?.unread_count).toBe(1);
  });

  it("est idempotent", async () => {
    await setRead(env.DB, 1, true);
    await setRead(env.DB, 1, true);
    const t = await env.DB.prepare("SELECT unread_count FROM threads WHERE id = 1").first<{ unread_count: number }>();
    expect(t?.unread_count).toBe(1);
  });

  it("remet non-lu et réincrémente", async () => {
    await setRead(env.DB, 1, true);
    await setRead(env.DB, 1, false);
    const t = await env.DB.prepare("SELECT unread_count FROM threads WHERE id = 1").first<{ unread_count: number }>();
    expect(t?.unread_count).toBe(2);
  });

  it("retourne false pour un message inexistant", async () => {
    expect(await setRead(env.DB, 999, true)).toBe(false);
  });
});

describe("moveToFolder", () => {
  it("met un message à la corbeille et ajuste les compteurs", async () => {
    expect(await moveToFolder(env.DB, 1, "trash")).toBe(true);
    const t = await env.DB.prepare("SELECT message_count, unread_count FROM threads WHERE id = 1")
      .first<{ message_count: number; unread_count: number }>();
    expect(t).toMatchObject({ message_count: 1, unread_count: 1 });
  });
});

describe("purgeMessage", () => {
  it("supprime la ligne D1 et les objets R2", async () => {
    await env.MAIL.put("raw/m1.eml", "brut");
    await env.MAIL.put("att/m1/0-f.pdf", "pdf");
    await env.DB.prepare(
      "INSERT INTO attachments (message_id, filename, mime_type, size, r2_key) VALUES (1, 'f.pdf', 'application/pdf', 3, 'att/m1/0-f.pdf')"
    ).run();

    expect(await purgeMessage(env, 1)).toBe(true);
    expect(await env.DB.prepare("SELECT id FROM messages WHERE id = 1").first()).toBeNull();
    expect(await env.MAIL.get("raw/m1.eml")).toBeNull();
    expect(await env.MAIL.get("att/m1/0-f.pdf")).toBeNull();
  });

  it("supprime le thread devenu vide", async () => {
    await purgeMessage(env, 1);
    await purgeMessage(env, 2);
    expect(await env.DB.prepare("SELECT id FROM threads WHERE id = 1").first()).toBeNull();
  });
});
```

- [ ] **Step 2: Lancer le test pour vérifier qu'il échoue**

Run: `pnpm vitest run test/api/mutations.test.ts`
Expected: FAIL — module `src/db/mutations` introuvable.

- [ ] **Step 3: Implémenter `src/db/mutations.ts`**

```ts
import type { Env } from "../env";

export async function setRead(db: D1Database, messageId: number, isRead: boolean): Promise<boolean> {
  const row = await db
    .prepare("SELECT thread_id, is_read FROM messages WHERE id = ?")
    .bind(messageId)
    .first<{ thread_id: number; is_read: number }>();
  if (!row) return false;
  if (Boolean(row.is_read) === isRead) return true;

  await db.batch([
    db.prepare("UPDATE messages SET is_read = ? WHERE id = ?").bind(isRead ? 1 : 0, messageId),
    db.prepare(
      `UPDATE threads SET unread_count = MAX(0, unread_count + ?) WHERE id = ?`
    ).bind(isRead ? -1 : 1, row.thread_id),
  ]);
  return true;
}

export async function moveToFolder(
  db: D1Database,
  messageId: number,
  folder: "inbox" | "trash",
): Promise<boolean> {
  const row = await db
    .prepare("SELECT thread_id, folder, is_read FROM messages WHERE id = ?")
    .bind(messageId)
    .first<{ thread_id: number; folder: string; is_read: number }>();
  if (!row) return false;
  if (row.folder === folder) return true;

  const goingToTrash = folder === "trash";
  const delta = goingToTrash ? -1 : 1;
  const unreadDelta = row.is_read ? 0 : delta;

  await db.batch([
    db.prepare("UPDATE messages SET folder = ? WHERE id = ?").bind(folder, messageId),
    db.prepare(
      `UPDATE threads
          SET message_count = MAX(0, message_count + ?),
              unread_count = MAX(0, unread_count + ?)
        WHERE id = ?`
    ).bind(delta, unreadDelta, row.thread_id),
  ]);
  return true;
}

export async function purgeMessage(env: Env, messageId: number): Promise<boolean> {
  const row = await env.DB
    .prepare("SELECT thread_id, raw_key FROM messages WHERE id = ?")
    .bind(messageId)
    .first<{ thread_id: number; raw_key: string }>();
  if (!row) return false;

  const atts = await env.DB
    .prepare("SELECT r2_key FROM attachments WHERE message_id = ?")
    .bind(messageId)
    .all<{ r2_key: string }>();

  await env.MAIL.delete([row.raw_key, ...atts.results.map((a) => a.r2_key)]);
  await env.DB.prepare("DELETE FROM messages WHERE id = ?").bind(messageId).run();

  const remaining = await env.DB
    .prepare("SELECT COUNT(*) AS n FROM messages WHERE thread_id = ?")
    .bind(row.thread_id)
    .first<{ n: number }>();
  if ((remaining?.n ?? 0) === 0) {
    await env.DB.prepare("DELETE FROM threads WHERE id = ?").bind(row.thread_id).run();
  }
  return true;
}
```

- [ ] **Step 4: Ajouter les routes dans `src/api/routes.ts`**

```ts
import { moveToFolder, purgeMessage, setRead } from "../db/mutations";

const patchBody = z.object({
  isRead: z.boolean().optional(),
  folder: z.enum(["inbox", "trash"]).optional(),
}).refine((b) => b.isRead !== undefined || b.folder !== undefined, {
  message: "Fournir isRead ou folder",
});

api.patch("/messages/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const parsed = patchBody.safeParse(await c.req.json().catch(() => ({})));
  if (!Number.isInteger(id) || !parsed.success) {
    return c.json({ error: { code: "invalid_body", message: "Requête invalide" } }, 400);
  }
  let ok = true;
  if (parsed.data.isRead !== undefined) ok = await setRead(c.env.DB, id, parsed.data.isRead);
  if (ok && parsed.data.folder !== undefined) ok = await moveToFolder(c.env.DB, id, parsed.data.folder);
  if (!ok) return c.json({ error: { code: "not_found", message: "Message introuvable" } }, 404);
  return c.json({ ok: true });
});

api.delete("/messages/:id", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id)) return c.json({ error: { code: "invalid_id", message: "Identifiant invalide" } }, 400);
  const ok = await purgeMessage(c.env, id);
  if (!ok) return c.json({ error: { code: "not_found", message: "Message introuvable" } }, 404);
  return c.json({ ok: true });
});
```

- [ ] **Step 5: Lancer les tests**

Run: `pnpm vitest run`
Expected: toute la suite PASS.

- [ ] **Step 6: Committer**

```bash
git add -A
git commit -m "feat: ajoute les mutations lu/non-lu, corbeille et purge"
```

---

### Task 10: Assainissement du HTML des emails

**Files:**
- Create: `src/html/sanitize.ts`, `test/html/sanitize.test.ts`
- Modify: `src/api/routes.ts`
- Test: `test/html/sanitize.test.ts`

**Interfaces:**
- Consumes: `HTMLRewriter` (runtime Workers)
- Produces:

```ts
export type SanitizeOptions = {
  cidMap: Record<string, number>;   // contentId → id de pièce jointe
  blockRemoteImages: boolean;
};
export type SanitizeResult = { html: string; hasRemoteImages: boolean };
export async function sanitizeHtml(html: string, opts: SanitizeOptions): Promise<SanitizeResult>;
```
Route ajoutée : `GET /api/messages/:id/body?images=blocked|allowed` retournant `{ html, hasRemoteImages }`.

- [ ] **Step 1: Écrire le test qui échoue**

```ts
// test/html/sanitize.test.ts
import { describe, expect, it } from "vitest";
import { sanitizeHtml } from "../../src/html/sanitize";

const clean = (html: string, cidMap: Record<string, number> = {}) =>
  sanitizeHtml(html, { cidMap, blockRemoteImages: true });

describe("sanitizeHtml", () => {
  it("supprime les balises script", async () => {
    const { html } = await clean(`<p>ok</p><script>alert(1)</script>`);
    expect(html).not.toContain("alert");
    expect(html).not.toContain("<script");
    expect(html).toContain("<p>ok</p>");
  });

  it("supprime les balises style", async () => {
    const { html } = await clean(`<style>body{display:none}</style><p>ok</p>`);
    expect(html).not.toContain("display:none");
  });

  it("supprime les gestionnaires d'événements", async () => {
    const { html } = await clean(`<img src="https://x/y.png" onerror="alert(1)">`);
    expect(html).not.toContain("onerror");
  });

  it("neutralise les URL javascript:", async () => {
    const { html } = await clean(`<a href="javascript:alert(1)">clic</a>`);
    expect(html).not.toContain("javascript:");
    expect(html).toContain("clic");
  });

  it("neutralise une charge XSS dans un SVG", async () => {
    const { html } = await clean(`<svg><script>alert(1)</script></svg>`);
    expect(html).not.toContain("alert");
  });

  it("supprime les iframes et objets", async () => {
    const { html } = await clean(`<iframe src="https://evil"></iframe><object data="x"></object>`);
    expect(html).not.toContain("<iframe");
    expect(html).not.toContain("<object");
  });

  it("bloque les images distantes et le signale", async () => {
    const { html, hasRemoteImages } = await clean(`<img src="https://tracker/pixel.gif">`);
    expect(hasRemoteImages).toBe(true);
    expect(html).not.toContain("https://tracker");
    expect(html).toContain("data-blocked-src=\"https://tracker/pixel.gif\"");
  });

  it("laisse passer les images distantes quand elles sont autorisées", async () => {
    const { html } = await sanitizeHtml(`<img src="https://ok/a.png">`, { cidMap: {}, blockRemoteImages: false });
    expect(html).toContain('src="https://ok/a.png"');
  });

  it("réécrit les images cid: vers l'API des pièces jointes", async () => {
    const { html, hasRemoteImages } = await clean(`<img src="cid:logo123">`, { logo123: 42 });
    expect(html).toContain('src="/api/attachments/42"');
    expect(hasRemoteImages).toBe(false);
  });

  it("force target et rel sur les liens", async () => {
    const { html } = await clean(`<a href="https://exemple.fr">lien</a>`);
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it("supprime les balises inconnues en gardant leur texte", async () => {
    const { html } = await clean(`<blink>texte</blink>`);
    expect(html).not.toContain("<blink");
    expect(html).toContain("texte");
  });
});
```

- [ ] **Step 2: Lancer le test pour vérifier qu'il échoue**

Run: `pnpm vitest run test/html/sanitize.test.ts`
Expected: FAIL — module `src/html/sanitize` introuvable.

- [ ] **Step 3: Implémenter `src/html/sanitize.ts`**

```ts
export type SanitizeOptions = { cidMap: Record<string, number>; blockRemoteImages: boolean };
export type SanitizeResult = { html: string; hasRemoteImages: boolean };

const ALLOWED_TAGS = new Set([
  "a", "b", "blockquote", "br", "code", "div", "em", "h1", "h2", "h3", "h4", "h5", "h6",
  "hr", "i", "img", "li", "ol", "p", "pre", "s", "small", "span", "strong", "sub", "sup",
  "table", "tbody", "td", "tfoot", "th", "thead", "tr", "u", "ul",
]);
const DROP_WITH_CONTENT = new Set(["script", "style", "iframe", "object", "embed", "form", "svg", "math", "link", "meta", "base"]);
const ALLOWED_ATTRS = new Set(["href", "src", "alt", "title", "width", "height", "colspan", "rowspan"]);
const SAFE_URL = /^(https?:|mailto:|cid:)/i;

export async function sanitizeHtml(html: string, opts: SanitizeOptions): Promise<SanitizeResult> {
  let hasRemoteImages = false;

  const rewriter = new HTMLRewriter()
    .on("*", {
      element(el) {
        const tag = el.tagName.toLowerCase();

        if (DROP_WITH_CONTENT.has(tag)) {
          el.remove();
          return;
        }
        if (!ALLOWED_TAGS.has(tag)) {
          el.removeAndKeepContent();
          return;
        }

        for (const [name, value] of [...el.attributes]) {
          const lower = name.toLowerCase();
          if (lower.startsWith("on") || !ALLOWED_ATTRS.has(lower)) {
            el.removeAttribute(name);
            continue;
          }
          if ((lower === "href" || lower === "src") && !SAFE_URL.test(value.trim())) {
            el.removeAttribute(name);
          }
        }

        if (tag === "a") {
          if (el.getAttribute("href")) {
            el.setAttribute("target", "_blank");
            el.setAttribute("rel", "noopener noreferrer");
          }
        }

        if (tag === "img") {
          const src = el.getAttribute("src");
          if (!src) return;
          if (src.toLowerCase().startsWith("cid:")) {
            const id = opts.cidMap[src.slice(4)];
            if (id === undefined) el.remove();
            else el.setAttribute("src", `/api/attachments/${id}`);
            return;
          }
          hasRemoteImages = true;
          if (opts.blockRemoteImages) {
            el.removeAttribute("src");
            el.setAttribute("data-blocked-src", src);
          }
        }
      },
    });

  const out = await rewriter.transform(new Response(html)).text();
  return { html: out, hasRemoteImages };
}
```

- [ ] **Step 4: Ajouter la route de corps assaini dans `src/api/routes.ts`**

```ts
import { sanitizeHtml } from "../html/sanitize";

api.get("/messages/:id/body", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id)) return c.json({ error: { code: "invalid_id", message: "Identifiant invalide" } }, 400);

  const msg = await c.env.DB.prepare("SELECT html_body, text_body FROM messages WHERE id = ?")
    .bind(id).first<{ html_body: string | null; text_body: string | null }>();
  if (!msg) return c.json({ error: { code: "not_found", message: "Message introuvable" } }, 404);
  if (!msg.html_body) return c.json({ html: null, text: msg.text_body ?? "", hasRemoteImages: false });

  const atts = await c.env.DB.prepare(
    "SELECT id, content_id FROM attachments WHERE message_id = ? AND content_id IS NOT NULL"
  ).bind(id).all<{ id: number; content_id: string }>();
  const cidMap = Object.fromEntries(atts.results.map((a) => [a.content_id, a.id]));

  const result = await sanitizeHtml(msg.html_body, {
    cidMap,
    blockRemoteImages: c.req.query("images") !== "allowed",
  });
  return c.json({ html: result.html, text: msg.text_body ?? "", hasRemoteImages: result.hasRemoteImages });
});
```

- [ ] **Step 5: Lancer les tests**

Run: `pnpm vitest run`
Expected: toute la suite PASS.

- [ ] **Step 6: Committer**

```bash
git add -A
git commit -m "feat: assainit le HTML des emails et bloque les images distantes"
```

---

### Task 11: Service des pièces jointes et du MIME brut

**Files:**
- Modify: `src/api/routes.ts`
- Create: `test/api/attachments.test.ts`
- Test: `test/api/attachments.test.ts`

**Interfaces:**
- Consumes: schéma D1 (Task 2), binding `MAIL`
- Produces: `GET /api/attachments/:id` et `GET /api/messages/:id/raw`.

- [ ] **Step 1: Écrire le test qui échoue**

```ts
// test/api/attachments.test.ts
import { env, applyD1Migrations } from "cloudflare:test";
import { readD1Migrations } from "@cloudflare/vitest-plugin/config";
import { beforeAll, describe, expect, it } from "vitest";
import { app } from "../../src/index";

beforeAll(async () => {
  await applyD1Migrations(env.DB, await readD1Migrations("./migrations"));
  await env.DB.prepare("INSERT OR IGNORE INTO threads (id, subject_norm, last_message_at) VALUES (1, 'x', 1)").run();
  await env.DB.prepare(
    `INSERT OR IGNORE INTO messages (id, thread_id, message_id, direction, folder, from_addr, received_at, raw_key)
     VALUES (1, 1, '<att@x>', 'in', 'inbox', 'a@b.c', 1, 'raw/att.eml')`
  ).run();
  await env.DB.prepare(
    `INSERT OR IGNORE INTO attachments (id, message_id, filename, mime_type, size, r2_key)
     VALUES (1, 1, 'rapport final.pdf', 'application/pdf', 5, 'att/att/0-rapport.pdf')`
  ).run();
  await env.MAIL.put("att/att/0-rapport.pdf", "%PDF%");
  await env.MAIL.put("raw/att.eml", "From: a@b.c\r\n\r\nbonjour");
});

// DEV_BYPASS_AUTH n'est jamais activé globalement (cf. le test 401 de la Task 7) :
// on injecte l'env directement dans l'app Hono.
const testEnv = () => ({ ...env, DEV_BYPASS_AUTH: "1" });
const authed = (path: string) => app.request(`https://example.com${path}`, {}, testEnv());

describe("GET /api/attachments/:id", () => {
  it("retourne le contenu avec un nom de fichier échappé", async () => {
    const res = await authed("/api/attachments/1");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("%PDF%");
    expect(res.headers.get("content-disposition")).toContain('filename="rapport final.pdf"');
  });

  it("force un type MIME sûr pour le HTML", async () => {
    await env.DB.prepare("UPDATE attachments SET mime_type = 'text/html' WHERE id = 1").run();
    const res = await authed("/api/attachments/1");
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    await env.DB.prepare("UPDATE attachments SET mime_type = 'application/pdf' WHERE id = 1").run();
  });

  it("retourne 404 pour une pièce jointe inconnue", async () => {
    expect((await authed("/api/attachments/999")).status).toBe(404);
  });
});

describe("GET /api/messages/:id/raw", () => {
  it("retourne le .eml d'origine", async () => {
    const res = await authed("/api/messages/1/raw");
    expect(res.headers.get("content-type")).toContain("message/rfc822");
    expect(await res.text()).toContain("bonjour");
  });
});
```

Note : `DEV_BYPASS_AUTH` n'est jamais activé globalement — le test 401 de la Task 7 en dépend. Les tests d'intégration passent l'env explicitement via `app.request(url, init, env)`. Ne jamais définir cette variable dans le `wrangler.jsonc` de production.

- [ ] **Step 2: Lancer le test pour vérifier qu'il échoue**

Run: `pnpm vitest run test/api/attachments.test.ts`
Expected: FAIL — 404 sur `/api/attachments/1`.

- [ ] **Step 3: Implémenter les routes**

```ts
// dans src/api/routes.ts
const SAFE_INLINE_TYPES = new Set([
  "application/pdf", "image/png", "image/jpeg", "image/gif", "image/webp", "text/plain",
]);

api.get("/attachments/:id", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id)) return c.json({ error: { code: "invalid_id", message: "Identifiant invalide" } }, 400);

  const att = await c.env.DB.prepare(
    "SELECT filename, mime_type, r2_key FROM attachments WHERE id = ?"
  ).bind(id).first<{ filename: string; mime_type: string; r2_key: string }>();
  if (!att) return c.json({ error: { code: "not_found", message: "Pièce jointe introuvable" } }, 404);

  const obj = await c.env.MAIL.get(att.r2_key);
  if (!obj) return c.json({ error: { code: "not_found", message: "Contenu introuvable" } }, 404);

  const type = SAFE_INLINE_TYPES.has(att.mime_type) ? att.mime_type : "application/octet-stream";
  const name = (att.filename || "fichier").replace(/["\\\r\n]/g, "_");
  return new Response(obj.body, {
    headers: {
      "content-type": type,
      "content-disposition": `attachment; filename="${name}"; filename*=UTF-8''${encodeURIComponent(att.filename)}`,
      "content-security-policy": "default-src 'none'; sandbox",
      "x-content-type-options": "nosniff",
    },
  });
});

api.get("/messages/:id/raw", async (c) => {
  const id = Number(c.req.param("id"));
  const msg = await c.env.DB.prepare("SELECT raw_key FROM messages WHERE id = ?")
    .bind(id).first<{ raw_key: string }>();
  if (!msg) return c.json({ error: { code: "not_found", message: "Message introuvable" } }, 404);
  const obj = await c.env.MAIL.get(msg.raw_key);
  if (!obj) return c.json({ error: { code: "not_found", message: "MIME brut introuvable" } }, 404);
  return new Response(obj.body, {
    headers: {
      "content-type": "message/rfc822",
      "content-disposition": `attachment; filename="message-${id}.eml"`,
    },
  });
});
```

- [ ] **Step 4: Lancer les tests**

Run: `pnpm vitest run`
Expected: toute la suite PASS.

- [ ] **Step 5: Committer**

```bash
git add -A
git commit -m "feat: sert les pièces jointes et le MIME brut depuis R2"
```

---

### Task 12: Envoi d'emails

**Files:**
- Create: `src/send/client.ts`, `test/send/client.test.ts`, `test/api/send.test.ts`
- Modify: `src/api/routes.ts`, `src/db/mutations.ts`
- Test: `test/send/client.test.ts`, `test/api/send.test.ts`

**Interfaces:**
- Consumes: `Env` (Task 1), `resolveThread` (Task 4), schéma D1 (Task 2)
- Produces:

```ts
export type SendRequest = {
  from: string;
  to: string[];
  cc?: string[];
  subject: string;
  text: string;
  html?: string;
  replyTo?: string;
  inReplyTo?: string;      // Message-ID auquel on répond
  references?: string[];
  attachments?: { filename: string; mimeType: string; contentBase64: string }[];
};
export type SendResult = { delivered: string[]; queued: string[]; permanentBounces: string[] };
export class SendError extends Error { constructor(message: string, readonly status: number) }
export async function sendEmail(env: Env, req: SendRequest): Promise<SendResult>;
export function payloadSize(req: SendRequest): number;   // octets, base64 compris
export async function storeOutgoing(env: Env, req: SendRequest, messageId: string): Promise<number>;
```
Route ajoutée : `POST /api/messages`.

- [ ] **Step 1: Écrire le test du client qui échoue**

```ts
// test/send/client.test.ts
import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sendEmail, payloadSize, SendError, type SendRequest } from "../../src/send/client";

const base: SendRequest = {
  from: "thomas@planigramme.fr",
  to: ["zoe@example.com"],
  subject: "Bonjour",
  text: "Salut",
};

const testEnv = () => ({ ...env, CF_ACCOUNT_ID: "acc123", CF_API_TOKEN: "tok" });

afterEach(() => vi.unstubAllGlobals());

describe("sendEmail", () => {
  it("appelle le bon endpoint avec le bon en-tête d'autorisation", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return Response.json({ result: { delivered: ["zoe@example.com"], queued: [], permanent_bounces: [] }, success: true });
    });

    const res = await sendEmail(testEnv(), base);
    expect(calls[0].url).toBe("https://api.cloudflare.com/client/v4/accounts/acc123/email/sending/send");
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe("Bearer tok");
    expect(JSON.parse(calls[0].init.body as string)).toMatchObject({
      from: "thomas@planigramme.fr",
      to: ["zoe@example.com"],
      subject: "Bonjour",
      text: "Salut",
    });
    expect(res).toEqual({ delivered: ["zoe@example.com"], queued: [], permanentBounces: [] });
  });

  it("ajoute les en-têtes de threading sur une réponse", async () => {
    let body: Record<string, unknown> = {};
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      body = JSON.parse(init.body as string);
      return Response.json({ result: { delivered: [], queued: [], permanent_bounces: [] }, success: true });
    });

    await sendEmail(testEnv(), { ...base, inReplyTo: "<parent@x>", references: ["<a@x>", "<parent@x>"] });
    expect(body.headers).toEqual({
      "In-Reply-To": "<parent@x>",
      References: "<a@x> <parent@x>",
    });
  });

  it("lève une SendError avec le statut sur une erreur 429", async () => {
    vi.stubGlobal("fetch", async () => new Response("rate limited", { status: 429 }));
    await expect(sendEmail(testEnv(), base)).rejects.toMatchObject({ status: 429 });
  });

  it("lève une SendError sur une réponse success:false", async () => {
    vi.stubGlobal("fetch", async () =>
      Response.json({ success: false, errors: [{ message: "from non vérifié" }] }, { status: 400 })
    );
    await expect(sendEmail(testEnv(), base)).rejects.toThrow(/from non vérifié/);
  });
});

describe("payloadSize", () => {
  it("compte le corps et les pièces jointes décodées", () => {
    const size = payloadSize({
      ...base,
      attachments: [{ filename: "a.bin", mimeType: "application/octet-stream", contentBase64: "AAAA" }],
    });
    expect(size).toBeGreaterThan(base.text.length);
  });

  it("dépasse la limite pour une pièce jointe de 6 MiB", () => {
    const big = "A".repeat(Math.ceil((6 * 1024 * 1024 * 4) / 3));
    expect(payloadSize({ ...base, attachments: [{ filename: "b", mimeType: "x/y", contentBase64: big }] }))
      .toBeGreaterThan(5 * 1024 * 1024);
  });
});
```

- [ ] **Step 2: Lancer le test pour vérifier qu'il échoue**

Run: `pnpm vitest run test/send/client.test.ts`
Expected: FAIL — module `src/send/client` introuvable.

- [ ] **Step 3: Implémenter `src/send/client.ts`**

```ts
import type { Env } from "../env";

export type SendRequest = {
  from: string;
  to: string[];
  cc?: string[];
  subject: string;
  text: string;
  html?: string;
  replyTo?: string;
  inReplyTo?: string;
  references?: string[];
  attachments?: { filename: string; mimeType: string; contentBase64: string }[];
};
export type SendResult = { delivered: string[]; queued: string[]; permanentBounces: string[] };

export const MAX_PAYLOAD_BYTES = 5 * 1024 * 1024;

export class SendError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "SendError";
  }
}

export function payloadSize(req: SendRequest): number {
  const body = new TextEncoder().encode(
    req.subject + req.text + (req.html ?? "") + req.to.join(",") + (req.cc ?? []).join(",")
  ).byteLength;
  const attachments = (req.attachments ?? []).reduce(
    (sum, a) => sum + a.contentBase64.length + a.filename.length,
    0
  );
  return body + attachments;
}

export async function sendEmail(env: Env, req: SendRequest): Promise<SendResult> {
  if (payloadSize(req) > MAX_PAYLOAD_BYTES) {
    throw new SendError("Le message dépasse la limite de 5 MiB", 413);
  }

  const headers: Record<string, string> = {};
  if (req.inReplyTo) headers["In-Reply-To"] = req.inReplyTo;
  if (req.references?.length) headers["References"] = req.references.join(" ");

  const body: Record<string, unknown> = {
    from: req.from,
    to: req.to,
    subject: req.subject,
    text: req.text,
  };
  if (req.cc?.length) body.cc = req.cc;
  if (req.html) body.html = req.html;
  if (req.replyTo) body["reply-to"] = req.replyTo;
  if (Object.keys(headers).length) body.headers = headers;
  if (req.attachments?.length) {
    body.attachments = req.attachments.map((a) => ({
      filename: a.filename,
      content: a.contentBase64,
      type: a.mimeType,
    }));
  }

  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/email/sending/send`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${env.CF_API_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    }
  );

  const payload = await res.json().catch(() => null) as
    | { success?: boolean; result?: { delivered?: string[]; queued?: string[]; permanent_bounces?: string[] }; errors?: { message: string }[] }
    | null;

  if (!res.ok || payload?.success === false) {
    const message = payload?.errors?.map((e) => e.message).join(" ; ")
      ?? `L'API Email Sending a répondu ${res.status}`;
    throw new SendError(message, res.status);
  }

  return {
    delivered: payload?.result?.delivered ?? [],
    queued: payload?.result?.queued ?? [],
    permanentBounces: payload?.result?.permanent_bounces ?? [],
  };
}
```

- [ ] **Step 4: Lancer les tests du client**

Run: `pnpm vitest run test/send/client.test.ts`
Expected: 6 tests PASS.

- [ ] **Step 5: Écrire le test de la route d'envoi**

```ts
// test/api/send.test.ts
import { env, applyD1Migrations } from "cloudflare:test";
import { readD1Migrations } from "@cloudflare/vitest-plugin/config";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { app } from "../../src/index";

beforeAll(async () => {
  await applyD1Migrations(env.DB, await readD1Migrations("./migrations"));
});

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM messages"),
    env.DB.prepare("DELETE FROM threads"),
    env.DB.prepare("DELETE FROM identities"),
  ]);
  await env.DB.prepare(
    "INSERT INTO identities (address, display_name, is_default) VALUES ('thomas@planigramme.fr', 'Thomas', 1)"
  ).run();
});

afterEach(() => vi.unstubAllGlobals());

const ok = () =>
  vi.stubGlobal("fetch", async () =>
    Response.json({ success: true, result: { delivered: ["zoe@example.com"], queued: [], permanent_bounces: [] } })
  );

const post = (body: unknown) =>
  app.request(
    "https://example.com/api/messages",
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
    { ...env, DEV_BYPASS_AUTH: "1", CF_ACCOUNT_ID: "acc", CF_API_TOKEN: "tok" },
  );

const valid = {
  from: "thomas@planigramme.fr",
  to: ["zoe@example.com"],
  subject: "Bonjour",
  text: "Salut",
};

describe("POST /api/messages", () => {
  it("envoie et stocke une copie dans le dossier sent", async () => {
    ok();
    const res = await post(valid);
    expect(res.status).toBe(200);

    const m = await env.DB.prepare(
      "SELECT direction, folder, from_addr, subject, is_read FROM messages"
    ).first<Record<string, unknown>>();
    expect(m).toMatchObject({
      direction: "out", folder: "sent", from_addr: "thomas@planigramme.fr", subject: "Bonjour", is_read: 1,
    });
  });

  it("refuse un expéditeur qui n'est pas une identité connue", async () => {
    ok();
    const res = await post({ ...valid, from: "usurpateur@ailleurs.com" });
    expect(res.status).toBe(400);
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM messages").first<{ n: number }>();
    expect(n?.n).toBe(0);
  });

  it("ne stocke rien si l'API d'envoi échoue", async () => {
    vi.stubGlobal("fetch", async () => new Response("boom", { status: 429 }));
    const res = await post(valid);
    expect(res.status).toBe(429);
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM messages").first<{ n: number }>();
    expect(n?.n).toBe(0);
  });

  it("refuse un destinataire mal formé", async () => {
    ok();
    expect((await post({ ...valid, to: ["pas-une-adresse"] })).status).toBe(400);
  });

  it("refuse un message au-delà de 5 MiB", async () => {
    ok();
    const res = await post({ ...valid, text: "x".repeat(6 * 1024 * 1024) });
    expect(res.status).toBe(413);
  });

  it("rattache la réponse au thread du message parent", async () => {
    ok();
    await env.DB.prepare("INSERT INTO threads (id, subject_norm, last_message_at, message_count) VALUES (5, 'bonjour', 100, 1)").run();
    await env.DB.prepare(
      `INSERT INTO messages (id, thread_id, message_id, direction, folder, from_addr, subject, received_at, raw_key)
       VALUES (1, 5, '<parent@x>', 'in', 'inbox', 'zoe@example.com', 'Bonjour', 100, 'raw/p.eml')`
    ).run();

    await post({ ...valid, subject: "Re: Bonjour", inReplyTo: "<parent@x>" });
    const m = await env.DB.prepare("SELECT thread_id FROM messages WHERE direction = 'out'")
      .first<{ thread_id: number }>();
    expect(m?.thread_id).toBe(5);
  });

  it("remonte les bounces permanents au client", async () => {
    vi.stubGlobal("fetch", async () =>
      Response.json({ success: true, result: { delivered: [], queued: [], permanent_bounces: ["zoe@example.com"] } })
    );
    const res = await post(valid);
    expect(await res.json()).toMatchObject({ permanentBounces: ["zoe@example.com"] });
  });
});
```

- [ ] **Step 6: Ajouter `storeOutgoing` dans `src/db/mutations.ts`**

```ts
import { resolveThread } from "../ingest/threading";
import { normalizeSubject, snippetOf } from "../ingest/parse";
import type { SendRequest } from "../send/client";

export async function storeOutgoing(env: Env, req: SendRequest, messageId: string): Promise<number> {
  const now = Math.floor(Date.now() / 1000);
  const parsedLike = {
    messageId,
    inReplyTo: req.inReplyTo ?? null,
    references: req.references ?? [],
    from: { address: req.from, name: null },
    to: req.to.map((a) => ({ address: a, name: null })),
    cc: (req.cc ?? []).map((a) => ({ address: a, name: null })),
    replyTo: [],
    subject: req.subject,
    text: req.text,
    html: req.html ?? null,
    date: now,
    attachments: [],
    parseError: false,
  };

  const participants = [req.from, ...req.to, ...(req.cc ?? [])];
  const { threadId } = await resolveThread(env.DB, parsedLike, participants);

  const inserted = await env.DB.prepare(
    `INSERT INTO messages
       (thread_id, message_id, in_reply_to, direction, folder, from_addr, subject, text_body, html_body,
        snippet, received_at, is_read, has_attachments, raw_key, parse_error)
     VALUES (?, ?, ?, 'out', 'sent', ?, ?, ?, ?, ?, ?, 1, ?, ?, 0)`
  ).bind(
    threadId, messageId, req.inReplyTo ?? null, req.from, req.subject, req.text, req.html ?? null,
    snippetOf(req.text), now, (req.attachments?.length ?? 0) > 0 ? 1 : 0, `sent/${messageId}`
  ).run();
  const id = Number(inserted.meta.last_row_id);

  const statements: D1PreparedStatement[] = [];
  for (const [kind, list] of [["to", req.to], ["cc", req.cc ?? []]] as const) {
    for (const address of list) {
      statements.push(
        env.DB.prepare("INSERT INTO recipients (message_id, kind, address, name) VALUES (?, ?, ?, NULL)")
          .bind(id, kind, address)
      );
    }
  }
  statements.push(
    env.DB.prepare(
      "UPDATE threads SET message_count = message_count + 1, last_message_at = MAX(last_message_at, ?) WHERE id = ?"
    ).bind(now, threadId)
  );
  await env.DB.batch(statements);

  // normalizeSubject sert à garder le sujet du thread cohérent après un Re:
  await env.DB.prepare("UPDATE threads SET subject_norm = ? WHERE id = ? AND subject_norm = ''")
    .bind(normalizeSubject(req.subject), threadId).run();

  return id;
}
```

- [ ] **Step 7: Ajouter la route `POST /api/messages`**

```ts
// dans src/api/routes.ts
import { MAX_PAYLOAD_BYTES, SendError, payloadSize, sendEmail, type SendRequest } from "../send/client";
import { storeOutgoing } from "../db/mutations";

const sendBody = z.object({
  from: z.string().email(),
  to: z.array(z.string().email()).min(1).max(20),
  cc: z.array(z.string().email()).max(20).optional(),
  subject: z.string().max(500),
  text: z.string(),
  html: z.string().optional(),
  inReplyTo: z.string().max(500).optional(),
  attachments: z.array(z.object({
    filename: z.string().max(200),
    mimeType: z.string().max(120),
    contentBase64: z.string(),
  })).max(10).optional(),
});

api.post("/messages", async (c) => {
  const parsed = sendBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: { code: "invalid_body", message: parsed.error.issues[0].message } }, 400);
  }

  const identity = await c.env.DB.prepare("SELECT address FROM identities WHERE address = ?")
    .bind(parsed.data.from).first();
  if (!identity) {
    return c.json({ error: { code: "unknown_sender", message: "Expéditeur inconnu" } }, 400);
  }

  // Reconstitue la chaîne References à partir du message parent.
  let references: string[] | undefined;
  if (parsed.data.inReplyTo) {
    const parent = await c.env.DB.prepare("SELECT message_id FROM messages WHERE message_id = ?")
      .bind(parsed.data.inReplyTo).first<{ message_id: string }>();
    if (parent) references = [parent.message_id];
  }

  const req: SendRequest = { ...parsed.data, references };
  if (payloadSize(req) > MAX_PAYLOAD_BYTES) {
    return c.json({ error: { code: "too_large", message: "Le message dépasse 5 MiB" } }, 413);
  }

  let result;
  try {
    result = await sendEmail(c.env, req);
  } catch (err) {
    const status = err instanceof SendError ? err.status : 502;
    return c.json(
      { error: { code: "send_failed", message: err instanceof Error ? err.message : "Échec de l'envoi" } },
      status as 400 | 413 | 429 | 502
    );
  }

  const messageId = `<${crypto.randomUUID()}@planigramme.fr>`;
  const id = await storeOutgoing(c.env, req, messageId);
  return c.json({ id, ...result });
});
```

- [ ] **Step 8: Lancer les tests**

Run: `pnpm vitest run`
Expected: toute la suite PASS.

- [ ] **Step 9: Committer**

```bash
git add -A
git commit -m "feat: envoie les emails via l'API Cloudflare Email Sending"
```

---

### Task 13: Front — socle, layout et liste des threads

**Files:**
- Create: `web/package.json`, `web/vite.config.ts`, `web/index.html`, `web/src/main.tsx`, `web/src/App.tsx`, `web/src/api/client.ts`, `web/src/components/Sidebar.tsx`, `web/src/components/ThreadList.tsx`, `web/src/components/ThreadList.test.tsx`, `web/src/index.css`
- Modify: `package.json` (scripts `build`, `dev`)
- Test: `web/src/components/ThreadList.test.tsx`

**Interfaces:**
- Consumes: `GET /api/threads`, `GET /api/identities` (Task 8)
- Produces: types front `ThreadSummary`, `ThreadDetail`, `MessageDetail` (miroirs de `src/db/queries.ts`) ; hooks `useThreads(folder, q)`, `useThread(id)`, `useIdentities()` ; composants `<Sidebar>`, `<ThreadList>`.

- [ ] **Step 1: Initialiser le front**

```bash
cd web
pnpm create vite . --template react-ts
pnpm add @tanstack/react-query
pnpm add -D tailwindcss @tailwindcss/vite vitest @testing-library/react @testing-library/user-event jsdom
pnpm dlx shadcn@latest init
pnpm dlx shadcn@latest add button input badge scroll-area separator avatar dialog textarea
```

Dans `web/vite.config.ts`, configurer `build.outDir = "dist"`, le plugin Tailwind, et un proxy de développement :

```ts
server: { proxy: { "/api": "http://localhost:8787" } }
```

Ajouter à la racine, dans `package.json` :

```json
{
  "scripts": {
    "dev": "concurrently \"pnpm wrangler dev\" \"pnpm --filter web dev\"",
    "build": "pnpm --filter web build",
    "deploy": "pnpm build && pnpm wrangler deploy",
    "test": "vitest run && pnpm --filter web test"
  }
}
```

- [ ] **Step 2: Écrire le test qui échoue**

```tsx
// web/src/components/ThreadList.test.tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ThreadList } from "./ThreadList";
import type { ThreadSummary } from "../api/client";

const threads: ThreadSummary[] = [
  { id: 1, subject: "Facture", snippet: "Voici la facture", lastMessageAt: 1757318400,
    messageCount: 2, unreadCount: 1, participants: ["zoe@example.com"], hasAttachments: true },
  { id: 2, subject: "Réunion", snippet: "Demain 14h", lastMessageAt: 1757232000,
    messageCount: 1, unreadCount: 0, participants: ["bob@example.com"], hasAttachments: false },
];

describe("ThreadList", () => {
  it("affiche le sujet et l'extrait de chaque thread", () => {
    render(<ThreadList threads={threads} selectedId={null} onSelect={() => {}} />);
    expect(screen.getByText("Facture")).toBeDefined();
    expect(screen.getByText("Demain 14h")).toBeDefined();
  });

  it("marque visuellement les threads non lus", () => {
    render(<ThreadList threads={threads} selectedId={null} onSelect={() => {}} />);
    expect(screen.getByRole("option", { name: /Facture/ }).getAttribute("data-unread")).toBe("true");
    expect(screen.getByRole("option", { name: /Réunion/ }).getAttribute("data-unread")).toBe("false");
  });

  it("signale la présence de pièces jointes", () => {
    render(<ThreadList threads={threads} selectedId={null} onSelect={() => {}} />);
    expect(screen.getByLabelText("Contient une pièce jointe")).toBeDefined();
  });

  it("remonte la sélection", async () => {
    const onSelect = vi.fn();
    render(<ThreadList threads={threads} selectedId={null} onSelect={onSelect} />);
    await userEvent.click(screen.getByRole("option", { name: /Facture/ }));
    expect(onSelect).toHaveBeenCalledWith(1);
  });

  it("affiche un état vide explicite", () => {
    render(<ThreadList threads={[]} selectedId={null} onSelect={() => {}} />);
    expect(screen.getByText(/Aucun message/)).toBeDefined();
  });
});
```

- [ ] **Step 3: Lancer le test pour vérifier qu'il échoue**

Run: `cd web && pnpm vitest run src/components/ThreadList.test.tsx`
Expected: FAIL — module `./ThreadList` introuvable.

- [ ] **Step 4: Implémenter `web/src/api/client.ts`**

```ts
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

export type ThreadSummary = {
  id: number; subject: string; snippet: string; lastMessageAt: number;
  messageCount: number; unreadCount: number; participants: string[]; hasAttachments: boolean;
};
export type MessageDetail = {
  id: number; messageId: string; direction: "in" | "out"; folder: string;
  from: { address: string; name: string | null };
  to: { address: string; name: string | null }[];
  cc: { address: string; name: string | null }[];
  subject: string; text: string; html: string | null;
  receivedAt: number; isRead: boolean; parseError: boolean;
  attachments: { id: number; filename: string; mimeType: string; size: number }[];
};
export type ThreadDetail = { id: number; subject: string; messages: MessageDetail[] };
export type Identity = { address: string; displayName: string | null; isDefault: boolean };

export class ApiError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null) as { error?: { message: string } } | null;
    throw new ApiError(body?.error?.message ?? `Erreur ${res.status}`, res.status);
  }
  return res.json() as Promise<T>;
}

export const useThreads = (folder: string, q: string) =>
  useQuery({
    queryKey: ["threads", folder, q],
    queryFn: () =>
      api<{ threads: ThreadSummary[]; cursor: string | null }>(
        `/threads?folder=${folder}${q ? `&q=${encodeURIComponent(q)}` : ""}`
      ),
  });

export const useThread = (id: number | null) =>
  useQuery({
    queryKey: ["thread", id],
    queryFn: () => api<ThreadDetail>(`/threads/${id}`),
    enabled: id !== null,
  });

export const useIdentities = () =>
  useQuery({ queryKey: ["identities"], queryFn: () => api<Identity[]>("/identities") });

export const useUpdateMessage = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: number; isRead?: boolean; folder?: "inbox" | "trash" }) =>
      api<{ ok: true }>(`/messages/${vars.id}`, { method: "PATCH", body: JSON.stringify(vars) }),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ["threads"] });
      qc.invalidateQueries({ queryKey: ["thread"] });
    },
  });
};

export const useSendMessage = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: unknown) =>
      api<{ id: number; delivered: string[]; queued: string[]; permanentBounces: string[] }>(
        "/messages", { method: "POST", body: JSON.stringify(body) }
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["threads"] }),
  });
};
```

- [ ] **Step 5: Implémenter `web/src/components/ThreadList.tsx`**

```tsx
import type { ThreadSummary } from "../api/client";

const formatDate = (epoch: number) => {
  const d = new Date(epoch * 1000);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  return sameDay
    ? d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString("fr-FR", { day: "numeric", month: "short" });
};

export function ThreadList({
  threads, selectedId, onSelect,
}: {
  threads: ThreadSummary[];
  selectedId: number | null;
  onSelect: (id: number) => void;
}) {
  if (threads.length === 0) {
    return <p className="p-8 text-center text-sm text-muted-foreground">Aucun message ici.</p>;
  }

  return (
    <ul role="listbox" aria-label="Conversations" className="divide-y">
      {threads.map((t) => (
        <li
          key={t.id}
          role="option"
          aria-selected={t.id === selectedId}
          data-unread={t.unreadCount > 0 ? "true" : "false"}
          tabIndex={0}
          onClick={() => onSelect(t.id)}
          onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") onSelect(t.id); }}
          className="cursor-pointer px-4 py-3 hover:bg-accent data-[unread=true]:font-semibold aria-selected:bg-accent"
        >
          <div className="flex items-baseline justify-between gap-2">
            <span className="truncate text-sm">{t.participants.join(", ")}</span>
            <time className="shrink-0 text-xs text-muted-foreground">{formatDate(t.lastMessageAt)}</time>
          </div>
          <div className="flex items-center gap-2">
            <span className="truncate text-sm">{t.subject}</span>
            {t.messageCount > 1 && <span className="text-xs text-muted-foreground">{t.messageCount}</span>}
            {t.hasAttachments && <span aria-label="Contient une pièce jointe">📎</span>}
          </div>
          <p className="truncate text-xs font-normal text-muted-foreground">{t.snippet}</p>
        </li>
      ))}
    </ul>
  );
}
```

- [ ] **Step 6: Implémenter `Sidebar.tsx` et `App.tsx`**

`Sidebar` affiche les trois dossiers (`Boîte de réception`, `Envoyés`, `Corbeille`) comme des boutons, plus la liste des identités issue de `useIdentities()`. `App` compose le layout en trois colonnes (`grid lg:grid-cols-[220px_360px_1fr]`), gère l'état `{ folder, query, selectedThreadId }`, et masque les colonnes de gauche en mobile quand un thread est ouvert.

- [ ] **Step 7: Lancer les tests**

Run: `cd web && pnpm vitest run`
Expected: 5 tests PASS.

- [ ] **Step 8: Vérifier le build et le service par le Worker**

```bash
pnpm build
pnpm wrangler dev
# ouvrir http://localhost:8787 avec DEV_BYPASS_AUTH=1 dans .dev.vars
```
Expected: la liste s'affiche (vide tant qu'aucun email n'est reçu).

- [ ] **Step 9: Committer**

```bash
git add -A
git commit -m "feat: ajoute le socle du front et la liste des conversations"
```

---

### Task 14: Front — lecture d'un thread et rendu sécurisé du corps

**Files:**
- Create: `web/src/components/ThreadView.tsx`, `web/src/components/MessageBody.tsx`, `web/src/components/MessageBody.test.tsx`
- Modify: `web/src/App.tsx`
- Test: `web/src/components/MessageBody.test.tsx`

**Interfaces:**
- Consumes: `useThread` (Task 13), `GET /api/messages/:id/body` (Task 10), `GET /api/attachments/:id` (Task 11)
- Produces: `<ThreadView threadId>` et `<MessageBody messageId html text hasRemoteImages>`.

- [ ] **Step 1: Écrire le test qui échoue**

```tsx
// web/src/components/MessageBody.test.tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { MessageBody } from "./MessageBody";

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async (url: string) =>
    Response.json({
      html: url.includes("images=allowed") ? '<img src="https://x/a.png">' : '<img data-blocked-src="https://x/a.png">',
      text: "version texte",
      hasRemoteImages: true,
    })
  ));
});

describe("MessageBody", () => {
  it("rend le HTML dans une iframe sandboxée sans scripts", async () => {
    render(<MessageBody messageId={1} />);
    const frame = await screen.findByTitle("Contenu du message");
    expect(frame.getAttribute("sandbox")).toBe("");
    expect(frame.getAttribute("srcdoc")).toContain("data-blocked-src");
  });

  it("propose d'afficher les images distantes puis les recharge", async () => {
    render(<MessageBody messageId={1} />);
    const bouton = await screen.findByRole("button", { name: /Afficher les images/ });
    await userEvent.click(bouton);
    const frame = await screen.findByTitle("Contenu du message");
    expect(frame.getAttribute("srcdoc")).toContain("https://x/a.png");
  });

  it("affiche le texte brut quand il n'y a pas de HTML", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      Response.json({ html: null, text: "juste du texte", hasRemoteImages: false })
    ));
    render(<MessageBody messageId={1} />);
    expect(await screen.findByText("juste du texte")).toBeDefined();
  });
});
```

- [ ] **Step 2: Lancer le test pour vérifier qu'il échoue**

Run: `cd web && pnpm vitest run src/components/MessageBody.test.tsx`
Expected: FAIL — module `./MessageBody` introuvable.

- [ ] **Step 3: Implémenter `web/src/components/MessageBody.tsx`**

```tsx
import { useEffect, useState } from "react";

type Body = { html: string | null; text: string; hasRemoteImages: boolean };

export function MessageBody({ messageId }: { messageId: number }) {
  const [showImages, setShowImages] = useState(false);
  const [body, setBody] = useState<Body | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/messages/${messageId}/body${showImages ? "?images=allowed" : ""}`)
      .then((r) => r.json())
      .then((b: Body) => { if (!cancelled) setBody(b); });
    return () => { cancelled = true; };
  }, [messageId, showImages]);

  if (!body) return <p className="p-4 text-sm text-muted-foreground">Chargement…</p>;

  if (!body.html) {
    return <pre className="whitespace-pre-wrap p-4 font-sans text-sm">{body.text}</pre>;
  }

  return (
    <div>
      {body.hasRemoteImages && !showImages && (
        <div className="flex items-center justify-between gap-4 border-b bg-muted px-4 py-2 text-sm">
          <span>Les images distantes sont bloquées pour protéger ta vie privée.</span>
          <button className="underline" onClick={() => setShowImages(true)}>
            Afficher les images
          </button>
        </div>
      )}
      {/* sandbox="" : aucune permission accordée, donc pas de scripts, pas de formulaires, pas de navigation. */}
      <iframe
        title="Contenu du message"
        sandbox=""
        referrerPolicy="no-referrer"
        className="h-[60vh] w-full border-0"
        srcDoc={`<!doctype html><meta charset="utf-8"><base target="_blank"><style>body{font:14px system-ui;margin:12px}img{max-width:100%}</style>${body.html}`}
      />
    </div>
  );
}
```

- [ ] **Step 4: Implémenter `web/src/components/ThreadView.tsx`**

Le composant appelle `useThread(threadId)`, affiche l'en-tête du thread (sujet, nombre de messages), puis un accordéon de messages : chaque en-tête montre expéditeur, destinataires et date, le dernier message est déplié par défaut. Il affiche la liste des pièces jointes en liens `<a href={/api/attachments/${id}} download>`, un bandeau d'avertissement quand `parseError` est vrai avec un lien vers `/api/messages/:id/raw`, et les actions « Répondre », « Marquer comme non lu » et « Supprimer » via `useUpdateMessage`. À l'ouverture d'un thread, marquer ses messages non lus comme lus.

- [ ] **Step 5: Ajouter la CSP de l'application dans `src/index.ts`**

Le HTML des emails est déjà isolé dans une iframe `sandbox`, mais l'application elle-même doit refuser tout script tiers.

```ts
app.use("*", async (c, next) => {
  await next();
  if (c.res.headers.get("content-type")?.includes("text/html")) {
    c.res.headers.set(
      "content-security-policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
        "img-src 'self' data:; frame-src 'self'; connect-src 'self'; " +
        "object-src 'none'; base-uri 'none'; form-action 'none'",
    );
    c.res.headers.set("x-content-type-options", "nosniff");
    c.res.headers.set("referrer-policy", "no-referrer");
  }
});
```

Ce middleware doit être enregistré **avant** `app.use("/api/*", requireAccess())`.

- [ ] **Step 6: Lancer les tests**

Run: `cd web && pnpm vitest run && cd .. && pnpm vitest run`
Expected: tous les tests PASS.

- [ ] **Step 7: Committer**

```bash
git add -A
git commit -m "feat: affiche les conversations avec un rendu HTML isolé"
```

---

### Task 15: Front — composition, réponse et pièces jointes

**Files:**
- Create: `web/src/components/Composer.tsx`, `web/src/components/Composer.test.tsx`
- Modify: `web/src/App.tsx`, `web/src/components/ThreadView.tsx`
- Test: `web/src/components/Composer.test.tsx`

**Interfaces:**
- Consumes: `useIdentities`, `useSendMessage` (Task 13), `POST /api/messages` (Task 12)
- Produces: `<Composer mode="new" | "reply" replyTo?={MessageDetail} onClose>`.

- [ ] **Step 1: Écrire le test qui échoue**

```tsx
// web/src/components/Composer.test.tsx
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Composer } from "./Composer";

const wrap = (ui: React.ReactElement) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
};

const identities = [{ address: "thomas@planigramme.fr", displayName: "Thomas", isDefault: true }];

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (url.includes("/identities")) return Response.json(identities);
    return Response.json({ id: 1, delivered: ["zoe@example.com"], queued: [], permanentBounces: [] });
  }));
});

describe("Composer", () => {
  it("envoie le message saisi", async () => {
    wrap(<Composer mode="new" onClose={() => {}} />);
    await userEvent.type(await screen.findByLabelText("Destinataires"), "zoe@example.com");
    await userEvent.type(screen.getByLabelText("Objet"), "Bonjour");
    await userEvent.type(screen.getByLabelText("Message"), "Salut");
    await userEvent.click(screen.getByRole("button", { name: "Envoyer" }));

    await waitFor(() => {
      const body = JSON.parse((vi.mocked(fetch).mock.calls.at(-1)![1] as RequestInit).body as string);
      expect(body).toMatchObject({
        from: "thomas@planigramme.fr", to: ["zoe@example.com"], subject: "Bonjour", text: "Salut",
      });
    });
  });

  it("refuse d'envoyer sans destinataire", async () => {
    wrap(<Composer mode="new" onClose={() => {}} />);
    await screen.findByLabelText("Destinataires");
    await userEvent.click(screen.getByRole("button", { name: "Envoyer" }));
    expect(await screen.findByText(/au moins un destinataire/i)).toBeDefined();
  });

  it("préremplit une réponse avec le sujet et le destinataire", async () => {
    wrap(
      <Composer
        mode="reply"
        replyTo={{
          id: 1, messageId: "<p@x>", direction: "in", folder: "inbox",
          from: { address: "zoe@example.com", name: "Zoé" }, to: [], cc: [],
          subject: "Facture", text: "", html: null, receivedAt: 1, isRead: true,
          parseError: false, attachments: [],
        }}
        onClose={() => {}}
      />
    );
    expect((await screen.findByLabelText("Destinataires") as HTMLInputElement).value).toBe("zoe@example.com");
    expect((screen.getByLabelText("Objet") as HTMLInputElement).value).toBe("Re: Facture");
  });

  it("refuse un fichier qui ferait dépasser 5 MiB", async () => {
    wrap(<Composer mode="new" onClose={() => {}} />);
    const input = await screen.findByLabelText("Pièces jointes") as HTMLInputElement;
    const gros = new File([new Uint8Array(6 * 1024 * 1024)], "gros.bin");
    await userEvent.upload(input, gros);
    expect(await screen.findByText(/5 MiB/)).toBeDefined();
  });

  it("affiche l'erreur renvoyée par l'API", async () => {
    vi.mocked(fetch).mockImplementation(async (url: string) =>
      url.includes("/identities")
        ? Response.json(identities)
        : Response.json({ error: { code: "send_failed", message: "Domaine non vérifié" } }, { status: 400 })
    );
    wrap(<Composer mode="new" onClose={() => {}} />);
    await userEvent.type(await screen.findByLabelText("Destinataires"), "zoe@example.com");
    await userEvent.click(screen.getByRole("button", { name: "Envoyer" }));
    expect(await screen.findByText("Domaine non vérifié")).toBeDefined();
  });
});
```

- [ ] **Step 2: Lancer le test pour vérifier qu'il échoue**

Run: `cd web && pnpm vitest run src/components/Composer.test.tsx`
Expected: FAIL — module `./Composer` introuvable.

- [ ] **Step 3: Implémenter `web/src/components/Composer.tsx`**

Le composant :
- lit `useIdentities()` et présélectionne l'identité par défaut dans un `<select>` étiqueté « De » ;
- en mode `reply`, préremplit « Destinataires » avec `replyTo.from.address`, « Objet » avec `Re: ` + le sujet (sans doubler un `Re:` déjà présent), et passe `inReplyTo: replyTo.messageId` dans la requête ;
- découpe le champ destinataires sur virgules et espaces, et affiche « Indique au moins un destinataire » si le résultat est vide ;
- lit chaque fichier via `FileReader.readAsDataURL`, en extrait la partie base64, et refuse l'ajout si la somme des `contentBase64` dépasse `5 * 1024 * 1024` avec le message « L'ensemble dépasse la limite de 5 MiB » ;
- appelle `useSendMessage()` et affiche `error.message` dans un `role="alert"` en cas d'échec, ou ferme la fenêtre via `onClose()` en cas de succès ;
- affiche les `permanentBounces` retournés, s'il y en a, avant de fermer.

- [ ] **Step 4: Brancher le composeur**

Ajouter un bouton « Nouveau message » dans `Sidebar` et un bouton « Répondre » dans `ThreadView`, tous deux ouvrant `<Composer>` dans un `Dialog` shadcn.

- [ ] **Step 5: Lancer les tests**

Run: `cd web && pnpm vitest run`
Expected: tous les tests PASS.

- [ ] **Step 6: Committer**

```bash
git add -A
git commit -m "feat: ajoute la composition et la réponse avec pièces jointes"
```

---

### Task 16: Déploiement et documentation

**Files:**
- Create: `README.md`, `.dev.vars.example`
- Modify: `wrangler.jsonc`
- Test: vérification manuelle de bout en bout

**Interfaces:**
- Consumes: l'ensemble des tâches précédentes
- Produces: une application déployée et joignable sur `mail.planigramme.fr`.

- [ ] **Step 1: Ajouter la route personnalisée dans `wrangler.jsonc`**

```jsonc
"routes": [{ "pattern": "mail.planigramme.fr", "custom_domain": true }]
```

- [ ] **Step 2: Créer le token API et poser les secrets**

Dans le tableau de bord Cloudflare, créer un token API avec la seule permission d'envoi d'emails (« Email Sending: Send »), puis :

```bash
pnpm wrangler secret put CF_ACCOUNT_ID
pnpm wrangler secret put CF_API_TOKEN
```

Renseigner `ACCESS_TEAM_DOMAIN` et `ACCESS_AUD` dans la section `vars` de `wrangler.jsonc` une fois l'application Access créée (étape 5).

- [ ] **Step 3: Vérifier le domaine dans Email Service**

Dans le tableau de bord : Email → Email Service → Sending → ajouter `planigramme.fr` et publier les enregistrements DNS demandés. Attendre le statut « verified ».

- [ ] **Step 4: Activer Email Routing vers le Worker**

Email → Email Routing → activer, puis créer une règle catch-all « Send to a Worker » pointant sur `cloudmail`.

- [ ] **Step 5: Créer l'application Cloudflare Access**

Zero Trust → Access → Applications → Self-hosted, domaine `mail.planigramme.fr`, politique « Emails » limitée à `thomas.stocker.pro@gmail.com`. Copier l'Application Audience (AUD) dans `ACCESS_AUD` et le team domain dans `ACCESS_TEAM_DOMAIN`.

- [ ] **Step 6: Peupler les identités**

```bash
pnpm wrangler d1 execute cloudmail --remote --command \
  "INSERT INTO identities (address, display_name, is_default) VALUES ('thomas@planigramme.fr', 'Thomas Stocker', 1)"
```

- [ ] **Step 7: Déployer**

```bash
pnpm deploy
```

- [ ] **Step 8: Vérifier de bout en bout**

1. Ouvrir `https://mail.planigramme.fr` → l'écran de connexion Access s'affiche, puis le webmail.
2. Depuis une adresse externe, envoyer un email à `thomas@planigramme.fr` → il apparaît dans la boîte de réception en moins d'une minute.
3. Ouvrir le message, vérifier l'affichage du corps et le blocage des images distantes.
4. Répondre → l'email arrive côté destinataire, et la réponse s'affiche dans le même thread.
5. Envoyer un email avec pièce jointe dans les deux sens et vérifier le téléchargement.
6. Rechercher un mot du corps d'un message reçu → le thread remonte.
7. Supprimer un message → il quitte la boîte de réception.

Noter tout écart et le corriger avant de considérer la tâche terminée.

- [ ] **Step 9: Écrire le README**

Documenter : l'architecture en un paragraphe, les prérequis Cloudflare, les commandes (`pnpm dev`, `pnpm test`, `pnpm deploy`), les cinq étapes de configuration manuelle ci-dessus, le contenu de `.dev.vars.example` (`DEV_BYPASS_AUTH=1`, `CF_ACCOUNT_ID`, `CF_API_TOKEN`), et la procédure de rejeu d'un message via `reparse()`.

- [ ] **Step 10: Committer**

```bash
git add -A
git commit -m "docs: documente la configuration et le déploiement de Cloudmail"
```
