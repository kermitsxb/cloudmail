# Cloudmail — project instructions

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

## Two test suites, don't mix them

- `pnpm vitest run` at the root: the Worker, in the Workers runtime (Miniflare
  provides D1 and R2). 18 files.
- `pnpm --filter web test`: the SPA, in jsdom. 7 files.

`pnpm test` runs both in sequence. `pnpm typecheck` only covers the Worker:
only `pnpm build` typechecks the SPA (`tsc -b`), so a typing error in `web/`
only shows up at build time.

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
its input/output shell.

## Deployment

`pnpm run deploy`, not `pnpm deploy`: in a pnpm workspace, `deploy` is a
native pnpm command that shadows the script and fails with
`ERR_PNPM_NOTHING_TO_DEPLOY` without running anything.

## Invariant of the `email()` handler

`src/email.ts` must never call `setReject()` — a rejection would bounce back
to the sender. A forwarding failure must never prevent archiving, and the
forward happens before reading `message.raw`, which is a single-use
`ReadableStream`. See the "Architecture" section of the README.
