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
  attachments, raw MIME, identities, forwarding rules and destinations, config.
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
README's "R2 ↔ D1 reconciliation" section is the manual procedure to find them;
**no admin route is shipped, deliberately** — a route that lists or replays
message content deserves its own design and review cycle.

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

### Purge order: R2 first, then D1

`purgeMessage` (`src/db/mutations.ts`) deletes R2 objects, then the D1 row. R2
deletes are idempotent, so an interrupted purge is replayed to completion using
the still-present D1 row as its address. The reverse order was tried and
rejected: once the row is gone, `raw_key`/`r2_key` go with it and an R2 failure
leaves unrecoverable orphans of sensitive content. The residue of the chosen
order (a row pointing to deleted objects) is visible — 404 on the attachment or
raw — and repairable by re-running the purge.

Deletion is two-step in the UI: `PATCH /api/messages/:id` with `folder:
"trash"` moves to trash (restoring picks `inbox` or `sent` from the message
direction); `DELETE /api/messages/:id` purges permanently.

### Migrations are immutable once applied

D1 records applied migrations by name, so editing an applied migration is never
replayed and the database silently keeps the old schema. Any schema change goes
through a new `migrations/000N_*.sql`. A local database in that state is reset
with `rm -rf .wrangler/state/v3/d1 .wrangler/state/v3/r2` then
`pnpm wrangler d1 migrations apply cloudmail --local`.

## Raw MIME storage

The raw MIME key is content-addressed: `raw/<sha256-of-content>.eml` — no
timestamp, no message ID; two byte-identical messages share a key. The D1
`messages` row is the **only** known address of that object: there is no
reverse index, and `wrangler r2 object` has no listing subcommand (only `get`,
`put`, `delete` in wrangler 4.x). Listing `raw/` requires R2's S3-compatible API.

## Replaying a message (`reparse`)

`reparse(env, rawKey, envelopeFrom)` in `src/email.ts` re-reads a stored raw
MIME, re-parses it, deletes the existing D1 row (decrementing the thread's
counters) and calls `storeIncoming` as if the message had just arrived. It also
works on an orphan (no row to delete). Use it after a parser fix.

- **It does not replay forwarding** — external recipients already got their
  copy; re-forwarding would send a duplicate.
- **It has no entry point**: no route, script or command calls it. To use it,
  add a temporary authenticated route in `src/api/routes.ts` (through
  `requireAccess()`), run `pnpm wrangler dev --remote` so it hits the real
  remote D1/R2 rather than Miniflare, trigger it, then **remove the route
  before committing**. Never deploy such a route: it's a destructive
  delete-then-reinsert with no safeguard beyond generic Access auth.
- **Known limitation**: if the replayed message was alone in its thread,
  `storeIncoming` creates a new thread (threading uses the normalized subject
  and reference headers, not the old `thread_id`) and the old, now-empty
  thread is left orphaned in D1. Clean up by hand.

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
  deploying a version with a new migration.** Skipping it breaks nothing
  visibly: e.g. without `forward_rules`, `GET /api/forwarding/rules` returns
  500 and incoming mail logs `forward_rules_failed`, archived but never
  forwarded.

## Two test suites, don't mix them

- `pnpm vitest run` at the root: the Worker, in the Workers runtime (Miniflare
  provides D1 and R2). 20 files.
- `pnpm --filter web test`: the SPA, in jsdom. 8 files.

`pnpm test` runs both in sequence. `pnpm typecheck` only covers the Worker:
only `pnpm build` typechecks the SPA (`tsc -b`), so a typing error in `web/`
only shows up at build time.

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
