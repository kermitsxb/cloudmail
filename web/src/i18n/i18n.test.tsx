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
