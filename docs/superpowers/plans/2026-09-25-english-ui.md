# English Interface Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the SPA available in English and French — browser language by default, a remembered selector — and make the API speak stable codes with English fallback messages.

**Architecture:** An in-house i18n module (`web/src/i18n/`) holds two typed catalogues (`fr.ts` is the reference, `en.ts` must match its type) and a React context exposing `t`, `locale`, `setLocale` and `formatDate`. API errors carry `code` and optional `reason`; the SPA translates them through `errorText()` and falls back to the server's English `message`.

**Tech Stack:** React 19, TypeScript 6 (`tsc -b` in `pnpm build`), Vitest 4 + Testing Library (jsdom) for the SPA; Hono + zod 4 on Cloudflare Workers, Vitest in the Workers runtime for the Worker.

**Spec:** `docs/superpowers/specs/2026-09-25-english-ui-design.md`

## Global Constraints

- No new dependency, in `web/` or at the root.
- Supported locales: exactly `fr` and `en`. Default when nothing matches: `en`.
- Storage key: `localStorage["cloudmail.locale"]`; every access wrapped in `try/catch`.
- Intl tags: `fr` → `fr-FR`, `en` → `en-US`. Date format options stay identical to today's.
- No existing API error `code` is renamed. New field `reason` is optional; only `invalid_local_part` exists.
- API `message`s are neutral English; the SPA never shows them when it knows the `code` or `reason`.
- Exception details (`send_failed`, re-import `error` outcome, a rule's `lastError`) are shown untranslated after a translated prefix.
- Code comments stay French (the codebase convention). Test names stay French.
- Tests and docs use neutral example values only (`example.com`, `you@example.com`).
- Two test suites: `pnpm vitest run` (Worker, root) and `pnpm --filter web test` (SPA). `pnpm build` is the only SPA typecheck.
- Commits follow the repo's conventional style (`feat(web): …`, `feat(api): …`, `docs: …`), no attribution or session lines.

## Review Focus

1. **Storage throws** (private window, blocked site data): `localStorage.getItem`/`setItem` throwing must not break rendering nor switching → Task 1 tests a throwing storage on read and on write.
2. **Regional browser tags** (`fr-CA`, `en-GB`, uppercase `FR-fr`): must resolve by primary subtag, case-insensitively → Task 1 `resolveLocale` cases.
3. **Error body without JSON / unknown code** (proxy HTML 502, Access redirect page): must show a translated HTTP fallback, never `undefined` → Task 2 `errorText` cases.
4. **Switching language while an error or a form is on screen**: text re-renders, typed input is kept (no remount) → Task 3 test types in the search box, switches, checks the value survives.
5. **Plural of zero**: French "0 message", English "0 messages" → Task 1 plural test.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `web/src/i18n/fr.ts` (create) | Reference catalogue; exports `fr` and `type Catalog` |
| `web/src/i18n/en.ts` (create) | English catalogue, `const en: Catalog` |
| `web/src/i18n/index.tsx` (create) | `Locale`, `SUPPORTED_LOCALES`, `resolveLocale`, storage helpers, `LocaleProvider`, `useI18n` |
| `web/src/i18n/i18n.test.tsx` (create) | Tests for resolution, persistence, provider, plural |
| `web/src/test/i18n.tsx` (create) | `renderWithI18n` test helper |
| `web/src/lib/errors.ts` (create) | `errorText(err, t)` |
| `web/src/lib/errors.test.ts` (create) | Priority tests |
| `web/src/api/client.ts` (modify) | `ApiError` gains `code`, `reason` |
| `web/src/lib/reimport.ts` (modify) | `outcomeLabel(result, t)` |
| `web/src/components/LocaleSelect.tsx` (create) | The language `<select>` |
| `web/src/main.tsx`, `web/index.html`, `web/src/App.tsx`, `web/src/components/Sidebar.tsx` (modify) | Provider, default `lang`, wiring |
| Every other `web/src/components/*.tsx` listed in Tasks 4–5 (modify) | Use `t` and `errorText` |
| `src/api/routes.ts`, `src/index.ts`, `src/auth/access.ts`, `src/send/client.ts`, `src/forwarding/destinations.ts`, `src/email.ts`, `src/admin/reimport.ts` (modify) | English messages, `reason` |
| `README.md`, `AGENTS.md` (modify) | Docs |

---

### Task 1: i18n core — catalogues, provider, resolution, test helper

**Files:**
- Create: `web/src/i18n/fr.ts`, `web/src/i18n/en.ts`, `web/src/i18n/index.tsx`, `web/src/test/i18n.tsx`
- Test: `web/src/i18n/i18n.test.tsx`

**Interfaces:**
- Produces:
  - `type Catalog` (from `fr.ts`), `fr: Catalog`, `en: Catalog`
  - `type Locale = "fr" | "en"`, `SUPPORTED_LOCALES: readonly Locale[]`, `LOCALE_STORAGE_KEY = "cloudmail.locale"`
  - `resolveLocale(stored: string | null, languages: readonly string[]): Locale`
  - `readStoredLocale(): string | null`, `writeStoredLocale(locale: Locale): void`
  - `LocaleProvider({ initialLocale?: Locale, children })`
  - `useI18n(): { t: Catalog; locale: Locale; setLocale(l: Locale): void; formatDate(d: Date, o: Intl.DateTimeFormatOptions): string }`
  - `renderWithI18n(ui, options?: RenderOptions & { locale?: Locale })` in `web/src/test/i18n.tsx`

- [ ] **Step 1: Write the French catalogue** — `web/src/i18n/fr.ts`

Every string is copied verbatim from the current components so that existing tests keep passing once components switch to `t`.

```ts
// Catalogue de référence : sa forme définit le type `Catalog` que doivent
// respecter toutes les autres langues. Une entrée paramétrée est une fonction
// typée plutôt qu'un gabarit à interpoler : les paramètres sont vérifiés par tsc.
const plural = new Intl.PluralRules("fr-FR");

export const fr = {
  localeName: "Français",
  common: {
    loading: "Chargement…",
    cancel: "Annuler",
    save: "Enregistrer",
    delete: "Supprimer",
    close: "Fermer",
    noSubject: "(sans objet)",
    localPart: "Partie locale",
    deleteFailed: (detail: string) => `Suppression impossible : ${detail}`,
  },
  app: {
    searchPlaceholder: "Rechercher…",
    searchLabel: "Rechercher dans les conversations",
    refreshLabel: "Rafraîchir la liste des conversations",
    refreshTitle: "Rafraîchir",
    selectConversation: "Sélectionnez une conversation.",
  },
  sidebar: {
    nav: "Dossiers",
    compose: "Nouveau message",
    inbox: "Boîte de réception",
    sent: "Envoyés",
    trash: "Corbeille",
    identities: "Identités",
    forwarding: "Redirections",
    maintenance: "Maintenance",
    language: "Langue",
  },
  threadList: {
    empty: "Aucun message ici.",
    label: "Conversations",
    hasAttachment: "Contient une pièce jointe",
    loadMore: "Charger plus",
  },
  threadView: {
    recipients: (list: string) => `À : ${list}`,
    cc: (list: string) => ` — Cc : ${list}`,
    parseError: "Ce message n'a pas pu être analysé correctement.",
    viewRaw: "Voir le message brut",
    bodyTruncated: "Corps trop volumineux : seul le début a été conservé en base.",
    reply: "Répondre",
    markUnread: "Marquer comme non lu",
    reimport: "Réimporter",
    reimporting: "Réimport…",
    reimportFailed: (detail: string) => `Réimport impossible : ${detail}`,
    openFailed: (detail: string) => `Impossible d'ouvrir cette conversation : ${detail}`,
    messageCount: (n: number) => `${n} ${plural.select(n) === "one" ? "message" : "messages"}`,
  },
  messageBody: {
    loadFailed: (detail: string) => `Impossible de charger le message : ${detail}`,
    remoteImagesBlocked: "Les images distantes sont bloquées pour protéger ta vie privée.",
    showImages: "Afficher les images",
    frameTitle: "Contenu du message",
  },
  composerPanel: {
    expand: "Agrandir",
    minimize: "Réduire",
  },
  composer: {
    from: "De",
    to: "Destinataires",
    subject: "Objet",
    message: "Message",
    attachments: "Pièces jointes",
    removeAttachment: (filename: string) => `Retirer ${filename}`,
    send: "Envoyer",
    attachmentsTooLarge: "L'ensemble dépasse la limite de 5 MiB",
    messageTooLarge: "Le message dépasse la limite de 5 MiB",
    noRecipient: "Indique au moins un destinataire",
    bounces: (list: string) => `Rejets définitifs : ${list}`,
  },
  identities: {
    title: "Identités",
    add: "Ajouter une identité",
    intro:
      "Les identités disponibles apparaissent dans le sélecteur « De » du formulaire d'envoi. Le nom affiché est celui que verra le destinataire dans son client de messagerie.",
    readFailed: (detail: string) => `Impossible de lire les identités : ${detail}.`,
    configFailed:
      "Le domaine de messagerie n'a pas pu être lu : les adresses seraient incomplètes, les identités ne sont donc pas affichées. Rechargez la page.",
    empty: "Aucune identité.",
    updateFailed: (detail: string) => `Modification impossible : ${detail}`,
    isDefault: "Par défaut",
    makeDefault: "Définir par défaut",
    makeDefaultLabel: (address: string) => `Définir ${address} comme identité par défaut`,
    deleteLabel: (address: string) => `Supprimer l'identité ${address}`,
    address: "Adresse",
    displayName: "Nom affiché",
    displayNamePlaceholder: "Votre nom",
  },
  forwarding: {
    title: "Redirections",
    add: "Ajouter une redirection",
    intro:
      "Toutes les règles qui correspondent à une adresse s'appliquent : un message reçu peut partir vers plusieurs destinations. Il reste dans tous les cas archivé dans Cloudmail.",
    allAddresses: "Toutes les adresses",
    lastFailure: (detail: string) => `Dernière tentative en échec : ${detail}`,
    toggleFailed: (detail: string) => `Activation inchangée : ${detail}`,
    toggleLabel: (enabled: boolean, source: string) =>
      `${enabled ? "Désactiver" : "Activer"} la redirection ${source}`,
    active: "Active",
    inactive: "Inactive",
    deleteLabel: (source: string) => `Supprimer la redirection ${source}`,
    sourceLegend: "Adresse source",
    oneAddress: "Une adresse",
    wholeDomain: "Toutes les adresses du domaine",
    destinationsUnavailable:
      "Impossible de lire les destinations vérifiées du compte Cloudflare. Vérifiez que le secret CF_ROUTING_TOKEN est posé sur le Worker.",
    noDestinationBefore: "Aucune destination vérifiée. Ajoutez-en une depuis le",
    noDestinationLink: "dashboard Cloudflare",
    noDestinationAfter: ", puis cliquez le lien de confirmation reçu par mail.",
    to: "Vers",
    choose: "── choisir ──",
    readFailed: (detail: string) => `Impossible de lire les redirections : ${detail}.`,
    migrationHintBefore: "Si la fonctionnalité vient d'être déployée, la migration",
    migrationHintAfter:
      "n'a peut-être pas été appliquée sur la base D1 (voir l'étape 2 de la mise en service, dans le README).",
    configFailed:
      "Le domaine de messagerie n'a pas pu être lu : les adresses sources seraient incomplètes, les redirections ne sont donc pas affichées. Rechargez la page.",
    empty: "Aucune redirection.",
  },
  maintenance: {
    title: "Maintenance",
    size: { bytes: "o", kilobytes: "Ko", megabytes: "Mo" },
    reimporting: "Réimport en cours…",
    orphans: {
      title: "Messages orphelins",
      intro:
        "Messages conservés dans le stockage mais absents de la boîte, après un échec lors de leur réception.",
      scan: "Analyser le stockage",
      scanning: "Analyse en cours…",
      resume: "Reprendre",
      empty: "Aucun message orphelin.",
      selectAll: "Tout sélectionner",
      reimportSelection: (n: number) => `Réimporter la sélection (${n})`,
      select: (key: string) => `Sélectionner ${key}`,
      meta: (size: string, date: string) => `${size} — reçu le ${date}`,
    },
    parseErrors: {
      title: "Erreurs d'analyse",
      intro:
        "Messages reçus qui n'ont pas pu être analysés. Réimportez-les après une mise à jour de Cloudmail.",
      empty: "Aucun message en erreur d'analyse.",
      reimportAll: (n: number) => `Tout réimporter (${n})`,
      summary: (succeeded: number, failed: number) => `${succeeded} réanalysé(s), ${failed} échec(s)`,
    },
  },
  reimportOutcome: {
    imported: "Importé",
    reparsed: "Réanalysé",
    duplicate: (id: number) => `Déjà présent (message #${id})`,
    notFound: "Introuvable dans le stockage",
    error: (detail: string) => `Échec : ${detail}`,
  },
  errors: {
    // Clés = codes stables renvoyés par l'API (src/api/routes.ts, src/auth/access.ts,
    // src/index.ts). Une fonction reçoit le `message` du serveur quand il porte un
    // détail utile qu'on n'a pas les moyens de traduire (erreur de l'API Cloudflare).
    codes: {
      invalid_id: "Identifiant invalide.",
      invalid_body: "Requête invalide.",
      invalid_query: "Requête invalide.",
      not_found: "Élément introuvable : il a peut-être déjà été supprimé.",
      duplicate_identity: "Cette identité existe déjà.",
      last_identity: "Impossible de supprimer la dernière identité restante.",
      duplicate_rule: "Cette redirection existe déjà.",
      unverified_destination: "Cette destination n'est pas vérifiée sur le compte Cloudflare.",
      routing_unavailable: "Impossible de lire les destinations vérifiées du compte Cloudflare.",
      storage_unavailable: "Stockage indisponible : réessayez dans un instant.",
      unknown_sender: "Expéditeur inconnu.",
      too_large: "Le message dépasse la limite de 5 MiB.",
      send_failed: (detail: string) => `Échec de l'envoi : ${detail}`,
      unauthenticated: "Session expirée ou accès refusé : rechargez la page.",
      internal_error: "Erreur interne du serveur.",
    },
    reasons: {
      invalid_local_part: "Partie locale invalide.",
    },
    http: (status: number) => `Erreur ${status}`,
    unknown: "Erreur inconnue",
  },
};

