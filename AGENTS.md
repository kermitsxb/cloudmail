# Cloudmail — project instructions

Personal webmail on a single Cloudflare Worker. The `README.md` is written for
humans (features, setup procedure, operations); this file holds everything an
agent needs to change the code without breaking an invariant: the rules, the
reasons behind them, and the traps. When the two disagree, the code wins —
fix whichever document is wrong.

Design history lives in `docs/superpowers/specs/` and `docs/superpowers/plans/`.

## Architecture

One Worker, three roles:

- **`email()` handler** (`src/email.ts`) — receives mail from Cloudflare Email
  Routing, forwards it, then runs the ingestion pipeline (`src/ingest/`:
  MIME parsing, storage, threading).
- **HTTP API** (`src/api/routes.ts`, Hono) under `/api/*` — threads, messages,
  attachments, raw MIME, identities, forwarding rules and destinations, config,
  admin re-import (`src/admin/reimport.ts`).
- **Static SPA** (`web/`, built into `web/dist`, served through the `ASSETS`
  binding) for every other route, with SPA fallback. `run_worker_first`
  covers `/api/*` and `/healthz`.

Storage: structured metadata (identities, threads, messages, recipients,
attachments, forwarding rules) in D1 (`DB`); raw MIME of every received
message and attachment bodies in R2 (`MAIL`). Full-text search is an FTS5
table (`messages_fts`) kept in sync by triggers (`migrations/0001_initial.sql`).

Cloudflare Access sits in front of everything: `requireAccess()`
(`src/auth/access.ts`) rejects any API request without a valid Access JWT whose
email is in `ALLOWED_EMAILS`. The only bypass is `DEV_BYPASS_AUTH=1`, local only.

## Invariants — do not break these

### The `email()` handler never rejects

`src/email.ts` must never call `setReject()` — a rejection bounces back to the
sender. Every failure inside the handler is caught and logged instead.

### No received message is ever lost

The raw MIME is written to R2 **before** any parsing or D1 write. A later
failure (D1 insert rejected, unmigrated database, ingestion bug) therefore
leaves an R2 object with no `messages` row rather than losing the mail. The
cost of this choice: such orphans are silent (see "Raw MIME storage"). The
Maintenance view (`GET /api/admin/orphans`, `src/admin/reimport.ts`) finds
them by listing `raw/` through the R2 binding and diffing each page against
D1; they are recovered by re-importing them.

### Forwarding is isolated from archiving

Forwarding rules live in D1 (`forward_rules`), not in the Cloudflare
dashboard. A rule maps a source — a local part, or `*` for every address on
the domain — to a destination verified on the Cloudflare account. On receipt,
`handleEmail` applies **every** matching rule, catch-all included, and
deduplicates identical destinations.

- The forward runs **before** archiving, because `message.raw` is a single-use
  `ReadableStream`.
- An **exception** thrown by the forward or by reading the rules is caught and
  does not prevent archiving (`handleEmail` logs `forward_rules_failed`).
- A forward that **hangs** is abandoned after `FORWARD_TIMEOUT_MS` (10 s per
  destination, `src/email.ts`) so archiving keeps execution time. Without this
  bound, a forward that never returns would leave the message with no R2
  object and no D1 row, since nothing has been written yet at that point.

This split is the whole point of the feature: Email Routing can only deliver
to a Worker **or** an address, never both, so the Worker must do the forward
itself for a message to land in Cloudmail and in an external mailbox.

The catch-all is stored as the sentinel `*` rather than `NULL`: two `NULL`s are
distinct in SQLite, so the unique index on `(match_local, destination)` would allow the
same catch-all rule twice. `*` is not a valid local part, so it can't collide.

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

### Purge order: R2 first, then D1

`purgeMessage` (`src/db/mutations.ts`) deletes R2 objects, then the D1 row. R2
deletes are idempotent, so an interrupted purge is replayed to completion using
the still-present D1 row as its address. The reverse order was tried and
rejected: once the row is gone, `raw_key`/`r2_key` go with it and an R2 failure
leaves unrecoverable orphans of sensitive content. The residue of the chosen
order (a row pointing to deleted objects) is visible — 404 on the attachment or
raw — and repairable by re-running the purge. A raw MIME object is only
deleted when no other row still references its `raw_key` — two rows can share
one when the same bytes were delivered twice under different synthetic
message IDs.

