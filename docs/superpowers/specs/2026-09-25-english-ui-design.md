# English interface — design

> Status: validated on 2026-09-25, ready for the implementation plan.

## Problem

The SPA is French-only. Cloudmail is open source and meant to be cloned and
deployed by other people, most of whom won't read French. French is not
confined to the SPA's own strings:

- about 160 visible strings across `web/src/App.tsx`, the components in
  `web/src/components/`, `web/src/lib/reimport.ts` and `web/src/api/client.ts`;
- three dates formatted with a hard-coded `"fr-FR"` locale (`ThreadList`,
  `ThreadView`, `MaintenanceSettings`) and `<html lang="fr">` in
  `web/index.html`;
- every API error `message` written by the Worker (`src/api/routes.ts`,
  `src/auth/access.ts`, `src/send/client.ts`), which the SPA displays verbatim
  through `ApiError.message`.

Nothing the SPA writes ends up in outgoing mail (the reply prefix is `Re:`,
there is no quoted "On … wrote:" line), so the change is purely presentational.

## Decisions

Settled with the user before writing. The implementation does not reopen them.

### Browser language by default, plus a remembered selector

The language follows the browser; a selector lets the user override it and the
choice is remembered in `localStorage`. A per-installation setting
(`UI_LANGUAGE` served by `/api/config`) was rejected: it forces one language on
everyone reaching the deployment and adds configuration for no gain. Replacing
French with English outright was rejected: the current user reads French.

### The SPA translates; the API speaks codes and English

Only the SPA renders language. The Worker keeps its stable error `code`s, its
`message`s become neutral English used as a fallback, and a new optional
`reason` refines the validation errors a user can trigger from a form. Having
the Worker localize through `Accept-Language` was rejected: it duplicates the
catalogue and the i18n logic in two programs.

### In-house i18n, no dependency

Two typed TypeScript catalogues and a React context. i18next was rejected
(~40 KB, JSON catalogues, extra setup for typed keys); Lingui / FormatJS were
rejected (ICU messages and an extraction step sized for many languages and
external translators). About 160 strings, two languages and one plural do not
need them. Moving to i18next later stays mechanical if the number of languages
grows.

## Design

### 1. The i18n module — `web/src/i18n/`

```
web/src/i18n/
  fr.ts        reference catalogue; its shape defines the keys
  en.ts        const en: Catalog = { … }  → a missing key fails tsc
  index.tsx    LocaleProvider, useI18n(), resolveLocale(), persistence
```

- **Catalogue.** `fr.ts` exports a nested object grouped by area
  (`sidebar.inbox`, `composer.subject`, `errors.codes.not_found`, …). The
  `Catalog` type is derived from it (`typeof fr`, widened so string literals
  become `string`). `en.ts` is annotated with `Catalog`, so a missing key, an
  extra key or a wrong signature fails `pnpm build` (`tsc -b`).
- **Interpolation and plurals.** An entry is either a string or a typed
  function, e.g. `threadView.messageCount: (n: number) => string`. Parameters
  are type-checked; there is no `{{x}}` template syntax to parse. Plurals use
  `new Intl.PluralRules(locale)` inside those functions. Today only the
  "N message(s)" count in `ThreadView` needs one.
- **Access.** `const { t, locale, setLocale, formatDate } = useI18n()`, then
  property access: `t.sidebar.inbox`. No string keys, so autocompletion and
  rename refactors work.
- **Dates.** The three `toLocale*("fr-FR", …)` calls go through date helpers
  that take the active locale, mapped to a fixed `Intl` tag (`fr` → `fr-FR`,
  `en` → `en-US`). The format options stay as they are today.
- **Outside React.** `web/src/lib/reimport.ts` and `web/src/api/client.ts` stop
  producing text. `outcomeLabel(result, t)` receives the catalogue; `ApiError`
  carries data (see section 3). There is no mutable global locale.

### 2. Choosing the language

- **Supported locales:** `fr`, `en` (`SUPPORTED_LOCALES`).
- **Resolution at startup** — `resolveLocale(stored, navigatorLanguages)`, a
  pure function:
  1. the value stored under `localStorage["cloudmail.locale"]`, if supported;
  2. otherwise the first entry of `navigator.languages` whose primary subtag is
     supported (`fr-CA` → `fr`);
  3. otherwise **`en`**.
