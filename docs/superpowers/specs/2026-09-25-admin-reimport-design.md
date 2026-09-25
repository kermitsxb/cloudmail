# Admin re-import entry point — design

> Status: validated on 2026-09-25, ready for the implementation plan.

## Problem

Two situations need a stored raw MIME to be turned back into a message in the
app:

- **Orphans.** Every incoming message is written to R2 before anything else.
  When a later step fails (D1 insert rejected, unmigrated database, ingestion
  bug), the message survives as a `raw/<sha256>.eml` object with no `messages`
  row. Today these are found with a manual procedure (S3-compatible API listing
  diffed with `comm` against a D1 export) and replayed through a temporary route.
- **Parser fixes.** After a fix in `src/ingest/`, messages already stored with
  `parse_error = 1` should be re-parsed from their raw MIME.

`reparse()` in `src/email.ts` does the replay, but it has no entry point: using
it means adding a temporary route, running `wrangler dev --remote`, and removing
the route before committing. AGENTS.md states that a route listing or replaying
message content needs its own design and review cycle. This is that design.

## Decisions

These were settled with the user before writing. Each one closes a credible
alternative; the implementation does not reopen them.

### Covers both orphans and existing messages

One tool finds orphans automatically and re-parses existing messages. Two
separate tools would duplicate the replay logic, and the two cases differ only
in whether a row already exists for the key.

### Deployed routes plus a settings view

The entry point ships: authenticated API routes behind `requireAccess()` and a
**Maintenance** view in the SPA. A local-only script would keep the "never
deploy" stance but be unusable without a terminal and unable to back the
planned scheduled orphan check. This reverses the current AGENTS.md rule
("Never deploy such a route"); the safeguards below replace it.

### Re-parse keeps folder, read state and thread

Re-parsing an existing message replaces only what comes from the parse:
headers, bodies, recipients, attachments. It keeps `id`, `folder`, `is_read`
and `thread_id`. Consequences: thread counters never move, no thread is ever
emptied by a re-parse, and the message keeps its identity in the UI.

Re-threading on re-parse (useful only if a parser fix changed `References`
handling) was rejected: it reintroduces empty-thread cleanup for a rare case.

### Selection: per message, plus a parse-errors bulk filter

Existing messages are re-parsed either one at a time (a **Re-import** action on
an incoming message) or in bulk through a single filter: incoming messages with
`parse_error = 1`. Bulk re-parse of every message or of a date range is out of
scope (YAGNI): it rewrites every row and attachment and strains the Worker's
subrequest budget for no identified need.

### Synchronous, SPA-driven small batches

Listing is paged; replay takes at most 10 keys per request; the SPA loops and
shows progress. Cloudflare Queues and Workflows were rejected: each adds a
binding and a setup step for every installation, for a personal mailbox whose
volumes fit comfortably in synchronous batches.

### In-place update instead of delete-then-reinsert

PR #21 made `reparse` keep folder and read state and drop the emptied thread,
but it still deletes the row and re-inserts it through `storeIncoming`. This
design replaces that with an in-place update in a single atomic D1 batch:

- a failure leaves the message untouched, instead of deleted with the insert
  not yet done;
- `id` and `thread_id` are preserved without any thread bookkeeping;
- it fixes a duplication bug that #21 still has (next section).

## The duplication bug

`parseEmail` invents `<uuid@cloudmail.local>` when a message has no
`Message-ID` or cannot be parsed. `reparse` looks up the existing row by the
**freshly parsed** `message_id`, which for these messages is a new random
value: the old row is not found, not deleted, and `storeIncoming` inserts a
second copy next to it. The messages most likely to be re-parsed (those with
`parse_error = 1`) are exactly the ones affected.

The fix: existing rows are found by `raw_key` (the content address), and an
invented ID never overwrites a row's existing `message_id`.

## Components

### Migration `0003_raw_key_index.sql`

```sql
CREATE INDEX idx_messages_raw_key ON messages(raw_key);
```

Both orphan detection and replay dispatch look rows up by `raw_key`. It is a
schema change: existing installations run `pnpm run migrate:remote` before
deploying.

### `parseEmail` (`src/ingest/parse.ts`)

`ParsedMessage` gains `messageIdSynthetic: boolean`, `true` whenever the
`messageId` was generated (fallback path, or no `Message-ID` header).

### `src/admin/reimport.ts` (new)

All the logic; routes stay thin.

- `listOrphans(env, cursor?)` →
  `{ orphans: { key: string; size: number; uploaded: string }[]; cursor: string | null }`
- `listParseErrors(env, cursor?)` →
  `{ messages: { id: number; rawKey: string; subject: string | null; receivedAt: number }[]; cursor: string | null }`
