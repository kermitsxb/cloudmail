import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import { renderWithI18n as render } from "./test/i18n";

const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    {children}
  </QueryClientProvider>
);

const thread = {
  id: 42,
  subject: "Facture de septembre",
  snippet: "",
  lastMessageAt: 0,
  messageCount: 1,
  unreadCount: 0,
  participants: ["alice@example.com"],
  hasAttachments: false,
};

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn(async (url: string) => {
    if (url === "/api/threads/42") return Response.json({ id: 42, subject: thread.subject, messages: [] });
    if (url.startsWith("/api/threads")) return Response.json({ threads: [thread], cursor: null });
    return Response.json([]);
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  window.history.replaceState(null, "", "/");
});

const requested = () => fetchMock.mock.calls.map(([url]) => url as string);

describe("conversation dans l'URL", () => {
  it("reflète la conversation ouverte dans l'URL", async () => {
    render(<App />, { wrapper });
    await userEvent.click(await screen.findByRole("option", { name: /Facture de septembre/ }));
    expect(window.location.pathname).toBe("/inbox/42");
  });

  it("rouvre la conversation de l'URL au chargement", async () => {
    window.history.replaceState(null, "", "/trash/42");
    render(<App />, { wrapper });
    await waitFor(() => expect(requested()).toContain("/api/threads/42"));
    expect(requested().some((url) => url.startsWith("/api/threads?folder=trash"))).toBe(true);
    expect(screen.getByRole("button", { name: "Corbeille" })).toHaveAttribute("aria-current", "true");
  });

  it("change l'URL en changeant de dossier", async () => {
    window.history.replaceState(null, "", "/inbox/42");
    render(<App />, { wrapper });
    await userEvent.click(screen.getByRole("button", { name: "Envoyés" }));
    expect(window.location.pathname).toBe("/sent");
  });

  it("referme la conversation au retour arrière", async () => {
    render(<App />, { wrapper });
    await userEvent.click(await screen.findByRole("option", { name: /Facture de septembre/ }));
    expect(screen.queryByText("Sélectionnez une conversation.")).toBeNull();

    act(() => {
      window.history.replaceState(null, "", "/inbox");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(await screen.findByText("Sélectionnez une conversation.")).toBeDefined();
  });
});
