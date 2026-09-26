# Message authentication and Spam folder — design

> Status: validated on 2026-09-26, ready for the implementation plan.
> Issue: #26.

## Problem

Cloudmail shows every received message the same way, whether or not its
sender could be authenticated. A message that claims to come from a bank
domain but fails DMARC lands in the inbox next to genuine mail, with nothing
to tell them apart. There is also no Spam folder, which #8 (Block senders)
depends on.

## What Cloudflare already gives us

Checked on a real installation (a message received from Gmail on
2026-09-15). Cloudflare's MX adds, at the top of the message delivered to the
Worker:

```
Received-SPF: pass (mx.cloudflare.net: domain of … designates … as permitted sender) …
Authentication-Results: mx.cloudflare.net;
	dkim=pass header.d=gmail.com header.s=20251104 header.b=…;
	dmarc=pass header.from=gmail.com policy.dmarc=none;
	spf=none (mx.cloudflare.net: no SPF records found for postmaster@…) smtp.helo=…;
	spf=pass (mx.cloudflare.net: domain of … designates … as permitted sender) smtp.mailfrom=…
X-CF-SpamH-Score: 0
```

This contradicts cloudflare/workerd#6740, which reports these headers
missing; only one message was sampled, so parsing must tolerate their
absence.

Email Routing already **rejects** mail that fails both SPF and DKIM, and mail
that fails DMARC under a `quarantine` or `reject` policy
(developers.cloudflare.com/email-routing/postmaster). What reaches the Worker
is the grey zone: DMARC failing under `p=none`, DKIM failing with SPF
passing, domains with no DMARC policy at all.

## Decisions

Settled with the user before writing. The implementation does not reopen them.

### Only a DMARC failure files a message as spam

`dmarc=fail` → folder `spam`, whatever the sender's policy. It is the strict
"likely spoofed" case, deterministic and explainable. Weaker failures (DKIM
or SPF failing without a DMARC failure) show a warning but keep the message
in the inbox. `X-CF-SpamH-Score` is stored but not used: Cloudflare does not
document its scale.

### Spam is purged like the trash

Spam messages are purged after `TRASH_RETENTION_DAYS` by the same nightly
task, through `purgeMessage`. No separate retention variable.

### Forwarding is unchanged

Every matching rule still forwards, spam included, before the message is
classified. The external mailbox runs its own checks, and forwarding stays
independent of archiving (AGENTS.md, "Forwarding is isolated from
archiving"). An `X-Cloudmail-Spam` header on forwards can come later without
a migration.

### Manual actions in both directions

"Report as spam" moves an incoming message to `spam`; "Not spam" moves it to
`inbox`. Both are the existing `PATCH /api/messages/:id` through
`moveToFolder`. Reporting teaches nothing about the sender — that is #8.
The verdict describes the message, not its folder: a message moved back to
the inbox keeps its warning.

### `spam` is a real folder value

A virtual folder (`is_spam` flag next to `folder`) was rejected: every
folder query, `moveToFolder`, the thread counters, the purge and trash
restore would have to combine two notions of "where is this message", and
#8 would inherit that. The cost of the real folder is a table rebuild (see
below), which is one-off and testable.

## Schema — `migrations/0006_message_authentication.sql`

### Columns

`messages` gains, all nullable:

| Column | Content |
| --- | --- |
| `auth_spf` | `pass`, `fail`, `softfail`, `neutral`, `none`, `temperror`, `permerror` |
| `auth_dkim` | same set |
| `auth_dmarc` | same set |
| `spam_score` | integer from `X-CF-SpamH-Score` |

`NULL` means no trusted verdict: sent messages, messages received before
`0006`, unparseable messages, messages without a Cloudflare header.

`folder`'s `CHECK` becomes `IN ('inbox','sent','trash','spam')`.

`trashed_at` keeps its name and widens its meaning: the time the message
entered **the trash or Spam**, start of the retention clock. The migration
comment and AGENTS.md say so.

### Why a plain rebuild would destroy data

A `CHECK` cannot be altered in SQLite, so `messages` must be rebuilt. D1
enforces foreign keys and does not let a migration turn them off. Two
consequences, both verified on a local D1 on 2026-09-26:

- `DROP TABLE messages` performs an implicit `DELETE`, which fires
  `ON DELETE CASCADE`: the usual "create new, copy, drop old, rename" wipes
  every row of `recipients` and `attachments`.
