import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderWithI18n as render } from "../test/i18n";
import { TrashNotice } from "./TrashNotice";

afterEach(() => vi.unstubAllGlobals());

const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    {children}
  </QueryClientProvider>
);

const stubConfig = (trashRetentionDays: number | null) => {
  const fetch = vi.fn(async () => Response.json({ mailDomain: "example.com", trashRetentionDays }));
  vi.stubGlobal("fetch", fetch);
  return fetch;
};

describe("TrashNotice", () => {
  it("annonce le délai de suppression", async () => {
    stubConfig(30);
    render(<TrashNotice folder="trash" />, { wrapper });
    expect(
      await screen.findByText("Les messages de la corbeille sont supprimés définitivement après 30 jours."),
    ).toBeDefined();
  });

  it("n'affiche rien quand la purge est désactivée", async () => {
    const fetch = stubConfig(null);
    const { container } = render(<TrashNotice folder="trash" />, { wrapper });
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));
    expect(container).toBeEmptyDOMElement();
  });

  it("annonce le délai de suppression du dossier Spam", async () => {
    stubConfig(30);
    render(<TrashNotice folder="spam" />, { wrapper });
    expect(
      await screen.findByText("Les messages du dossier Spam sont supprimés définitivement après 30 jours."),
    ).toBeDefined();
  });
});
