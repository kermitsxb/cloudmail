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