- **Persistence.** Only an explicit choice in the selector is written; until
  then the language keeps following the browser. Every `localStorage` read and
  write is wrapped in `try/catch`: with storage blocked (private window,
  cleared site data) the SPA works, just without memory.
- **Selector.** A small labelled `<select>` ("Langue" / "Language") at the
  bottom of the sidebar, below the identities list. Options are
  "Français" and "English", each written in its own language so it can be
  found from an interface one cannot read. There is no general settings view
  and this change does not create one.
- **`<html lang>`.** Set on every change via `document.documentElement.lang`.
  `web/index.html` ships `lang="en"`, matching the default before first render.
- **Live switch.** The catalogue flows through context: switching re-renders
  the tree without a reload. React Query caches are untouched.

### 3. API errors

**Worker** (`src/api/routes.ts`, `src/auth/access.ts`, `src/send/client.ts`):

- Every error `message` becomes neutral English (`"Thread not found"`,
  `"Identity already exists"`, …). No existing `code` is renamed — the codes
  are the contract the SPA relies on.
- New optional **`reason`** on the validation errors a user can trigger from a
  form. Today there is one: `invalid_body` with `reason: "invalid_local_part"`,
  raised by the identity and forwarding-rule schemas. `formatValidationError`
  emits generic English (`"Invalid request: check to, subject."`) and
  attaches the `reason` when a custom issue carries one. `.refine()` messages
  a user cannot trigger from the SPA (`isRead` or `folder` required, cursor,
  re-import key) get English messages and no `reason`.
- The `routes.ts` comment explaining that messages are "written in French for
  the user" is rewritten to state the new rule.

**SPA:**

- `ApiError` gains `code?: string` and `reason?: string` alongside `status` and
  the server `message`. When the body has no parsable error, `code` is absent.
- `errorText(err, t)` picks, in order: `t.errors.reasons[reason]`, then
  `t.errors.codes[code]`, then the server `message`, then
  `t.errors.http(status)`; a non-`ApiError` falls back to its `message` or
  `t.errors.unknown`.
- Every place that renders `error.message` today goes through `errorText`
  (`Composer`, `IdentitiesSettings`, `ForwardingSettings`, `ThreadView`,
  `MessageBody`, `MaintenanceSettings`).
- **Raw details kept on purpose.** `send_failed` and a re-import `error`
  outcome carry an exception message, sometimes from the Cloudflare API. They
  are shown after a translated prefix ("Échec de l'envoi : …" / "Send failed:
  …"); the detail itself is not translated.

### 4. Tests and documentation

**SPA tests (jsdom):**

- `renderWithI18n(ui, { locale = "fr" })` in `web/src/test/` wraps the
  `LocaleProvider`. Existing component tests switch from `render(` to it and
  keep their French selectors, which proves no French string changed while
  moving to `t`.
- `useI18n()` outside a provider throws an explicit error instead of silently
  falling back to a language.
- New tests:
  - `resolveLocale`: stored valid / invalid value, `fr-CA` → `fr`, `de` →
    `en`, empty list → `en`;
  - a `localStorage` that throws does not break rendering;
  - the selector switches visible text, updates `<html lang>` and persists the
    choice;
  - `errorText` priority: `reason` → `code` → `message` → `http(status)`;
  - the plural: 1 message / 2 messages in both languages;
  - one or two component tests rendered in `en`, end to end.
- Key parity between `fr` and `en` is enforced by `tsc -b`, not by a runtime
  test.

**Worker tests:** assertions on French error messages
(`test/api/identities.test.ts`, `test/api/forwarding.test.ts`,
`test/api/admin.test.ts`, …) move to asserting `code` (and `reason` where
present) rather than text. French strings that are test data (mail content)
are untouched.

**Documentation:**

- `README.md`: drop the roadmap entry; mention the language (browser detection
  plus selector) in the features.
- `AGENTS.md`: a short "Interface language" section — every visible string
  goes through `fr.ts` / `en.ts`; API `message`s are English fallbacks; an
  error the user must understand gets a `code` or `reason` translated by the
  SPA.

## Out of scope

- Translating code comments (they stay French).
- A general settings view.
- A third language, or tooling for external translators.
- Server-side localization.