- `reimportKey(env, rawKey, by)` → `ReimportResult`:

```ts
type ReimportResult =
  | { key: string; outcome: "imported"; messageIds: number[] }
  | { key: string; outcome: "reparsed"; messageIds: number[] }
  | { key: string; outcome: "duplicate"; messageIds: number[] }
  | { key: string; outcome: "not_found" }
  | { key: string; outcome: "error"; error: string };
```

Dispatch in `reimportKey`:

| State | Action | Outcome |
| --- | --- | --- |
| No R2 object at `rawKey` | nothing | `not_found` |
| Object, no incoming row with this `raw_key` | `storeIncoming` | `imported` |
| Same, but its `Message-ID` already belongs to another row | nothing (`storeIncoming` reports a duplicate) | `duplicate`, with that row's id |
| Object, one or more incoming rows | in-place re-parse of each row | `reparsed` |
| Any exception | caught, logged | `error` |

`duplicate` covers a real case: the same message delivered twice with
different bytes (e.g. different `Received` headers) has two raw keys but one
`Message-ID`. The second copy is an orphan that importing cannot resolve; it
is reported as such rather than as an error or a false `imported`, and keeps
appearing in scans.

`reparse()` is removed from `src/email.ts`; `reimportKey` replaces it.

### Routes (`src/api/routes.ts`)

All behind `requireAccess()`, like the rest of `/api/*`.

- `GET /api/admin/orphans?cursor=`
- `GET /api/admin/parse-errors?cursor=`
- `POST /api/admin/reimport` with body `{ keys: string[] }`, 1 to 10 keys, each
  matching `^raw/[0-9a-f]{64}\.eml$`. Duplicates in the list are collapsed.

### SPA

- `MaintenanceSettings` view, reached from the sidebar next to Forwarding and
  Identities (`view === "maintenance"` in `App.tsx`), with two panels:
  - **Orphaned messages**: a *Scan* button pages through
    `GET /api/admin/orphans` until the cursor is exhausted, accumulating
    results; each orphan shows key, size and date with a checkbox; *Re-import
    selected* sends batches of 10 and shows a per-key result.
  - **Parse errors**: lists messages with `parse_error = 1` (subject, date);
    *Re-import all* sends their raw keys in batches of 10 and shows progress
    and per-key results.
- A **Re-import** action in `ThreadView` on incoming messages only (outgoing
  messages have a `sent/…` key with no R2 object). It sends that message's
  `raw_key` and refreshes the thread. `MessageDetail` (`src/db/queries.ts`
  and its SPA mirror) gains `rawKey` for this.
- `web/src/api/client.ts` gains the three calls and their hooks.

## Data flow

### Orphan scan

1. `env.MAIL.list({ prefix: "raw/", limit: 500, cursor })`.
2. One D1 query for the page:
   `SELECT DISTINCT raw_key FROM messages WHERE raw_key IN (SELECT value FROM json_each(?))`,
   the page's keys bound as a single JSON array (sidesteps D1's 100 bound
   parameters limit).
3. Return the keys absent from the result, with `size` and `uploaded`, and R2's
   cursor (`null` when `truncated` is false). An empty page with a non-null
   cursor is normal; the SPA keeps paging.

### Parse-errors listing

Pages of 50, keyset pagination on `id DESC`, filter
`direction = 'in' AND parse_error = 1`. The cursor is the last `id`.

### In-place re-parse

For a key with existing rows (`SELECT … FROM messages WHERE raw_key = ? AND direction = 'in'`):

1. Read the raw MIME from R2 once for all rows.
2. For each row, parse with the row's `from_addr` as envelope sender.
3. `newMessageId = parsed.messageIdSynthetic ? row.message_id : parsed.messageId`.
   Likewise, an invented date (`parsed.dateSynthetic`) never overwrites the
   row's stored `received_at`: a new parsing would invent another one (the
   current instant), re-dating the message and bumping its thread on every
   re-import.
4. **R2 first**: write the new attachments to
   `att/<safeKey(newMessageId)>/<i>-<sanitizeFilename(name)>`.
5. **Then one D1 batch**:
   - `UPDATE messages SET message_id, in_reply_to, from_addr, from_name,
     subject, text_body, html_body, snippet, received_at, has_attachments,
     parse_error, body_truncated WHERE id = ?`, with bodies bounded by
     `truncateBody` as in `storeIncoming`; the `messages_au` trigger keeps FTS
     in sync;
   - `DELETE FROM recipients WHERE message_id = ?`, then the new recipients;
   - `DELETE FROM attachments WHERE message_id = ?`, then the new attachments;
   - `UPDATE threads SET last_message_at = (SELECT MAX(received_at) FROM
     messages WHERE thread_id = ?) WHERE id = ?`.
   - Never written: `id`, `thread_id`, `folder`, `is_read`, `direction`,
     `raw_key`. Thread counters are therefore unchanged.