type Widen<T> = T extends string
  ? string
  : T extends (...args: infer A) => infer R
    ? (...args: A) => R
    : { [K in keyof T]: Widen<T[K]> };

export type Catalog = Widen<typeof fr>;
```

Note: `const fr = {…}` without `as const` already widens string literals; `Widen` is kept so the type stays correct if someone later adds `as const`.

- [ ] **Step 2: Write the English catalogue** — `web/src/i18n/en.ts`

```ts
import type { Catalog } from "./fr";

const plural = new Intl.PluralRules("en-US");

export const en: Catalog = {
  localeName: "English",
  common: {
    loading: "Loading…",
    cancel: "Cancel",
    save: "Save",
    delete: "Delete",
    close: "Close",
    noSubject: "(no subject)",
    localPart: "Local part",
    deleteFailed: (detail) => `Delete failed: ${detail}`,
  },
  app: {
    searchPlaceholder: "Search…",
    searchLabel: "Search conversations",
    refreshLabel: "Refresh the conversation list",
    refreshTitle: "Refresh",
    selectConversation: "Select a conversation.",
  },
  sidebar: {
    nav: "Folders",
    compose: "New message",
    inbox: "Inbox",
    sent: "Sent",
    trash: "Trash",
    identities: "Identities",
    forwarding: "Forwarding",
    maintenance: "Maintenance",
    language: "Language",
  },
  threadList: {
    empty: "Nothing here.",
    label: "Conversations",
    hasAttachment: "Has an attachment",
    loadMore: "Load more",
  },
  threadView: {
    recipients: (list) => `To: ${list}`,
    cc: (list) => ` — Cc: ${list}`,
    parseError: "This message could not be parsed correctly.",
    viewRaw: "View raw message",
    bodyTruncated: "Body too large: only the beginning was stored.",
    reply: "Reply",
    markUnread: "Mark as unread",
    reimport: "Re-import",
    reimporting: "Re-importing…",
    reimportFailed: (detail) => `Re-import failed: ${detail}`,
    openFailed: (detail) => `Could not open this conversation: ${detail}`,
    messageCount: (n) => `${n} ${plural.select(n) === "one" ? "message" : "messages"}`,
  },
  messageBody: {
    loadFailed: (detail) => `Could not load the message: ${detail}`,
    remoteImagesBlocked: "Remote images are blocked to protect your privacy.",
    showImages: "Show images",
    frameTitle: "Message content",
  },
  composerPanel: {
    expand: "Expand",
    minimize: "Minimize",
  },
  composer: {
    from: "From",
    to: "To",
    subject: "Subject",
    message: "Message",
    attachments: "Attachments",
    removeAttachment: (filename) => `Remove ${filename}`,
    send: "Send",
    attachmentsTooLarge: "Attachments exceed the 5 MiB limit",
    messageTooLarge: "The message exceeds the 5 MiB limit",
    noRecipient: "Enter at least one recipient",
    bounces: (list) => `Permanent bounces: ${list}`,
  },
  identities: {
    title: "Identities",
    add: "Add an identity",
    intro:
      "Available identities appear in the “From” selector of the compose form. The display name is what recipients see in their mail client.",
    readFailed: (detail) => `Could not read identities: ${detail}.`,
    configFailed:
      "The mail domain could not be read: addresses would be incomplete, so identities are not shown. Reload the page.",
    empty: "No identities.",
    updateFailed: (detail) => `Update failed: ${detail}`,
    isDefault: "Default",
    makeDefault: "Set as default",
    makeDefaultLabel: (address) => `Set ${address} as the default identity`,
    deleteLabel: (address) => `Delete identity ${address}`,
    address: "Address",
    displayName: "Display name",
    displayNamePlaceholder: "Your name",
  },
  forwarding: {
    title: "Forwarding",
    add: "Add a forwarding rule",
    intro:
      "Every rule matching an address applies: one incoming message can go to several destinations. It is always archived in Cloudmail as well.",
    allAddresses: "All addresses",
    lastFailure: (detail) => `Last attempt failed: ${detail}`,
    toggleFailed: (detail) => `State unchanged: ${detail}`,
    toggleLabel: (enabled, source) => `${enabled ? "Disable" : "Enable"} forwarding for ${source}`,
    active: "Active",
    inactive: "Inactive",
    deleteLabel: (source) => `Delete forwarding for ${source}`,
    sourceLegend: "Source address",
    oneAddress: "One address",
    wholeDomain: "Every address on the domain",
    destinationsUnavailable:
      "Could not read the verified destinations of the Cloudflare account. Check that the CF_ROUTING_TOKEN secret is set on the Worker.",
    noDestinationBefore: "No verified destination. Add one from the",
    noDestinationLink: "Cloudflare dashboard",
    noDestinationAfter: ", then click the confirmation link sent by email.",
    to: "To",
    choose: "── choose ──",
    readFailed: (detail) => `Could not read forwarding rules: ${detail}.`,
    migrationHintBefore: "If the feature was just deployed, the migration",
    migrationHintAfter:
      "may not have been applied to the D1 database (see step 2 of the setup, in the README).",
    configFailed:
      "The mail domain could not be read: source addresses would be incomplete, so forwarding rules are not shown. Reload the page.",
    empty: "No forwarding rules.",
  },
  maintenance: {
    title: "Maintenance",
    size: { bytes: "B", kilobytes: "KB", megabytes: "MB" },
    reimporting: "Re-importing…",
    orphans: {
      title: "Orphaned messages",
      intro: "Messages kept in storage but missing from the mailbox, after a failure when they were received.",
      scan: "Scan storage",
      scanning: "Scanning…",
      resume: "Resume",
      empty: "No orphaned messages.",
      selectAll: "Select all",
      reimportSelection: (n) => `Re-import selection (${n})`,
      select: (key) => `Select ${key}`,
      meta: (size, date) => `${size} — received ${date}`,
    },
    parseErrors: {
      title: "Parse errors",
      intro: "Incoming messages that could not be parsed. Re-import them after a Cloudmail update.",
      empty: "No messages with parse errors.",
      reimportAll: (n) => `Re-import all (${n})`,
      summary: (succeeded, failed) => `${succeeded} re-parsed, ${failed} failed`,
    },
  },
  reimportOutcome: {
    imported: "Imported",
    reparsed: "Re-parsed",
    duplicate: (id) => `Already present (message #${id})`,
    notFound: "Not found in storage",
    error: (detail) => `Failed: ${detail}`,
  },
  errors: {
    codes: {
      invalid_id: "Invalid ID.",
      invalid_body: "Invalid request.",
      invalid_query: "Invalid request.",
      not_found: "Not found: it may have been deleted already.",
      duplicate_identity: "This identity already exists.",
      last_identity: "The last remaining identity cannot be deleted.",
      duplicate_rule: "This forwarding rule already exists.",
      unverified_destination: "This destination is not verified on the Cloudflare account.",
      routing_unavailable: "Could not read the verified destinations of the Cloudflare account.",
      storage_unavailable: "Storage unavailable: try again in a moment.",
      unknown_sender: "Unknown sender.",
      too_large: "The message exceeds the 5 MiB limit.",
      send_failed: (detail) => `Send failed: ${detail}`,
      unauthenticated: "Session expired or access denied: reload the page.",
      internal_error: "Internal server error.",
    },
    reasons: {
      invalid_local_part: "Invalid local part.",
    },
    http: (status) => `Error ${status}`,
    unknown: "Unknown error",
  },
};
```

- [ ] **Step 3: Write the failing tests** — `web/src/i18n/i18n.test.tsx`

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { en } from "./en";
import { fr } from "./fr";
import { LOCALE_STORAGE_KEY, LocaleProvider, resolveLocale, useI18n } from "./index";

function Probe() {
  const { t, locale, setLocale } = useI18n();
  return (
    <div>
      <p>{t.sidebar.inbox}</p>
      <p>{locale}</p>
      <button type="button" onClick={() => setLocale(locale === "fr" ? "en" : "fr")}>switch</button>
    </div>
  );
}

beforeEach(() => {
  localStorage.clear();
  document.documentElement.lang = "";
});
afterEach(() => vi.restoreAllMocks());

describe("resolveLocale", () => {
  it.each([
    ["en", ["fr-FR"], "en"],
    ["fr", ["en-US"], "fr"],
    ["de", ["fr-FR"], "fr"],
    [null, ["fr-CA", "en-US"], "fr"],
    [null, ["FR-fr"], "fr"],
    [null, ["de-DE", "en-GB"], "en"],
    [null, ["de-DE"], "en"],
    [null, [], "en"],
  ] as const)("stocké %o, navigateur %o → %s", (stored, languages, expected) => {
    expect(resolveLocale(stored, languages)).toBe(expected);
  });
});

describe("LocaleProvider", () => {
  it("suit la langue du navigateur sans rien mémoriser", () => {
    vi.spyOn(Navigator.prototype, "languages", "get").mockReturnValue(["fr-FR"]);
    render(<LocaleProvider><Probe /></LocaleProvider>);
    expect(screen.getByText(fr.sidebar.inbox)).toBeDefined();
    expect(document.documentElement.lang).toBe("fr");
    expect(localStorage.getItem(LOCALE_STORAGE_KEY)).toBeNull();
  });

  it("préfère le choix mémorisé à la langue du navigateur", () => {
    vi.spyOn(Navigator.prototype, "languages", "get").mockReturnValue(["fr-FR"]);
    localStorage.setItem(LOCALE_STORAGE_KEY, "en");
    render(<LocaleProvider><Probe /></LocaleProvider>);
    expect(screen.getByText(en.sidebar.inbox)).toBeDefined();
  });

  it("change de langue à chaud, met à jour <html lang> et mémorise le choix", async () => {
    render(<LocaleProvider initialLocale="fr"><Probe /></LocaleProvider>);
    await userEvent.click(screen.getByRole("button", { name: "switch" }));
    expect(screen.getByText(en.sidebar.inbox)).toBeDefined();
    expect(document.documentElement.lang).toBe("en");
    expect(localStorage.getItem(LOCALE_STORAGE_KEY)).toBe("en");
  });

  it("fonctionne quand le stockage lève une exception, en lecture comme en écriture", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
    vi.spyOn(Navigator.prototype, "languages", "get").mockReturnValue(["fr-FR"]);
    render(<LocaleProvider><Probe /></LocaleProvider>);
    expect(screen.getByText(fr.sidebar.inbox)).toBeDefined();
    await userEvent.click(screen.getByRole("button", { name: "switch" }));
    expect(screen.getByText(en.sidebar.inbox)).toBeDefined();
  });

  it("refuse explicitement un useI18n hors provider", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => render(<Probe />)).toThrow(/LocaleProvider/);
  });
});

describe("pluriels", () => {
  it.each([
    [0, "0 message", "0 messages"],
    [1, "1 message", "1 message"],
    [2, "2 messages", "2 messages"],
  ])("%i", (n, inFrench, inEnglish) => {
    expect(fr.threadView.messageCount(n)).toBe(inFrench);
    expect(en.threadView.messageCount(n)).toBe(inEnglish);
  });
});
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `pnpm --filter web test -- src/i18n`
Expected: FAIL — `Failed to resolve import "./index"`.

- [ ] **Step 5: Implement** — `web/src/i18n/index.tsx`

```tsx
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { en } from "./en";
import { fr, type Catalog } from "./fr";