- `ALTER TABLE … RENAME` rewrites the foreign keys of child tables to follow
  the renamed table: `REFERENCES messages_new` becomes `REFERENCES
  messages` once `messages_new` is renamed.

### Migration steps

In one migration file (D1 applies it atomically):

1. Create `messages_new` (full current schema + `trashed_at` + the four new
   columns + the new `CHECK`), `recipients_new` and `attachments_new` with
   `REFERENCES messages_new(id) ON DELETE CASCADE`.
2. Copy all three tables with explicit column lists, keeping `id`. New
   columns are `NULL`.
3. `DROP TABLE recipients; DROP TABLE attachments; DROP TABLE messages;` —
   children first, so dropping `messages` cascades into nothing. The three
   FTS triggers go with `messages`.
4. Rename `messages_new` → `messages`, `recipients_new` → `recipients`,
   `attachments_new` → `attachments`.
5. Recreate every index: `idx_messages_folder`, `idx_messages_thread`,
   `idx_messages_in_reply_to`, `idx_messages_raw_key`,
   `idx_messages_trashed_at`, `idx_recipients_message`,
   `idx_recipients_address`, `idx_attachments_message`.
6. Recreate the `messages_ai`, `messages_ad`, `messages_au` triggers
   verbatim from `0001`.

`messages_fts` is not touched: it is an external-content table keyed on
`rowid`, and ids are preserved, so the index stays valid. `purge_claims` has
no foreign key and is unaffected.

## Reading verdicts (`src/ingest/auth.ts`)

A pure function:

```ts
export type AuthVerdict = "pass" | "fail" | "softfail" | "neutral" | "none" | "temperror" | "permerror";
export type AuthResults = {
  spf: AuthVerdict | null;
  dkim: AuthVerdict | null;
  dmarc: AuthVerdict | null;
  spamScore: number | null;
};
export function parseAuthentication(headers: { key: string; value: string }[]): AuthResults;
```

`headers` is postal-mime's `email.headers`: ordered top to bottom, keys
lowercased.

### Trust rule

An MTA prepends its headers, so Cloudflare's is above anything the sender
wrote. Only the **first** `authentication-results` header is read, and only
if its authserv-id (the token before the first `;`) is exactly
`mx.cloudflare.net`. Otherwise all three verdicts are `NULL`. A sender who
adds `Authentication-Results: mx.cloudflare.net; dmarc=pass` ends up below
Cloudflare's and is ignored.

### Extraction

- Parenthesised comments are removed first (they contain `;` and `=`); the
  rest is split on `;` into `method=result` clauses with their properties.
- `dmarc`: the first `dmarc=` result.
- `spf`: the result whose clause carries `smtp.mailfrom=`, else the first
  `spf=` result.
- `dkim`: `pass` if any `dkim=` result is `pass`, else the first one.
- Results are lowercased; anything outside `AuthVerdict` becomes `NULL`.
- `spamScore`: the first `x-cf-spamh-score` header if it is an integer,
  else `NULL`.

### Wiring

- `ParsedMessage` gains `auth: AuthResults`; `parseEmail` fills it from
  `email.headers`; `fallback()` sets all four to `NULL`.
- `parsedColumns` returns `authSpf`, `authDkim`, `authDmarc`, `spamScore`,
  so `storeIncoming` and `reparseInPlace` write the same values.
- `storeIncoming` picks `folder = auth.dmarc === "fail" ? "spam" : "inbox"`.
  For a spam arrival it sets `trashed_at = unixepoch()` and does **not**
  increment the thread counters.

### Re-import

- An orphan goes through `storeIncoming` and is classified like new mail.
- `reparseInPlace` rewrites the four columns (they are parse-derived) and
  never `folder` (AGENTS.md, "Re-importing a message"). An old message gets
  its warning by being re-imported, without moving.

Threading is unchanged: a spam message whose `In-Reply-To` matches an
existing thread joins it, shows its warning in the thread view, and does not
count in the thread counters.

## Counters and purge

Spam joins the trash as a folder **outside the counters**: `message_count`
and `unread_count` count messages not in `trash` or `spam`. One helper
(e.g. `countsInThread(folder)`) replaces the `folder !== "trash"` /
`wasTrash`-`goingToTrash` tests in:

- `setRead`: a spam read/unread toggle leaves `unread_count` alone;
- `moveToFolder`: counters move only when crossing between counted and
  uncounted folders (inbox↔spam moves them, trash↔spam does not);
  `trashed_at` is set on entering `trash` or `spam` and cleared otherwise —
  including trash→spam, which restarts the clock;
