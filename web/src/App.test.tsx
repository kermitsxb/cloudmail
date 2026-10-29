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

  it("remplace l'entrée d'historique en refermant une conversation supprimée", async () => {
    const message = {
      id: 10, messageId: "<a@example.com>", direction: "in", folder: "inbox",
      from: { address: "zoe@example.com", name: null }, to: [{ address: "me@example.com", name: null }], cc: [],
      subject: thread.subject, text: "Bonjour", html: null, receivedAt: 1, isRead: true,
      parseError: false, bodyTruncated: false, rawKey: "raw/a.eml", attachments: [],
    };
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === "/api/threads/43") return Response.json({ id: 43, subject: thread.subject, messages: [message] });
      if (url.endsWith("/body")) return Response.json({ html: null, text: "corps", hasRemoteImages: false });
      if (init?.method === "PATCH") return Response.json({ ok: true });
      if (url.startsWith("/api/threads")) return Response.json({ threads: [{ ...thread, id: 43 }], cursor: null });
      return Response.json([]);
    });
    // Le client React Query de App est partagé entre les tests : un id propre à ce test
    // évite de relire la conversation 42 (sans message) mise en cache par les autres.
    window.history.replaceState(null, "", "/inbox/43");
    render(<App />, { wrapper });
    const push = vi.spyOn(window.history, "pushState");
    const replace = vi.spyOn(window.history, "replaceState");
    await userEvent.click(await screen.findByRole("button", { name: "Supprimer" }));
    await waitFor(() => expect(window.location.pathname).toBe("/inbox"));
    expect(replace).toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
    push.mockRestore();
    replace.mockRestore();
  });
});