Before touching R2, a purge reserves the message's `raw_key` in
`purge_claims` (migration `0005`). The reservation is inserted atomically with
the scheduled purge's trash/age check. It blocks a concurrent restore and a
second purge of the same raw object. The reservation is released after the
attempt; if a Worker stops abruptly, a later purge can reclaim it after 24 h.
The D1 message row is still deleted only after R2. A conflicting API request
returns `409` with `purge_in_progress`.

Deletion is two-step in the UI: `PATCH /api/messages/:id` with `folder:
"trash"` moves to trash (restoring picks `inbox` or `sent` from the message
direction); `DELETE /api/messages/:id` purges permanently. `spam` is the
second folder outside the thread counters alongside `trash`
(`src/db/folders.ts`, `countsInThread`); "Not spam" is the same `PATCH`, with
`folder: "inbox"`.

### Migrations are immutable once applied

D1 records applied migrations by name, so editing an applied migration is never
replayed and the database silently keeps the old schema. Any schema change goes
through a new `migrations/000N_*.sql`. A local database in that state is reset
with `rm -rf .wrangler/state/v3/d1 .wrangler/state/v3/r2` then
`pnpm wrangler d1 migrations apply cloudmail --local`.

Changing a `CHECK` on `messages` means rebuilding it (`0006`). D1 enforces
foreign keys and won't let a migration disable them: `DROP TABLE messages`
cascades into `recipients` and `attachments`, and `ALTER TABLE … RENAME`
rewrites child foreign keys to the new name. Rebuild the child tables too,
drop children first, rename after, keep ids so `messages_fts` stays valid,
and recreate every index and FTS trigger.

## Raw MIME storage

The raw MIME key is content-addressed: `raw/<sha256-of-content>.eml` — no
timestamp, no message ID; two byte-identical messages share a key. The D1
`messages` row is the **only** known address of that object:
`messages.raw_key` is indexed (`idx_messages_raw_key`) for lookups by key.
Inside the Worker, the R2 binding lists `raw/` (`env.MAIL.list`); from a
terminal, `wrangler r2 object` has no listing subcommand, so listing requires
R2's S3-compatible API.

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
  Only parse-derived columns (including `auth_spf`, `auth_dkim`, `auth_dmarc`
  and `spam_score`), recipients and attachments are rewritten; `id`,
  `thread_id`, `folder`, `is_read`, `direction` and `raw_key` never are — a
  message's folder never moves on re-import — so
  thread counters never move and no thread is ever emptied. Rows are found by
  `raw_key`, not by the freshly parsed `Message-ID`: an invented ID
  (`messageIdSynthetic`) changes on every parse, and looking it up used to
  insert a duplicate. An invented ID never overwrites the stored one, and
  likewise an invented date (`dateSynthetic`) never overwrites the stored
  `received_at`.
- **Attachment order**: each re-import attempt writes attachments under its
  own keys, scoped to the D1 row. New objects are written before the batch;
  `DELETE … RETURNING` captures the keys actually displaced by the transaction.
  Displaced keys absent from the new set are deleted after commit only if no other row
  references them; if the batch fails, the attempt's new keys are deleted.
  A failed post-commit reference check leaves the old objects in R2
  and is logged without changing the successful re-import outcome.
- **It never forwards**, never touches `forward_rules`, and never deletes a
  raw MIME object.

## Scheduled maintenance (`src/maintenance/`)

One Cron Trigger (`triggers.crons` in `wrangler.jsonc`; the free plan allows
only one) calls `scheduled()` → `runMaintenance`, which never throws:

- **Trash purge** (`trash.ts`): messages with `folder IN ('trash', 'spam')`
  and `trashed_at` older than `TRASH_RETENTION_DAYS`, oldest first, at most
  100 per run, each through `purgeMessage` — never a direct delete, so the
  R2-then-D1 order holds. `trashed_at` is set and cleared only by
  `moveToFolder` and, for a spam arrival, by `storeIncoming` — the two paths
  into a retained folder; keep it that way. A missing or invalid retention
  value disables the purge rather than deleting anything.
- **Orphan check** (`orphans.ts`): counts `raw/` objects with no row, up to
  20 pages of `listOrphans`. It reports only — never re-imports, never
  deletes. Recovery stays a user action.
- Each run is one `maintenance_runs` row (last 30 kept) and one
  `{ event: "maintenance" }` log line. `GET /api/admin/maintenance` returns
  the last `cron` row (`lastRun`) and the last successful check of either
  trigger (`lastCheck`). `POST /api/admin/maintenance/orphan-check` runs the
  check only; the purge is never reachable from the API.

## Never commit a value specific to one installation

