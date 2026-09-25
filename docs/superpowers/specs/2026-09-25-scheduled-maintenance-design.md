# Scheduled maintenance — design

> Status: validated on 2026-09-25, ready for the implementation plan.

## Problem

Two chores are manual today:

- **The trash never empties.** A message moved to the trash stays there, with
  its raw MIME and attachments in R2, until someone purges it by hand.
- **Orphans are silent.** A message whose raw MIME reached R2 but whose D1
  insert failed (see "No received message is ever lost" in AGENTS.md) only
  shows up if someone opens the Maintenance view and runs a scan. Nobody does
  that without a reason, so a lost message goes unnoticed.

The README roadmap lists both under "Scheduled maintenance". This design adds
a daily Cron Trigger that empties old trash and counts orphans, and surfaces
the result in the SPA.

## Decisions

Settled with the user before writing. The implementation does not reopen them.

### Orphans are reported, never re-imported automatically

The scheduled check counts orphans and records the result; the SPA shows it
(Maintenance view, sidebar badge). Re-importing stays a user action through the
existing Maintenance panel. Automatic re-import was rejected: a message would
reappear in the inbox with no explanation, and a `duplicate` orphan would be
retried every night. Log-only was rejected: nobody reads the logs, so the
orphan would stay silent in practice.

### Retention is a Wrangler variable

`TRASH_RETENTION_DAYS` lives in `vars` (default `30` in `wrangler.jsonc`,
overridable through `wrangler.overrides.json`). A settings table and form for a
single number was rejected as a table and an API too many; a hard-coded
constant was rejected because another installation could not change it
without editing code.

### One cron, bounded work per run

Cloudflare's free plan allows **one** Cron Trigger per Worker and 10 ms of CPU
per invocation. Both tasks therefore share one daily trigger, and each task
caps its work per run; what remains is picked up the next night.

### Existing trash gets a full grace period

Messages already in the trash when migration `0004` is applied get
`trashed_at` = the migration time, not their `received_at`. Deploying the
feature therefore never purges anything on its first night; the oldest
existing trash goes N days after the deploy.

## Architecture

### Trigger

`wrangler.jsonc` gains:

```jsonc
"triggers": { "crons": ["17 3 * * *"] }
```

`src/index.ts` exports `scheduled(controller, env, ctx)`, which calls
`ctx.waitUntil(runMaintenance(env, controller.scheduledTime))`.
`runMaintenance` (`src/maintenance/run.ts`) runs the two tasks in sequence,
records the run, and **never throws**: each task catches its own failure, so a
broken purge does not skip the orphan check and vice versa.

### Schema — `migrations/0004_scheduled_maintenance.sql`

```sql
ALTER TABLE messages ADD COLUMN trashed_at INTEGER;
UPDATE messages SET trashed_at = unixepoch() WHERE folder = 'trash';
CREATE INDEX idx_messages_trashed_at ON messages(folder, trashed_at);

CREATE TABLE maintenance_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ran_at INTEGER NOT NULL,          -- seconds, like received_at
  trigger TEXT NOT NULL CHECK (trigger IN ('cron','manual')),
  trash_purged INTEGER,             -- NULL: purge not run (manual check, or disabled)
  trash_failed INTEGER,
  trash_remaining INTEGER,          -- expired messages left for the next run
  orphans_count INTEGER,            -- NULL: check failed
  orphans_complete INTEGER,         -- 0: page cap reached, count is a lower bound
  orphans_sample TEXT,              -- JSON array, first 20 orphan keys
  error TEXT                        -- per-task failure messages, NULL if none
);
```

`trashed_at` is in seconds, like `received_at`.

### Task 1 — trash purge (`src/maintenance/trash.ts`)

- `moveToFolder` (`src/db/mutations.ts`) — the only write path to the trash —
  sets `trashed_at = unixepoch()` when moving **to** `trash` and `NULL` when
  moving **out** of it, in the same batch as the folder change.
- `retentionDays(env)` parses `TRASH_RETENTION_DAYS`: a positive integer is the
  retention; `0`, a missing value or anything unparsable returns `null`
  (purge disabled, logged as `maintenance_trash_disabled` with the raw value).
  An absent or broken value never deletes anything.
- `purgeExpiredTrash(env, now, days)` selects up to `TRASH_PURGE_BATCH = 100`
  ids with `folder = 'trash' AND trashed_at IS NOT NULL AND trashed_at < now − days·86400`,
  oldest first, and calls the existing `purgeMessage` on each, sequentially.
  A failure on one message is logged (`maintenance_purge_failed`, with the
  id) and counted; the loop continues. It then counts the expired messages
  still present (`trash_remaining`).
- It reuses `purgeMessage` unchanged, so the R2-then-D1 order and its replay
  property hold: a failed purge leaves the row, which the next run retries.

### Task 2 — orphan check (`src/maintenance/orphans.ts`)

- `checkOrphans(env)` loops over the existing `listOrphans` with its cursor,
  up to `ORPHAN_CHECK_MAX_PAGES = 20` pages (10 000 objects). It returns
  `{ count, complete, sample }`: `complete = false` when the cap stopped the
  loop with a cursor left, `sample` = the first 20 keys.
- It only lists and counts. It never re-imports, never deletes.