- `purgeMessage`: the decrement branch.

`purgeExpiredTrash` and `purgeMessage`'s eligibility check use
`folder IN ('trash','spam')`. `maintenance_runs.trash_purged` and the API's
`trashPurged` keep their names and count spam too.

## API

- `folder` accepts `"spam"` in both zod schemas of `src/api/routes.ts`
  (thread list query, message `PATCH`).
- `getThread` exposes, per message, `auth: { spf, dkim, dmarc } | null`
  (`null` when all three are `NULL`). `spamScore` is not exposed.
- No new route, no new error code.

## Interface

- **Sidebar**: `FOLDERS` becomes `inbox`, `sent`, `spam`, `trash`.
- **Spam notice**: like `TrashNotice`, "Messages in Spam are deleted after N
  days", hidden when the purge is disabled.
- **Banner in an open message**, alongside the parse-error and truncated
  banners:
  - `dmarc = fail`: destructive banner — likely spoofing, the message claims
    to come from `<From domain>` but fails DMARC. Shown in any folder.
  - otherwise `spf` or `dkim` in `fail`/`softfail`: neutral banner —
    partial authentication, with which check failed.
  - all `pass`, or no verdict: no banner.
- **Verdict line** in the expanded message header, "SPF pass · DKIM pass ·
  DMARC pass", only when `auth` is not `null`.
- **Actions**: "Report as spam" on an incoming message outside Spam; "Not
  spam" on a message in Spam. None on sent messages.
- **Thread list**: no badge in this version.
- **i18n**: every string in `fr.ts` and `en.ts` (`sidebar.spam`, the notice,
  both banners, the verdict line, both actions).

## Error handling

- Missing, malformed or untrusted headers produce `NULL` verdicts, never an
  exception: `parseAuthentication` does not throw, and a failure in it must
  not cost the message (it runs inside `parseEmail`, after the R2 write).
- No `setReject()`, ever: spam is received and archived, only filed away.
- Without `0006`, the ingestion `INSERT` references unknown columns and
  fails; the mail survives only as an orphan. Hence the deploy order below.

## Testing

Worker (`pnpm vitest run`):

- `test/ingest/auth.test.ts`: the real header above; first-header rule; a
  forged `mx.cloudflare.net` header below a genuine one; a first header from
  another authserv-id; two `spf=` clauses; several `dkim=` results;
  comments containing `;`; unknown results; missing headers; non-integer
  score.
- Migration test: apply `0001`–`0005`, seed messages (inbox, sent, trash
  with `trashed_at`), recipients, attachments, a purge claim; apply `0006`;
  check row counts, child links, an FTS search hit, cascade on delete,
  `folder = 'spam'` accepted and `folder = 'junk'` refused.
- `storeIncoming`: DMARC fail → `spam`, `trashed_at` set, counters
  unchanged; DMARC pass → `inbox`; columns stored.
- `moveToFolder` / `setRead` / `purgeMessage`: counters across inbox, spam,
  trash; `trashed_at` on each transition.
- Scheduled purge: an expired spam message is purged, a recent one is not.
- Re-import: a re-parse fills the columns and keeps `folder`.
- API: `folder=spam` on list and `PATCH`; `auth` in thread detail.

SPA (`pnpm --filter web test`): Spam in the sidebar; both banners and none;
verdict line; action buttons per folder and direction; spam notice.

## Documentation

- `AGENTS.md`: the trust rule; `spam` as a folder outside the counters;
  widened meaning of `trashed_at`; the rebuild trap (children first); `0006`
  in the migrate-before-deploy list.
- `README.md`: feature section, Operations note on `0006`, remove the
  roadmap entry (the roadmap becomes empty — drop the section or point to
  the issues).

## Deployment

`0006` must be applied (`pnpm run migrate:remote`) **before** deploying:
the new ingestion code writes columns that do not exist before it, so mail
received in between would only survive as orphans. Conversely, the old code
runs fine on the migrated schema (it never writes the new columns or
`spam`), so migrating first is safe.

## Out of scope

- Using `X-CF-SpamH-Score` to classify.
- Blocking senders, learning from "Report as spam" (#8).
- Re-verifying DKIM/SPF inside the Worker.
- A badge in the thread list, a spam counter in the sidebar.
- Tagging forwards of spam (`X-Cloudmail-Spam`).
- Bulk re-classification of messages received before `0006`.