This repository is open source and meant to be cloned and deployed by other
people. A value that describes **one** installation therefore has no place in
it, even when it isn't secret: it forces anyone picking up the project to
guess what's an example and what's someone else's configuration, and it ends
up deployed by mistake.

The criterion isn't "is it confidential?" but **"does this value change from
one installation to another?"**. A Cloudflare Access team domain and an
application AUD are public — Cloudflare serves them to any anonymous visitor
in the redirect to the login page — yet they must not be versioned, because
they identify one specific installation.

This includes, non-exhaustively:

- email addresses, domain names, subdomains
- account, D1 database, R2 bucket, DNS zone identifiers
- Cloudflare Access team domain and Application Audience (AUD)
- API tokens, keys, passwords — obviously, but those are the easy cases

**Where to put them instead.** Any value read by the Worker via `env` belongs
as a secret, which never goes through git:

```bash
pnpm wrangler secret put VARIABLE_NAME
```

In local development, `.dev.vars` (gitignored) supplies them; `.dev.vars.example`
documents which ones are expected, with empty or example values.

**If the code reads a value that may be missing**, it must explicitly refuse by
naming what wasn't set, rather than crash. See `requireAccessConfig()` in
`src/auth/access.ts`: a missing secret produces an authentication refusal
whose message names the variable, instead of a `TypeError` surfacing as a
"500 Internal Error" that sends you looking for a bug where there's only
incomplete configuration.

**In tests and documentation**, use neutral example values (`you@example.com`,
`example.com`) and never a real address or domain.

## Environment variables

Everything read by `Env` (`src/env.ts`):

| Variable | Kind | Deployed | Local | Read by |
| --- | --- | --- | --- | --- |
| `CF_ACCOUNT_ID` | secret | `wrangler secret put` | `.dev.vars` | `src/send/client.ts` — account in the Email Sending URL |
| `CF_API_TOKEN` | secret | `wrangler secret put` | `.dev.vars` | `src/send/client.ts` — **Email Sending: Send** permission only |
| `CF_ROUTING_TOKEN` | secret | `wrangler secret put` | `.dev.vars` | `src/forwarding/destinations.ts` — **Email Routing: Read** only |
| `ACCESS_TEAM_DOMAIN` | secret | `wrangler secret put` | unused (bypass) | `src/auth/access.ts` — JWT issuer and JWKS |
| `ACCESS_AUD` | secret | `wrangler secret put` | unused (bypass) | `src/auth/access.ts` — JWT audience |
| `ALLOWED_EMAILS` | secret | `wrangler secret put` | unused (bypass) | `src/auth/access.ts` — comma-separated allow-list |
| `MAIL_DOMAIN` | var | `wrangler.overrides.json` → `vars` | `wrangler.jsonc` placeholder | `src/api/routes.ts` — `Message-ID` domain, `GET /api/config` |
| `TRASH_RETENTION_DAYS` | var | `wrangler.jsonc` default `"30"`, override in `wrangler.overrides.json` | `wrangler.jsonc` | `src/maintenance/trash.ts` — trash retention; `0`/missing/invalid disables the purge |
| `DEV_BYPASS_AUTH` | var | **never** | `.dev.vars` (`=1`) | `src/auth/access.ts` — skips Access, identity `dev@localhost` |

The two API tokens are deliberately separate (least privilege): a leaked
sending token grants no access to routing configuration, and vice versa. Keep
it that way — don't merge them into one broader token.

`ACCESS_TEAM_DOMAIN`, `ACCESS_AUD` and `ALLOWED_EMAILS` are **secrets, not
`vars`**: they must never appear in `wrangler.jsonc`. An empty `ALLOWED_EMAILS`
is treated as missing so the error message points to the right cause.

## Deployment configuration

`wrangler.jsonc` is versioned with **structurally valid placeholders**
(`mail.example.com`, `"local"`, `example.com`), which lets `pnpm test` and
`pnpm dev` work on a fresh clone with no setup. Real values live in
`wrangler.overrides.json` (gitignored) and are merged by `scripts/config.mjs`
into `.wrangler/generated.jsonc`, used by remote commands via `-c`.

Never write a real value into `wrangler.jsonc`. Any Wrangler command that
touches the remote (`deploy`, `d1 ... --remote`) must go through
`.wrangler/generated.jsonc`, otherwise it would target the placeholder
`database_id`. The pure merge logic lives in `scripts/config-merge.mjs` and is
tested in `test/scripts/config-merge.test.ts`; `scripts/config.mjs` is only
its input/output shell. Its behavior:

- `PLACEHOLDER_VALUES` (`example.com`, `mail.example.com`, `local`) left in the
  merged config make it refuse, naming each missing override — deploying on
  placeholders would target a domain and database that aren't yours.
