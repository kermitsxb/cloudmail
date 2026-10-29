# Message delete button — implementation plan

Spec: none written; the behaviour below was chosen by the user ("option A") after
the diagnosis summarised in Context. Rulings made without a spec are provisional.

## Context (diagnosis)

- `PATCH /api/messages/:id {folder:"trash"}` works server-side (verified locally:
  200, thread leaves the inbox list, appears in the trash list).
- `GET /api/threads/:id` (`getThread`, `src/db/queries.ts`) returns **every**
  message of the thread, including those in the trash, each with its `folder`.
  `ThreadView` renders them all, so after "Supprimer" the open conversation looks
  unchanged: the user thinks the button does nothing.
- In the trash folder the same button sends `folder:"trash"` again, which is a
  no-op. `DELETE /api/messages/:id` (permanent purge, `purgeMessage`) exists but
  no SPA button calls it.
- `updateMessage.error` is never displayed, so a failure (e.g. `409
  purge_in_progress`) is silent.

## Global Constraints

- SPA only (`web/`). Do not change the Worker (`src/`), its API or migrations.
- Every visible string — text, `aria-label`, `title` — goes through
  `useI18n().t`. Add new keys to `web/src/i18n/fr.ts` (reference) **and**
  `web/src/i18n/en.ts`; `en.ts` is typed against `fr.ts`.
- Errors are displayed with `errorText(error, t)` (`web/src/lib/errors.ts`) in a
  `role="alert"` element, like the existing re-import error.
- Never use `window.confirm` / `alert`: confirmation is inline in the page.
- Restoring a message from the trash sends `folder: "sent"` when
  `message.direction === "out"`, `"inbox"` otherwise (see comment in
  `useUpdateMessage`, `web/src/api/client.ts`).
- Match surrounding code: comments in French, Tailwind classes like the existing
  action buttons, tests in French with `renderWithI18n`.
- TDD: failing tests first, then code.
- Tests: `pnpm --filter web test`; types: `pnpm --filter web build` (runs `tsc -b`).

## Task 1: Make delete, restore and permanent delete visible and working in the thread view

Files:
- `web/src/api/client.ts` — add `useDeleteMessage()`: `useMutation` calling
  `api<{ ok: true }>(\`/messages/${id}\`, { method: "DELETE" })`, invalidating
  `["threads"]` and `["thread"]` in `onSettled` (same as `useUpdateMessage`).
- `web/src/components/ThreadView.tsx`:
  - `ThreadView` takes two new props: `folder: string` (the folder currently
    shown) and `onClose: () => void`.
  - Visible messages: in `folder === "trash"`, only messages whose
    `folder === "trash"`; in any other folder, only messages whose
    `folder !== "trash"`. The header count (`messageCount`) counts visible
    messages. The default open message is the last **visible** one.
  - Outside the trash, the action row keeps "Supprimer" (moves to trash).
  - In the trash, the action row shows "Restaurer" (moves back per the
    direction rule) and "Supprimer définitivement". Clicking the latter does not
    delete yet: it replaces itself with an inline confirmation — a short text
    plus "Confirmer" and "Annuler" buttons; "Confirmer" calls `DELETE`.
  - When a move-to-trash, restore or permanent delete **succeeds** on the last
    visible message of the thread, call `onClose()` (the conversation would
    otherwise be empty, or 404 after a purge).
  - A failed move (trash/restore) and a failed permanent delete each display
    their error in a `role="alert"` paragraph under the action row, translated
    via `errorText` (so `409 purge_in_progress` shows the existing
    `errors.codes.purge_in_progress` text). Use `t.common.deleteFailed` for
    trash/permanent-delete failures and a new key for restore failures.
  - Use a separate `useUpdateMessage()` instance for moves so the "mark unread"
    mutation does not share its error state.
- `web/src/App.tsx` — pass `folder` and
  `onClose={() => navigate({ folder, threadId: null })}` to `ThreadView`.
- `web/src/i18n/fr.ts`, `web/src/i18n/en.ts` — new keys under `threadView`:
  restore ("Restaurer" / "Restore"), permanent delete ("Supprimer
  définitivement" / "Delete permanently"), confirmation text ("Supprimer
  définitivement ce message ? Cette action est irréversible." / "Permanently
  delete this message? This cannot be undone."), confirm ("Confirmer" /
  "Confirm"), restore failure (`(detail) => "Restauration impossible : …"` /
  `"Could not restore: …"`). Reuse `common.cancel`.

Tests (`web/src/components/ThreadView.test.tsx`, existing render helper
extended with `folder`/`onClose`; existing tests must keep passing with
`folder: "inbox"`):
1. Inbox: a message whose `folder` is `"trash"` is not rendered; count reflects
   visible messages.
2. Inbox: clicking "Supprimer" sends `PATCH /api/messages/<id>` with
   `folder: "trash"`; when it was the only visible message, `onClose` is called.
3. Inbox: when the PATCH fails (e.g. 409 `purge_in_progress`), an alert shows
   the translated reason and `onClose` is not called.
4. Trash: only trashed messages are shown; "Supprimer" is replaced by
   "Restaurer" and "Supprimer définitivement".
5. Trash: "Restaurer" sends `folder: "inbox"` for `direction: "in"` and
   `folder: "sent"` for `direction: "out"`.
6. Trash: "Supprimer définitivement" sends nothing until "Confirmer" is
   clicked; "Annuler" dismisses without request; "Confirmer" sends
   `DELETE /api/messages/<id>` and calls `onClose` when it was the last one.
7. Trash: a failed DELETE shows an alert.

`web/src/App.test.tsx` must keep passing.
