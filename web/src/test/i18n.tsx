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
