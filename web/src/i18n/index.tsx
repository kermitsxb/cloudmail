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
