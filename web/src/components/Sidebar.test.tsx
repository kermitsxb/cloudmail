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