export type Locale = "fr" | "en";
export const SUPPORTED_LOCALES: readonly Locale[] = ["fr", "en"];
export const LOCALE_STORAGE_KEY = "cloudmail.locale";

const CATALOGS: Record<Locale, Catalog> = { fr, en };
// Étiquette Intl fixe par langue : le format des dates ne dépend que de la langue
// choisie, pas de la région du navigateur.
const INTL_TAGS: Record<Locale, string> = { fr: "fr-FR", en: "en-US" };

const isLocale = (value: string): value is Locale => (SUPPORTED_LOCALES as readonly string[]).includes(value);

// Choix mémorisé d'abord, puis la première langue du navigateur prise en charge
// (comparée sur son sous-étiquette principale : fr-CA → fr), sinon l'anglais.
export function resolveLocale(stored: string | null, languages: readonly string[]): Locale {
  if (stored !== null && isLocale(stored)) return stored;
  for (const tag of languages) {
    const primary = tag.split("-")[0].toLowerCase();
    if (isLocale(primary)) return primary;
  }
  return "en";
}

// Stockage bloqué (navigation privée, données de site effacées) : l'interface
// doit fonctionner quand même, simplement sans mémoire du choix.
export function readStoredLocale(): string | null {
  try {
    return localStorage.getItem(LOCALE_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function writeStoredLocale(locale: Locale): void {
  try {
    localStorage.setItem(LOCALE_STORAGE_KEY, locale);
  } catch {
    // Choix non mémorisé : il vaut pour la session en cours seulement.
  }
}

type I18n = {
  t: Catalog;
  locale: Locale;
  setLocale: (locale: Locale) => void;
  formatDate: (date: Date, options: Intl.DateTimeFormatOptions) => string;
};

const I18nContext = createContext<I18n | null>(null);

export function LocaleProvider({ initialLocale, children }: { initialLocale?: Locale; children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(
    () => initialLocale ?? resolveLocale(readStoredLocale(), navigator.languages ?? []),
  );

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  // Seul un choix explicite est mémorisé : tant que l'utilisateur n'a rien
  // choisi, la langue continue de suivre celle du navigateur.
  const setLocale = useCallback((next: Locale) => {
    writeStoredLocale(next);
    setLocaleState(next);
  }, []);

  const value = useMemo<I18n>(() => {
    const tag = INTL_TAGS[locale];
    return {
      t: CATALOGS[locale],
      locale,
      setLocale,
      formatDate: (date, options) => new Intl.DateTimeFormat(tag, options).format(date),
    };
  }, [locale, setLocale]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18n {
  const value = useContext(I18nContext);
  // Pas de repli silencieux sur une langue : un provider oublié doit se voir tout de suite.
  if (value === null) throw new Error("useI18n() doit être appelé sous un <LocaleProvider>");
  return value;
}
```

oxlint may flag `react-refresh/only-export-components` for a `.tsx` exporting non-components; if `pnpm --filter web lint` reports it, move `resolveLocale`, `readStoredLocale`, `writeStoredLocale`, `isLocale`, `SUPPORTED_LOCALES`, `LOCALE_STORAGE_KEY` and `Locale` to `web/src/i18n/locale.ts` and re-export them from `index.tsx`.

- [ ] **Step 6: Write the test helper** — `web/src/test/i18n.tsx`

```tsx
import { render, type RenderOptions } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import { LocaleProvider, type Locale } from "../i18n";

// Rend sous un LocaleProvider (français par défaut, la langue des sélecteurs des
// tests existants), en composant avec le `wrapper` éventuel du test.
export function renderWithI18n(
  ui: ReactElement,
  { locale = "fr", wrapper: Inner, ...options }: RenderOptions & { locale?: Locale } = {},
) {
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <LocaleProvider initialLocale={locale}>{Inner ? <Inner>{children}</Inner> : children}</LocaleProvider>
  );
  return render(ui, { ...options, wrapper: Wrapper });
}
```

- [ ] **Step 7: Run the tests and the build**

Run: `pnpm --filter web test -- src/i18n && pnpm --filter web build`
Expected: all i18n tests PASS; build succeeds (proves `en` matches `Catalog`).

Then sanity-check the type guard: temporarily delete `loadMore` from `en.ts`, run `pnpm --filter web build`, expect `Property 'loadMore' is missing`, restore it.

- [ ] **Step 8: Commit**

```bash
git add web/src/i18n web/src/test/i18n.tsx
git commit -m "feat(web): typed fr/en catalogues and locale provider"
```

---

### Task 2: Error translation and re-import labels

**Files:**
- Create: `web/src/lib/errors.ts`, `web/src/lib/errors.test.ts`
- Modify: `web/src/api/client.ts:40-58`, `web/src/lib/reimport.ts`, `web/src/lib/reimport.test.ts`

**Interfaces:**
- Consumes: `Catalog`, `fr`, `en` (Task 1).
- Produces:
  - `class ApiError extends Error { status: number; code?: string; reason?: string }` — constructor `(message: string, status: number, code?: string, reason?: string)`
  - `errorText(err: unknown, t: Catalog): string` in `web/src/lib/errors.ts`
  - `outcomeLabel(result: ReimportResult, t: Catalog): string`

- [ ] **Step 1: Write the failing tests** — `web/src/lib/errors.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { ApiError } from "../api/client";
import { en } from "../i18n/en";
import { fr } from "../i18n/fr";
import { errorText } from "./errors";

describe("errorText", () => {
  it("traduit la raison en priorité sur le code", () => {
    const err = new ApiError("Invalid local part", 400, "invalid_body", "invalid_local_part");
    expect(errorText(err, fr)).toBe("Partie locale invalide.");
    expect(errorText(err, en)).toBe("Invalid local part.");
  });

  it("traduit un code connu", () => {
    expect(errorText(new ApiError("Identity already exists", 409, "duplicate_identity"), fr))
      .toBe("Cette identité existe déjà.");
  });

  it("ignore une raison inconnue et retombe sur le code", () => {
    expect(errorText(new ApiError("x", 400, "invalid_body", "nouvelle_raison"), fr)).toBe("Requête invalide.");
  });

  it("garde le détail du serveur derrière un préfixe traduit pour send_failed", () => {
    expect(errorText(new ApiError("Domain not verified", 400, "send_failed"), fr))
      .toBe("Échec de l'envoi : Domain not verified");
  });

  it("affiche le message du serveur pour un code inconnu", () => {
    expect(errorText(new ApiError("Brand new failure", 400, "brand_new"), fr)).toBe("Brand new failure");
  });

  it("retombe sur le statut HTTP quand le corps n'a pas d'erreur exploitable", () => {
    expect(errorText(new ApiError("", 502), fr)).toBe("Erreur 502");
    expect(errorText(new ApiError("", 502), en)).toBe("Error 502");
  });

  it("affiche le message d'une erreur ordinaire, ou un libellé générique", () => {
    expect(errorText(new Error("réseau coupé"), fr)).toBe("réseau coupé");
    expect(errorText("pas une erreur", fr)).toBe("Erreur inconnue");
  });
});
```

And update `web/src/lib/reimport.test.ts` to pass the catalogue and cover English:

```ts
import { describe, expect, it } from "vitest";
import type { ReimportResult } from "../api/client";
import { en } from "../i18n/en";
import { fr } from "../i18n/fr";
import { outcomeLabel } from "./reimport";

const key = "raw/x.eml";
const cases: [ReimportResult, string, string][] = [
  [{ key, outcome: "imported", messageIds: [3] }, "Importé", "Imported"],
  [{ key, outcome: "reparsed", messageIds: [3] }, "Réanalysé", "Re-parsed"],
  [{ key, outcome: "duplicate", messageIds: [7] }, "Déjà présent (message #7)", "Already present (message #7)"],
  [{ key, outcome: "not_found" }, "Introuvable dans le stockage", "Not found in storage"],
  [{ key, outcome: "error", error: "D1 unavailable" }, "Échec : D1 unavailable", "Failed: D1 unavailable"],
];

describe("outcomeLabel", () => {
  it.each(cases)("libelle %o", (result, inFrench, inEnglish) => {
    expect(outcomeLabel(result, fr)).toBe(inFrench);
    expect(outcomeLabel(result, en)).toBe(inEnglish);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter web test -- src/lib`
Expected: FAIL — `./errors` does not exist; `outcomeLabel` returns French for `en`.

- [ ] **Step 3: Implement**

`web/src/api/client.ts` — replace the `ApiError` class and the error branch of `api()`:

```ts
export class ApiError extends Error {
  status: number;
  // Contrat d'erreur de l'API : `code` stable, `reason` optionnelle qui précise
  // une erreur de validation. L'interface traduit l'un ou l'autre ; `message`
  // (en anglais) ne sert que de repli.
  code?: string;
  reason?: string;
  constructor(message: string, status: number, code?: string, reason?: string) {
    super(message);
    this.status = status;
    this.code = code;
    this.reason = reason;
  }
}
```

```ts
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as
      | { error?: { code?: string; message?: string; reason?: string } }
      | null;
    throw new ApiError(body?.error?.message ?? "", res.status, body?.error?.code, body?.error?.reason);
  }
```

`web/src/lib/errors.ts`:

```ts
import { ApiError } from "../api/client";
import type { Catalog } from "../i18n/fr";

type Entry = string | ((serverMessage: string) => string) | undefined;

// Texte d'erreur à afficher, dans l'ordre : raison traduite, code traduit,
// message du serveur (anglais), puis statut HTTP. Une entrée de catalogue qui
// est une fonction reçoit le message du serveur pour en garder le détail.
export function errorText(err: unknown, t: Catalog): string {
  if (err instanceof ApiError) {
    const reason: Entry = err.reason ? (t.errors.reasons as Record<string, Entry>)[err.reason] : undefined;
    if (typeof reason === "string") return reason;
    const code: Entry = err.code ? (t.errors.codes as Record<string, Entry>)[err.code] : undefined;
    if (typeof code === "string") return code;
    if (typeof code === "function") return code(err.message);
    if (err.message) return err.message;
    return t.errors.http(err.status);
  }
  if (err instanceof Error && err.message) return err.message;
  return t.errors.unknown;
}
```

`web/src/lib/reimport.ts`:

```ts
import type { ReimportResult } from "../api/client";
import type { Catalog } from "../i18n/fr";

// Libellé affiché pour le résultat du réimport d'une clé.
export function outcomeLabel(result: ReimportResult, t: Catalog): string {
  switch (result.outcome) {
    case "imported":
      return t.reimportOutcome.imported;
    case "reparsed":
      return t.reimportOutcome.reparsed;
    case "duplicate":
      return t.reimportOutcome.duplicate(result.messageIds[0]);
    case "not_found":
      return t.reimportOutcome.notFound;
    case "error":
      return t.reimportOutcome.error(result.error);
  }
}
```

The three callers (`ThreadView.tsx:138`, `MaintenanceSettings.tsx:152,233`) no longer typecheck. Do not pass a hard-coded catalogue: add `const { t } = useI18n();` (import from `../i18n`) at the top of `MessageItem`, `OrphansPanel` and `ParseErrorsPanel` and call `outcomeLabel(x, t)`. Those components now need a provider, so switch `ThreadView.test.tsx` and `MaintenanceSettings.test.tsx` to `import { renderWithI18n as render } from "../test/i18n";` (removing `render` from the `@testing-library/react` import). The running app has no provider until Task 3; that is expected between commits.

- [ ] **Step 4: Run tests and build**

Run: `pnpm --filter web test && pnpm --filter web build`
Expected: PASS. `client.test.tsx:220` still passes (`rejects.toThrow("Erreur interne")` matches the mocked server message carried by `ApiError`).

- [ ] **Step 5: Commit**

```bash
git add web/src/api/client.ts web/src/lib web/src/components/ThreadView.tsx web/src/components/MaintenanceSettings.tsx web/src/components/ThreadView.test.tsx web/src/components/MaintenanceSettings.test.tsx
git commit -m "feat(web): translate API errors from their code and reason"
```

---

### Task 3: Provider at the root, language selector, App and Sidebar

**Files:**
- Create: `web/src/components/LocaleSelect.tsx`, `web/src/components/Sidebar.test.tsx`
- Modify: `web/src/main.tsx`, `web/index.html:2`, `web/src/App.tsx`, `web/src/components/Sidebar.tsx`

**Interfaces:**
- Consumes: `LocaleProvider`, `useI18n`, `SUPPORTED_LOCALES`, `fr`, `en`, `renderWithI18n`.
- Produces: `LocaleSelect()` component (no props).

- [ ] **Step 1: Write the failing test** — `web/src/components/Sidebar.test.tsx`

```tsx
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import App from "../App";
import { LOCALE_STORAGE_KEY } from "../i18n";
import { renderWithI18n as render } from "../test/i18n";

const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    {children}
  </QueryClientProvider>
);

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal("fetch", vi.fn(async (url: string) =>
    Response.json(url.startsWith("/api/threads") ? { threads: [], cursor: null } : []),
  ));
});

describe("sélecteur de langue", () => {
  it("bascule l'interface en anglais sans perdre la saisie en cours", async () => {
    render(<App />, { wrapper });
    const search = screen.getByLabelText("Rechercher dans les conversations");
    await userEvent.type(search, "facture");

    await userEvent.selectOptions(screen.getByLabelText("Langue"), "en");

    expect(screen.getByRole("button", { name: "Inbox" })).toBeDefined();
    expect(screen.getByLabelText("Search conversations")).toHaveValue("facture");
    expect(document.documentElement.lang).toBe("en");
    expect(localStorage.getItem(LOCALE_STORAGE_KEY)).toBe("en");
  });

  it("présente chaque langue dans sa propre langue", () => {
    render(<App />, { wrapper, locale: "en" });
    const select = screen.getByLabelText("Language");
    expect(select).toHaveTextContent("Français");
    expect(select).toHaveTextContent("English");
  });
});
```

`App` already wraps itself in its own `QueryClientProvider`; the extra `wrapper` is harmless. `ThreadsPage` is `{ threads, cursor }` (`web/src/api/client.ts`).

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter web test -- Sidebar`
Expected: FAIL — no element labelled "Langue".

- [ ] **Step 3: Implement**

`web/src/components/LocaleSelect.tsx`:

```tsx
import { en } from "../i18n/en";
import { fr } from "../i18n/fr";
import { SUPPORTED_LOCALES, useI18n, type Locale } from "../i18n";

// Chaque langue est écrite dans sa propre langue : on la retrouve même depuis
// une interface qu'on ne sait pas lire.
const NAMES: Record<Locale, string> = { fr: fr.localeName, en: en.localeName };

export function LocaleSelect() {
  const { t, locale, setLocale } = useI18n();
  return (
    <label className="flex flex-col gap-1 px-3 text-xs text-muted-foreground">
      {t.sidebar.language}
      <select
        value={locale}
        onChange={(e) => setLocale(e.target.value as Locale)}
        className="rounded border border-border bg-transparent px-2 py-1 text-xs text-foreground"
      >
        {SUPPORTED_LOCALES.map((l) => (
          <option key={l} value={l} lang={l}>
            {NAMES[l]}
          </option>
        ))}
      </select>
    </label>
  );
}
```

`web/src/main.tsx` — wrap `App`:

```tsx
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { LocaleProvider } from './i18n'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <LocaleProvider>
      <App />
    </LocaleProvider>
  </StrictMode>,
)
```

`web/index.html:2` → `<html lang="en">`.

`web/src/App.tsx` — in `Mailbox`, add `const { t } = useI18n();` (import from `./i18n`) and replace:
- `placeholder="Rechercher…"` → `placeholder={t.app.searchPlaceholder}`
- `aria-label="Rechercher dans les conversations"` → `aria-label={t.app.searchLabel}`
- `aria-label="Rafraîchir la liste des conversations"` → `aria-label={t.app.refreshLabel}`
- `title="Rafraîchir"` → `title={t.app.refreshTitle}`
- `Sélectionnez une conversation.` → `{t.app.selectConversation}`

`web/src/components/Sidebar.tsx`:
- Replace the `FOLDERS` constant with ids only and look labels up in the catalogue:

```tsx
const FOLDERS = ["inbox", "sent", "trash"] as const;
```

```tsx
        {FOLDERS.map((id) => (
          <li key={id}>
            <button
              type="button"
              aria-current={view === "mail" && id === folder ? "true" : undefined}
              onClick={() => { onSelectView("mail"); onSelectFolder(id); }}
              className="w-full rounded px-3 py-2 text-left text-sm hover:bg-accent aria-[current=true]:bg-accent aria-[current=true]:font-semibold"
            >
              {t.sidebar[id]}
            </button>
          </li>
        ))}
```

- Add `const { t } = useI18n();`; replace `aria-label="Dossiers"` → `{t.sidebar.nav}`, both `Nouveau message` (button text and `ComposerPanel title`) → `t.sidebar.compose`, `Identités` (menu and `<h2>`) → `t.sidebar.identities`, `Redirections` → `t.sidebar.forwarding`, `Maintenance` → `t.sidebar.maintenance`.
- Render the selector at the bottom: wrap the identities block and the selector in one `mt-auto` container so the selector always sits last, whether or not identities exist:

```tsx
      <div className="mt-auto flex flex-col gap-4">
        {identities && identities.length > 0 && (
          <div>
            <h2 className="px-3 text-xs font-semibold uppercase text-muted-foreground">{t.sidebar.identities}</h2>
            <ul className="mt-2 flex flex-col gap-1">
              {identities.map((id) => (
                <li key={id.address} className="truncate px-3 py-1 text-xs text-muted-foreground">
                  {id.displayName ?? id.address}
                </li>
              ))}
            </ul>
          </div>
        )}
        <LocaleSelect />
      </div>
```

- [ ] **Step 4: Run tests and build**

Run: `pnpm --filter web test && pnpm --filter web build`
Expected: PASS. `ComposerPanel.test.tsx` renders `Sidebar`? If any existing test renders `Sidebar` or `App` with plain `render`, it now throws "LocaleProvider"; switch that file's import to `import { renderWithI18n as render } from "../test/i18n";` (and drop `render` from the `@testing-library/react` import).

- [ ] **Step 5: Commit**

```bash
git add web/index.html web/src/main.tsx web/src/App.tsx web/src/components/Sidebar.tsx web/src/components/Sidebar.test.tsx web/src/components/LocaleSelect.tsx web/src/components/*.test.tsx
git commit -m "feat(web): language selector in the sidebar"
```

---

### Task 4: Mail views — ThreadList, ThreadView, MessageBody, Composer, ComposerPanel

**Files:**
- Modify: `web/src/components/ThreadList.tsx`, `ThreadView.tsx`, `MessageBody.tsx`, `Composer.tsx`, `ComposerPanel.tsx`
- Test: `ThreadList.test.tsx`, `ThreadView.test.tsx`, `MessageBody.test.tsx`, `Composer.test.tsx`, `ComposerPanel.test.tsx`

**Interfaces:**
- Consumes: `useI18n()` → `{ t, formatDate }`; `errorText(err, t)`; `outcomeLabel(result, t)`; `renderWithI18n`.

- [ ] **Step 1: Switch the five test files to the i18n render and add English cases**

In each file not already switched in Task 2, remove `render` from the `@testing-library/react` import and add:

```ts
import { renderWithI18n as render } from "../test/i18n";
```

In `Composer.test.tsx`, `wrap` calls `render(<QueryClientProvider …>{ui}</QueryClientProvider>)` — it now uses the aliased `render`, nothing else changes.

Update the one assertion whose text changes because `send_failed` now shows a prefix — `Composer.test.tsx`, test "affiche l'erreur renvoyée par l'API":

```ts
    expect(await screen.findByText("Échec de l'envoi : Domaine non vérifié")).toBeDefined();
```

`MessageBody.test.tsx` (`/Erreur interne/`, `/Session expirée/`) and `ThreadView.test.tsx` (`/Erreur interne/`) keep passing: the French catalogue texts for `internal_error` and `unauthenticated` contain those words.

Add English end-to-end cases:

`ThreadList.test.tsx`:

```tsx
  it("s'affiche en anglais", () => {
    render(<ThreadList threads={[]} selectedId={null} onSelect={() => {}} />, { locale: "en" });
    expect(screen.getByText("Nothing here.")).toBeDefined();
  });

  it("formate les dates dans la langue active", () => {
    // 1757318400 = 8 septembre 2025 : jamais « aujourd'hui », donc format jour + mois.
    render(<ThreadList threads={threads.slice(0, 1)} selectedId={null} onSelect={() => {}} />, { locale: "en" });
    expect(screen.getByText("Sep 8")).toBeDefined();
  });
```

`ThreadView.test.tsx` — give `renderThreadView` (line 51) an optional locale and forward it:

```tsx
function renderThreadView({ locale }: { locale?: "fr" | "en" } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ThreadView threadId={1} />
    </QueryClientProvider>,
    { locale },
  );
}
```

then add this case **inside the `describe` block that installs the thread fixture** (the one declaring `let fetchMock` around line 71, which also holds "déplie le dernier message par défaut…"):

```tsx
  it("s'affiche en anglais", async () => {
    // Même fixture que « déplie le dernier message par défaut… ».
    renderThreadView({ locale: "en" });
    expect(await screen.findByRole("button", { name: "Reply" })).toBeDefined();
    expect(screen.getByText(/^\d+ messages?$/)).toBeDefined();
  });
```

`Composer.test.tsx`:

```tsx
  it("s'affiche en anglais", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={qc}><Composer mode="new" onClose={() => {}} /></QueryClientProvider>, { locale: "en" });
    expect(await screen.findByLabelText("To")).toBeDefined();
    expect(screen.getByRole("button", { name: "Send" })).toBeDefined();
  });
```

- [ ] **Step 2: Run to verify the new cases fail**

Run: `pnpm --filter web test -- ThreadList ThreadView MessageBody Composer`
Expected: the "s'affiche en anglais" / date / prefix cases FAIL (French text still hard-coded); the rest PASS.

- [ ] **Step 3: Migrate the components**

`ThreadList.tsx` — delete the module-level `formatDate`; inside `ThreadList` add `const { t, formatDate } = useI18n();` and:

```tsx
  const formatWhen = (epoch: number) => {
    const d = new Date(epoch * 1000);
    const sameDay = d.toDateString() === new Date().toDateString();
    return sameDay
      ? formatDate(d, { hour: "2-digit", minute: "2-digit" })
      : formatDate(d, { day: "numeric", month: "short" });
  };
```

Replace `formatDate(t.lastMessageAt)` with `formatWhen(thread.lastMessageAt)` — **rename the map variable `t` to `thread`** in `threads.map((t) => …)` so it no longer shadows the catalogue. Strings: `Aucun message ici.` → `t.threadList.empty`; `aria-label="Conversations"` → `t.threadList.label`; `aria-label="Contient une pièce jointe"` → `t.threadList.hasAttachment`; `"Chargement…"` → `t.common.loading`; `"Charger plus"` → `t.threadList.loadMore`.

`ThreadView.tsx` — delete the module-level `formatDate`. In `MessageHeader`, add `const { t, formatDate } = useI18n();`:

```tsx
        <time className="shrink-0 text-xs text-muted-foreground">
          {formatDate(new Date(message.receivedAt * 1000), {
            day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit",
          })}
        </time>
      </div>
      <p className="truncate text-xs text-muted-foreground">
        {t.threadView.recipients(message.to.map(formatRecipient).join(", "))}
        {message.cc.length > 0 && t.threadView.cc(message.cc.map(formatRecipient).join(", "))}
      </p>
```

In `MessageItem` (already has `t` from Task 2): `parseError`, `viewRaw` (×2), `bodyTruncated`, `reply`, `markUnread`, `common.delete`, `reimporting`/`reimport`, and:

```tsx
              {t.threadView.reimportFailed(errorText(reimport.error, t))}
```

In `ThreadView`: add `const { t } = useI18n();`, then `t.threadView.openFailed(errorText(error, t))`, `t.common.loading`, `thread.subject || t.common.noSubject`, `t.threadView.messageCount(thread.messages.length)`, and the dialog title `t.threadView.reply`.

`MessageBody.tsx` — keep the raw error, translate at render time:

```tsx
  const { t } = useI18n();
  const [error, setError] = useState<unknown>(null);
```

`.catch((err: unknown) => { if (!cancelled) setError(err); })`, `setError(null)` unchanged, and the render branch `if (error !== null)` → `t.messageBody.loadFailed(errorText(error, t))`. Strings: `t.common.loading`, `t.messageBody.remoteImagesBlocked`, `t.messageBody.showImages`, iframe `title={t.messageBody.frameTitle}`.

`Composer.tsx` — add `const { t } = useI18n();`. Store translated text at the moment it is produced (it is re-read on the next render anyway):
- `setFileError(t.composer.attachmentsTooLarge)`, `setError(t.composer.noRecipient)`, `setError(t.composer.messageTooLarge)`, `onError: (err) => setError(errorText(err, t))`.
- Labels and `aria-label`s: `t.composer.from`, `t.composer.to`, `t.composer.subject`, `t.composer.message`, `t.composer.attachments`; `aria-label={t.composer.removeAttachment(a.filename)}`; buttons `t.common.cancel`, `t.composer.send`, `t.common.close`; bounces `t.composer.bounces(bounces.join(", "))`.
- Leave `readFileAsBase64`'s rejection message as is: it is never displayed.

`ComposerPanel.tsx` — `aria-label={minimized ? t.composerPanel.expand : t.composerPanel.minimize}`, `aria-label={t.common.close}`.

- [ ] **Step 4: Run tests and build**

Run: `pnpm --filter web test && pnpm --filter web build && pnpm --filter web lint`
Expected: PASS, no lint error.

- [ ] **Step 5: Commit**

```bash
git add web/src/components/ThreadList.tsx web/src/components/ThreadView.tsx web/src/components/MessageBody.tsx web/src/components/Composer.tsx web/src/components/ComposerPanel.tsx web/src/components/ThreadList.test.tsx web/src/components/ThreadView.test.tsx web/src/components/MessageBody.test.tsx web/src/components/Composer.test.tsx web/src/components/ComposerPanel.test.tsx
git commit -m "feat(web): translate the mail views"
```

---

### Task 5: Settings views — Identities, Forwarding, Maintenance

**Files:**
- Modify: `web/src/components/IdentitiesSettings.tsx`, `ForwardingSettings.tsx`, `MaintenanceSettings.tsx`
- Test: `IdentitiesSettings.test.tsx`, `ForwardingSettings.test.tsx`, `MaintenanceSettings.test.tsx`

**Interfaces:**
- Consumes: `useI18n()`, `errorText`, `outcomeLabel`, `renderWithI18n`.

- [ ] **Step 1: Switch test files and add cases**

Same import change as Task 4 in `IdentitiesSettings.test.tsx` and `ForwardingSettings.test.tsx` (`MaintenanceSettings.test.tsx` was switched in Task 2).

Existing assertions stay valid: `/dernière identité restante/` matches the `last_identity` translation; `"Stockage indisponible"` (via `toHaveTextContent`, a substring match) matches the `storage_unavailable` translation; `/Impossible de lire les redirections/`, `/Activation inchangée/`, `/Suppression impossible/` are prefixes kept verbatim; `` `${k(1)} — Échec : D1 indisponible` `` is unchanged.

Add to `IdentitiesSettings.test.tsx`:

```tsx
  it("traduit le refus d'une partie locale invalide", async () => {
    stubApi({ identities: [identity()] });
    vi.mocked(fetch).mockImplementation(async (url: string | URL | Request, init?: RequestInit) => {
      if (url === "/api/config") return json({ mailDomain: "example.com" });
      if ((init?.method ?? "GET") === "GET") return json([identity()]);
      return json({ error: { code: "invalid_body", reason: "invalid_local_part", message: "Invalid local part" } }, 400);
    });
    render(<IdentitiesSettings />, { wrapper });

    await userEvent.click(await screen.findByRole("button", { name: "Ajouter une identité" }));
    await userEvent.type(screen.getByLabelText("Partie locale"), "a b");
    await userEvent.click(screen.getByRole("button", { name: "Enregistrer" }));
    expect(await screen.findByText("Partie locale invalide.")).toBeDefined();
  });

  it("s'affiche en anglais", async () => {
    stubApi({ identities: [identity()] });
    render(<IdentitiesSettings />, { wrapper, locale: "en" });
    expect(await screen.findByRole("heading", { name: "Identities" })).toBeDefined();
    expect(await screen.findByRole("button", { name: "Delete identity thomas@example.com" })).toBeDefined();
  });
```

Add to `ForwardingSettings.test.tsx`:

```tsx
  it("s'affiche en anglais", async () => {
    stubApi({ rules: [rule()] });
    render(<ForwardingSettings />, { wrapper, locale: "en" });
    expect(await screen.findByRole("switch", { name: /^Disable forwarding for / })).toBeDefined();
  });
```

Add to `MaintenanceSettings.test.tsx`:

```tsx
  it("s'affiche en anglais", async () => {
    stubApi({});
    render(<MaintenanceSettings />, { wrapper, locale: "en" });
    await userEvent.click(screen.getByRole("button", { name: "Scan storage" }));
    expect(await screen.findByText("No orphaned messages.")).toBeDefined();
  });
```

- [ ] **Step 2: Run to verify the new cases fail**

Run: `pnpm --filter web test -- Settings`
Expected: new cases FAIL; existing ones PASS.

- [ ] **Step 3: Migrate the components**

`IdentitiesSettings.tsx` — `useI18n()` in `IdentityRow`, `NewIdentityForm`, `IdentitiesSettings`:
- `t.identities.updateFailed(errorText(update.error, t))`, `t.common.deleteFailed(errorText(remove.error, t))`
- `t.identities.isDefault`, `aria-label={t.identities.makeDefaultLabel(identity.address)}`, `t.identities.makeDefault`, `aria-label={t.identities.deleteLabel(identity.address)}`, `t.common.delete`
- form: `t.identities.address`, `aria-label={t.common.localPart}`, `t.identities.displayName` (label text and `aria-label`), `placeholder={t.identities.displayNamePlaceholder}`, `{errorText(create.error, t)}`, `t.common.save`, `t.common.cancel`
- page: `t.identities.title`, `t.identities.add`, `t.identities.intro`, `t.identities.readFailed(errorText(identities.error, t))`, `t.identities.configFailed`, `t.identities.empty`

`ForwardingSettings.tsx` — `sourceLabel` takes the catalogue:

```tsx
const sourceLabel = (rule: ForwardRule, mailDomain: string, t: Catalog) =>
  rule.matchLocal === CATCH_ALL ? t.forwarding.allAddresses : `${rule.matchLocal}@${mailDomain}`;
```

- `RuleRow`: `t.forwarding.lastFailure(rule.lastError ?? "")` (the raw detail stays untranslated), `t.forwarding.toggleFailed(errorText(update.error, t))`, `t.common.deleteFailed(errorText(remove.error, t))`, `aria-label={t.forwarding.toggleLabel(rule.enabled, label)}`, `rule.enabled ? t.forwarding.active : t.forwarding.inactive`, `aria-label={t.forwarding.deleteLabel(label)}`, `t.common.delete`.
- `NewRuleForm`: `t.forwarding.sourceLegend`, `t.forwarding.oneAddress`, `aria-label={t.common.localPart}`, `t.forwarding.wholeDomain`, `t.forwarding.destinationsUnavailable`, and:

```tsx
        <p className="text-xs text-muted-foreground">
          {t.forwarding.noDestinationBefore}{" "}
          <a href={DASHBOARD_URL} target="_blank" rel="noreferrer" className="underline">
            {t.forwarding.noDestinationLink}
          </a>
          {t.forwarding.noDestinationAfter}
        </p>
```

  `t.forwarding.to` (label text and `aria-label`), `t.forwarding.choose`, `{errorText(create.error, t)}`, `t.common.save`, `t.common.cancel`.
- `ForwardingSettings`: `t.forwarding.title`, `t.forwarding.add`, `t.forwarding.intro`, `t.forwarding.configFailed`, `t.forwarding.empty`, and:

```tsx
        <p className="text-sm text-destructive">
          {t.forwarding.readFailed(errorText(rules.error, t))} {t.forwarding.migrationHintBefore}{" "}
          <code>0002_forward_rules.sql</code> {t.forwarding.migrationHintAfter}
        </p>
```

Check `rule.lastError`'s type in `ForwardRule` (`web/src/api/client.ts`); if it is `string | null`, keep `?? ""`.

`MaintenanceSettings.tsx`:
- Delete module-level `formatDate` and `errorMessage`. `formatSize` takes units:

```tsx
const formatSize = (bytes: number, u: Catalog["maintenance"]["size"]) =>
  bytes < 1024
    ? `${bytes} ${u.bytes}`
    : bytes < 1024 * 1024
      ? `${Math.round(bytes / 1024)} ${u.kilobytes}`
      : `${(bytes / 1024 / 1024).toFixed(1)} ${u.megabytes}`;

const DATE_OPTIONS: Intl.DateTimeFormatOptions = {
  day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit",
};
const toDate = (value: string | number) => new Date(typeof value === "number" ? value * 1000 : value);
```

- `OrphansPanel` and `ParseErrorsPanel`: `const { t, formatDate } = useI18n();`. Store the raw error, translate at render: `useState<unknown>(null)` for `error` / `runError`, `setError(err)` / `setRunError(err)`, render `{errorText(error, t)}` where the condition becomes `error !== null`. For the query error: `{error && <p …>{errorText(error, t)}</p>}`.
- Strings: `t.maintenance.orphans.*` (`title`, `intro`, `scan`/`scanning`, `resume`, `empty`, `selectAll` for both the checkbox `aria-label` and the label text, `reimportSelection(selected.size)`, `select(o.key)`, `meta(formatSize(o.size, t.maintenance.size), formatDate(toDate(o.uploaded), DATE_OPTIONS))`), `t.maintenance.reimporting`, `t.maintenance.parseErrors.*` (`title`, `intro`, `empty`, `reimportAll(data.length)`, `summary(succeeded, failures.length)`), `t.common.loading`, `m.subject || t.common.noSubject`, `formatDate(toDate(m.receivedAt), DATE_OPTIONS)`, `t.maintenance.title`.

- [ ] **Step 4: Run tests, build, lint; check nothing French is left**

Run: `pnpm --filter web test && pnpm --filter web build && pnpm --filter web lint`
Expected: PASS.

Run: `grep -rnE '>[^<{]*[éèàêçôùÉ][^<{]*<|"[^"]*[éèàêçôù][^"]*"' web/src --include='*.tsx' | grep -v test | grep -v '^web/src/i18n/'`
Expected: only comment lines (`//` or `{/* … */}`). Any JSX text or attribute string is a missed migration — move it to both catalogues.

- [ ] **Step 5: Commit**

```bash
git add web/src/components/IdentitiesSettings.tsx web/src/components/ForwardingSettings.tsx web/src/components/MaintenanceSettings.tsx web/src/components/IdentitiesSettings.test.tsx web/src/components/ForwardingSettings.test.tsx web/src/components/MaintenanceSettings.test.tsx
git commit -m "feat(web): translate the settings views"
```

---

### Task 6: Worker — English messages and `reason`

**Files:**
- Modify: `src/api/routes.ts`, `src/index.ts:56`, `src/auth/access.ts:36,52,81,87`, `src/send/client.ts:52,97`, `src/forwarding/destinations.ts:18,33,41`, `src/email.ts:34`, `src/admin/reimport.ts:138`
- Test: `test/api/forwarding.test.ts`, `test/api/identities.test.ts`, `test/api/mutations.test.ts`, `test/api/admin.test.ts`, `test/index.test.ts`, `test/auth/access.test.ts`, `test/email-handler.test.ts`

**Interfaces:**
- Produces: error body `{ error: { code: string; message: string; reason?: string } }`; `validationError(error: z.ZodError): { message: string; reason?: string }` (module-private in `routes.ts`).

- [ ] **Step 1: Update the tests first**

`test/api/forwarding.test.ts` — replace the two French-message tests (lines 83–96) with:

```ts
  it("renvoie un message d'erreur lisible, pas un dump JSON de zod", async () => {
    stubDestinations(["gmail@exemple.com"]);
    const res = await postRule({ matchLocal: "contact", destination: "pas-un-email" });
    const body = (await res.json()) as { error: { message: string; reason?: string } };
    expect(body.error.message.startsWith("[{")).toBe(false);
    expect(body.error.message).toContain("Invalid request");
    expect(body.error.reason).toBeUndefined();
  });

  it("signale une partie locale invalide par une raison dédiée", async () => {
    stubDestinations(["gmail@exemple.com"]);
    const res = await postRule({ matchLocal: "a b", destination: "gmail@exemple.com" });
    const body = (await res.json()) as { error: { code: string; reason?: string } };
    expect(body.error).toMatchObject({ code: "invalid_body", reason: "invalid_local_part" });
  });
```

and at line 174: `expect(body.error.message).toContain("Invalid request");`.

`test/api/identities.test.ts` — in "refuse une partie locale invalide" (line 60), after the `code` assertion, parse once and also check the reason:

```ts
    const body = (await res.json()) as { error: { code: string; reason?: string } };
    expect(body.error).toMatchObject({ code: "invalid_body", reason: "invalid_local_part" });
```

(replace the existing `expect((await res.json() …).error.code).toBe("invalid_body")` line with these two, since the body can only be read once).

`test/api/mutations.test.ts:235` → `expect(body.error.message).toBe("Provide isRead or folder");`
`test/api/admin.test.ts:85` → `message: "Invalid cursor"`
`test/index.test.ts:66` → `expect(body.error.message).toBe("Internal error");`
`test/auth/access.test.ts:92` → `/not allowed/` (the three `/configuration/i` assertions stay).
`test/email-handler.test.ts:187` → `expect(rule?.last_error).toMatch(/timed out/i);`

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm vitest run test/api test/index.test.ts test/auth test/email-handler.test.ts`
Expected: the edited assertions FAIL on the French messages.

- [ ] **Step 3: Implement**

`src/api/routes.ts`:

1. Local-part refines carry the reason through zod's `params` (zod 4 copies them onto the custom issue):

```ts
const INVALID_LOCAL_PART = { message: "Invalid local part", params: { reason: "invalid_local_part" } };
```

   and use `.refine((v) => v === CATCH_ALL || /^[a-z0-9._%+-]+$/.test(v), INVALID_LOCAL_PART)` (line 64) and `.refine((v) => /^[a-z0-9._%+-]+$/.test(v), INVALID_LOCAL_PART)` (line 82).

2. Other messages:
   - line 36: `"Provide isRead or folder"`
   - line 90: `"Provide displayName or isDefault"`
   - line 100: `"Invalid cursor"`
   - line 106: `"Invalid key: only raw incoming messages (raw/<sha256>.eml) can be re-imported"`

3. Replace the comment block (lines 113–119) and `formatValidationError` with:

```ts
// Erreur de validation renvoyée au client. Le `message` est un repli en anglais,
// destiné au développeur : l'interface affiche sa propre traduction à partir du
// `code` et, quand elle existe, de la `reason` — posée via `params` sur les
// `.refine()` qu'un utilisateur peut déclencher depuis un formulaire. Les issues
// `custom` portent un message rédigé ici même, plus précis qu'une formulation
// générique par chemin de champ : on les préfère dès qu'il en existe une.
const validationError = (error: z.ZodError): { message: string; reason?: string } => {
  const custom = error.issues.filter((issue) => issue.code === "custom");
  const reason = custom
    .map((issue) => (issue as { params?: { reason?: unknown } }).params?.reason)
    .find((r): r is string => typeof r === "string");
  const message = custom.length > 0
    ? custom.map((issue) => issue.message).join("; ")
    : `Invalid request: check ${error.issues.map((issue) => issue.path.join(".") || "the request body").join(", ")}.`;
  return reason ? { message, reason } : { message };
};
```

4. Every `message: formatValidationError(parsed.error)` becomes `...validationError(parsed.error)`:

```bash
sed -i '' 's/message: formatValidationError(parsed.error)/...validationError(parsed.error)/' src/api/routes.ts
grep -n formatValidationError src/api/routes.ts   # expect no output
```

5. Remaining messages:
   - `routingUnavailableResponse`: `"Could not read the verified destinations of the Cloudflare account"`
   - `storageUnavailableResponse`: `"Could not read message storage. Try again in a moment."`
   - `"Identifiant invalide"` → `"Invalid ID"` (all occurrences: `sed -i '' 's/"Identifiant invalide"/"Invalid ID"/' src/api/routes.ts`)
   - `"Thread introuvable"` → `"Thread not found"`; `"Identité introuvable"` → `"Identity not found"`; `"Message introuvable"` → `"Message not found"`; `"Pièce jointe introuvable"` → `"Attachment not found"`; `"Contenu introuvable"` → `"Attachment content not found"`; `"MIME brut introuvable"` → `"Raw MIME not found"`; `"Redirection introuvable"` → `"Forwarding rule not found"`
   - `"Cette identité existe déjà"` → `"Identity already exists"`; `"Impossible de supprimer la dernière identité restante"` → `"Cannot delete the last remaining identity"`; `"Expéditeur inconnu"` → `"Unknown sender"`; `"Le message dépasse 5 MiB"` → `"Message exceeds 5 MiB"`; `"Échec de l'envoi"` → `"Send failed"`; `"Cette redirection existe déjà"` → `"Forwarding rule already exists"`
   - line 474: `` `${destination} is not a verified destination on your Cloudflare account` ``

`src/index.ts:56` → `message: "Internal error"`.

`src/auth/access.ts`:
- line 36: `` `incomplete Access configuration: ${manquants.join(", ")} not set on the Worker` ``
- line 52: `` `email not allowed: ${email || "(missing)"}` ``
- line 81: `"Access token missing"`; line 87: `"Invalid token"`

`src/send/client.ts`: line 52 `"Message exceeds the 5 MiB limit"`; line 97 `` `Email Sending API responded ${res.status}` ``.

`src/forwarding/destinations.ts`: line 18 `"CF_ACCOUNT_ID or CF_ROUTING_TOKEN is not set on this Worker"`; line 33 `"Cloudflare Email Routing API: network request failed"`; line 41 `` `Cloudflare Email Routing API: status ${res.status}` ``.

`src/email.ts:34`: `` `Timed out after ${FORWARD_TIMEOUT_MS} ms: forwarding did not complete` ``.

`src/admin/reimport.ts:138`: `` `Message-ID already used by message #${clash.id}` ``.

- [ ] **Step 4: Run the whole Worker suite and typecheck; check nothing French is left**

Run: `pnpm vitest run && pnpm typecheck`
Expected: PASS.

Run: `grep -rnE '"[^"]*[éèàêçôù][^"]*"|`[^`]*[éèàêçôù][^`]*`' src | grep -vE ':\s*//'`
Expected: only comment lines and the `parse.ts:14` trailing comment.

- [ ] **Step 5: Commit**

```bash
git add src test
git commit -m "feat(api): English error messages and a reason for invalid local parts"
```

---

### Task 7: Documentation

**Files:**
- Modify: `README.md` (features section and `## Roadmap`), `AGENTS.md`

- [ ] **Step 1: README**

Remove the roadmap line `- An English translation of the interface (it is currently French-only)`. In the features list (read the section first and match its style), add one bullet:

```markdown
- Interface in English and French: it follows the browser language, and a
  selector in the sidebar remembers another choice
```

Then search the README for any statement that the interface is French-only (`grep -n -i "french" README.md`) and fix it.

- [ ] **Step 2: AGENTS.md**

Add after "## Two test suites, don't mix them":

```markdown
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
```

Also update "22 files" / "10 files" in "Two test suites" to the new counts (`ls test/**/*.test.ts | wc -l` equivalents: `find test -name '*.test.ts' | wc -l` and `find web/src -name '*.test.ts*' | wc -l`).

- [ ] **Step 3: Full verification**

Run: `pnpm test && pnpm build && pnpm typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add README.md AGENTS.md
git commit -m "docs: document the interface language and the error contract"
```