6. **After commit**: delete old attachment keys absent from the new set.
7. **If the batch fails**: delete new attachment keys absent from the old set
   (best effort, failures logged). A key present in both sets was overwritten
   with bytes derived from the same raw MIME, so nothing is lost.

Several rows can share one `raw_key` only when byte-identical copies of a
message without `Message-ID` were delivered: each got its own invented ID,
which step 3 keeps, so their attachment prefixes stay distinct.

The body-bounding and attachment-writing code shared with `storeIncoming` is
extracted rather than duplicated.

### Orphan import

`storeIncoming(env, raw, { from: "unknown@invalid", to: "" })`. Its R2 write is
a no-op (content-addressed key, object already present). The `From` header wins
over the envelope; the placeholder only shows when parsing fails entirely.
`.invalid` is the TLD reserved for this by RFC 2606. The message lands as new
mail: inbox, unread, normal thread resolution.

### What a replay never does

Forward the message, read or write `forward_rules`, or delete a raw MIME object.

## Error handling

- `POST /api/admin/reimport` answers **200 with one result per key**, even when
  some fail: one bad message never masks nine good ones. 400 only for a
  malformed request (empty list, more than 10 keys, a key not matching the
  pattern).
- A new `message_id` that collides with another row (UNIQUE constraint) fails
  the batch: nothing changes, step 7 runs, and the result is
  `error` with a message naming the conflicting message id.
- An R2 or D1 failure during a listing returns 503 with a clear French message
  (the UI is French-only); the SPA shows it and offers to resume from the last
  cursor.
- Every operation is idempotent: re-importing an already-imported orphan
  re-parses it; re-parsing twice yields the same row.

## Safety

- Same authentication as the rest of the API (`requireAccess()`); Cloudmail has
  a single allow-list, so no separate admin role.
- The key pattern confines the endpoint to incoming raw MIME objects: no
  `sent/…`, no `att/…`, no path traversal.
- Nothing is deleted except attachment objects replaced by a re-parse. Raw MIME
  is never deleted.
- No route returns message content: the orphan scan returns keys, sizes and
  dates. Reading an orphan means importing it, after which it shows in the
  normal UI.
- One JSON log line per key:
  `{ event: "reimport", key, outcome, messageIds, error?, by: identity.email }`.

## Tests

Worker, `test/admin/reimport.test.ts` (Miniflare):

- orphan scan across several R2 pages, with known and unknown keys mixed;
- orphan import lands in inbox, unread;
- in-place re-parse keeps `id`, `folder`, `is_read`, `thread_id` and thread
  counters, including for a trashed message;
- a message with an invented ID is re-parsed without creating a duplicate
  (regression test for the duplication bug);
- two rows sharing one `raw_key`;
- replaced attachments deleted after commit; new ones cleaned up after a
  `message_id` collision, with the row unchanged;
- `not_found` for a missing object;
- no `forward()` call, `forward_rules` untouched;
- route validation: empty list, 11 keys, `sent/…` key, malformed key; 200 with
  mixed per-key outcomes.

The `reparse` tests in `test/email-handler.test.ts` (including those added by
PR #21) move to the new file, adapted to `reimportKey`.

SPA:

- `MaintenanceSettings.test.tsx`: scan paging until cursor exhaustion,
  selection, batches of 10, per-key results, error display and resume;
- `ThreadView.test.tsx`: the Re-import action shows on incoming messages only.

## Documentation

- **AGENTS.md**: replace "Replaying a message (`reparse`)" with the admin
  entry point and its invariants (in-place update, kept state, no forwarding,
  key pattern); correct "Listing `raw/` requires R2's S3-compatible API" (true
  of wrangler, not of the binding); remove "no admin route is shipped,
  deliberately" and the "never deploy such a route" rule; add
  `src/admin/reimport.ts` to the architecture section.
- **README.md**: replace the manual procedures in "Checking that no mail was
  lost" and "Re-importing a message" with the Maintenance view, keeping the
  `comm` procedure as a fallback for when the Worker itself is broken; remove
  the roadmap item; note that the release carries a migration.

## Out of scope

- Bulk re-parse of every message or of a date range.
- Re-threading on re-parse.
- The scheduled orphan check (separate roadmap item). It will reuse
  `listOrphans`.
- Detecting the reverse residue (D1 rows whose raw object is missing, left by
  an interrupted purge).