- Arrays merge **by position**, not by replacement: an override holding only
  `database_id` keeps the binding, database name and `migrations_dir`.
- Relative paths (`main`, `assets.directory`, `migrations_dir`) are rewritten
  to absolute, because `generated.jsonc` lives in `.wrangler/` and Wrangler
  resolves paths relative to the config file.

## Deployment

`pnpm run deploy`, not `pnpm deploy`: in a pnpm workspace, `deploy` is a
native pnpm command that shadows the script and fails with
`ERR_PNPM_NOTHING_TO_DEPLOY` without running anything.

The first-time setup is manual and ordered (README, "Deploying to
Cloudflare"). Never automate it — it touches the user's paid account and makes
the service public. The order encodes real constraints:

- **D1 is migrated and seeded before Email Routing is enabled.** The reverse
  loses mail: a message arriving before migrations hits `no such table:
  messages`, `handleEmail` swallows the error (no `setReject`), and the mail
  survives only as an orphan R2 object.
- **A first deploy precedes Email Routing**, because the dashboard only lists
  already-deployed Workers as catch-all targets. That deploy is safe while
  Access secrets are empty: `requireAccess()` then rejects every request.
- **Literal Email Routing rules take precedence over the catch-all**; the
  Worker never sees those addresses. They are removed **last**, after the
  equivalent Cloudmail forwarding rules exist — otherwise there's a window
  where mail is archived but not forwarded.
- **On an existing installation, `pnpm run migrate:remote` must run before
  deploying a version with a new migration.** Skipping it doesn't fail the
  deploy; the breakage shows up later: without `forward_rules`, `GET
  /api/forwarding/rules` returns 500 and incoming mail logs
  `forward_rules_failed`, archived but never forwarded. Without `0004`,
  moving any message between folders (trash, restore, inbox↔sent) returns
  500 — the `UPDATE` always writes `trashed_at`, a column that doesn't exist
  yet — and the nightly run logs a failure while the Maintenance view shows
  "never run". Without `0005`, any permanent deletion (manual or scheduled)
  and any folder move returns 500 because the purge reservation table is
  missing. Without `0006`, every incoming message fails its D1 insert
  (unknown `auth_*` columns) and survives only as an orphan; the old code
  runs fine on a migrated schema, so migrate first.

## Two test suites, don't mix them

- `pnpm vitest run` at the root: the Worker, in the Workers runtime (Miniflare
  provides D1 and R2). 28 files.
- `pnpm --filter web test`: the SPA, in jsdom. 14 files.

`pnpm test` runs both in sequence. `pnpm typecheck` only covers the Worker:
only `pnpm build` typechecks the SPA (`tsc -b`), so a typing error in `web/`
only shows up at build time.

## Interface language

The SPA ships in French and English (`web/src/i18n/`). `fr.ts` is the reference
catalogue; `en.ts` is typed against it, so a missing or extra key fails
`pnpm build`. Every visible string — text, `aria-label`, `title`,
`placeholder` — goes through `useI18n().t`; dates go through
`useI18n().formatDate`. Component tests render with `renderWithI18n`
(`web/src/test/i18n.tsx`), French by default.

API error `message`s are English fallbacks for developers. An error a user must
understand gets a stable `code`, or a `reason` for a validation error raised
from a form (zod `.refine(…, { params: { reason } })`), and its translation in
both catalogues under `errors.codes` / `errors.reasons`. The SPA picks
`reason` → `code` → `message` → HTTP status (`web/src/lib/errors.ts`). Never
rename an existing `code`: it is the contract the SPA relies on.

## Running locally

`pnpm dev` runs `wrangler dev` and the Vite dev server together, with
`DEV_BYPASS_AUTH=1` from `.dev.vars`. The SPA's Vite proxy **hardcodes
`/api` → `http://localhost:8787`** (`web/vite.config.ts`). If port 8787 is
already taken (often a stale `wrangler dev` from an earlier session), Wrangler
silently picks the next port, and the SPA loads fine but shows an empty inbox
because its API calls hit the other process. Check with
`lsof -iTCP:8787 -sTCP:LISTEN -P -n` before assuming a data bug.

Local D1/R2 state lives in `.wrangler/state/v3/`. Apply migrations with
`pnpm wrangler d1 migrations apply cloudmail --local`; inspect or seed data
with `pnpm wrangler d1 execute cloudmail --local --command "…"` (use neutral
example addresses). `wrangler d1 execute` writes to the same files as a
running `wrangler dev`.