### Recording (`src/maintenance/runs.ts`)

- `recordRun(env, run)` inserts a `maintenance_runs` row, then deletes rows
  beyond the 30 most recent (`MAINTENANCE_RUNS_KEPT = 30`).
- `latestRuns(env)` returns `{ lastRun, lastCheck }`: `lastRun` is the most
  recent `cron` row (what the last night did), `lastCheck` the most recent row
  of either trigger whose orphan check succeeded (`orphans_count IS NOT NULL`).
  Two fields, because a manual check writes a row with empty trash columns
  that must not hide the last purge. If the table does not exist (migration
  not applied), both are `null` instead of throwing.
- Every run also logs one line:
  `{ event: "maintenance", trigger: "cron" | "manual", trashPurged, trashFailed, trashRemaining, orphansCount, orphansComplete, error }`.
  If recording fails, the log line still goes out, with the recording error.

## API

Both routes sit under `/api/admin/*`, behind `requireAccess()`.

- `GET /api/admin/maintenance` →
  `{ retentionDays: number | null, lastRun: MaintenanceRun | null, lastCheck: MaintenanceRun | null }`
  (see `latestRuns`), camelCase fields, `orphansSample` parsed.
- `POST /api/admin/maintenance/orphan-check` → runs **only** task 2, records a
  row with the trash columns `NULL`, returns that row. The purge is never
  triggerable from the UI. The route exists so that the badge is not stale
  after the user re-imports orphans by hand.
- A D1/R2 failure on either route goes through `storageUnavailableResponse`,
  like the existing admin listings.
- `GET /api/config` adds `trashRetentionDays: number | null`, so the trash
  view reads it without calling an admin route.

## Interface

### Maintenance view

A "Scheduled maintenance" card at the top of `MaintenanceSettings`:

- Last scheduled run (`lastRun`): "Never run" when `null`; otherwise its
  date, the trash line ("12 messages deleted", failures and remaining when
  non-zero; nothing when the purge did not run), and its `error` if any.
- Orphans (`lastCheck`): "Storage never checked" when `null`; otherwise
  "None", "3 orphaned messages" or "More than 10 000 (partial check)", with
  the check date; and a **Re-run the check** button calling the POST route.
- Retention in effect: "Trash emptied after 30 days" or "Automatic purge
  disabled".

The existing Orphans panel is unchanged. After a re-import batch that imports
at least one message, the SPA re-runs the check and refreshes the
`["maintenance"]` query.

### Sidebar badge

When `lastCheck.orphansCount` is above zero, a counter appears next to
"Maintenance", with an `aria-label` ("3 orphaned messages detected"). One
query when the app loads, no polling.

### Trash notice

At the top of the trash list: "Messages in the trash are permanently deleted
after 30 days." Hidden when `trashRetentionDays` is `null`.

### i18n

Every string goes through `useI18n().t`, in `fr.ts` and `en.ts`; dates through
`formatDate`. Plurals follow the existing catalogue pattern.

## Error handling

- `scheduled()` never throws; a task failure becomes the row's `error` and a
  log line. The Cron Trigger event is then reported as successful — the
  failure is visible in the Maintenance view, which is where it is looked at.
- Missing migration: `runMaintenance` logs and exits (both tasks fail on
  missing columns/tables); `GET /api/admin/maintenance` returns
  `lastRun: null`.
- A single purge failure never stops the batch, and never touches D1 before
  R2 (it is `purgeMessage`).

## Testing

**Worker (Miniflare, `test/`)**

- `moveToFolder` sets `trashed_at` into the trash and clears it on the way out.
- Purge: a message trashed N+1 days ago is purged; N−1 days ago is kept; a
  message outside the trash is never selected; `trashed_at IS NULL` never
  selected.
- Batch cap: 101 expired messages → 100 purged, `trash_remaining = 1`.
- `retentionDays`: `"30"` → 30; `"0"`, `""`, `"abc"`, `"-5"`, missing → `null`,
  and nothing is purged.
- One `purgeMessage` failure is counted and the others still go.
- Orphan check across several pages; the page cap yields `complete = false`;
  sample capped at 20.
- `recordRun` keeps 30 rows; `latestRuns` separates the last cron run from
  the last successful check, and returns `null`s without the table.
- `scheduled()` through `createScheduledController`: records one run.
- Both routes, including the storage failure path.

**SPA (jsdom, `web/`)**

- Status card: never run, never checked, no orphans, orphans, partial,
  purge disabled,
  re-run button calls the route and refreshes.
- Sidebar badge shown/hidden with the right `aria-label`.
- Trash notice shown with the configured days, hidden when disabled.

## Documentation

- README: the roadmap item becomes a feature section (what runs, when, how to
  change or disable retention); remove it from the roadmap.
- AGENTS.md: `TRASH_RETENTION_DAYS` in the environment table; a
  "Scheduled maintenance" section (one cron, caps, reports never re-imports,
  purge reuses `purgeMessage`); test file counts updated.
- Existing installations must run `pnpm run migrate:remote` before deploying
  (`0004`), as for every migration.

## Out of scope

- Automatic re-import of orphans.
- Purging from the UI on demand, or a retention setting in the UI.
- Notifications (email, push) when orphans are found.
- Checking attachment objects (`att/`) for orphans.
