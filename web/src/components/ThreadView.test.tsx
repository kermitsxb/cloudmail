import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ThreadDetail } from "../api/client";
import { ThreadView } from "./ThreadView";

const thread: ThreadDetail = {
  id: 1,
  subject: "Facture de septembre",
  messages: [
    {
      id: 10,
      messageId: "<a@example.com>",
      direction: "in",
      folder: "inbox",
      from: { address: "zoe@example.com", name: "Zoé" },
      to: [{ address: "moi@example.com", name: null }],
      cc: [],
      subject: "Facture de septembre",
      text: "Bonjour",
      html: null,
      receivedAt: 1757318400,
      isRead: false,
      parseError: false,
      bodyTruncated: false,
      rawKey: "raw/a.eml",
      attachments: [],
    },
    {
      id: 11,
      messageId: "<b@example.com>",
      direction: "in",
      folder: "inbox",
      from: { address: "zoe@example.com", name: "Zoé" },
      to: [{ address: "moi@example.com", name: null }],
      cc: [{ address: "bob@example.com", name: "Bob" }],
      subject: "Facture de septembre",
      text: "Voici le complément",
      html: null,
      receivedAt: 1757404800,
      isRead: false,
      parseError: false,
      bodyTruncated: false,
      rawKey: "raw/b.eml",
      attachments: [{ id: 99, filename: "facture.pdf", mimeType: "application/pdf", size: 1234 }],
    },
  ],
};

function renderThreadView() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ThreadView threadId={1} />
    </QueryClientProvider>,
  );
}

describe("ThreadView", () => {
  it("affiche l'erreur au lieu de rester sur « Chargement… » quand la requête échoue", async () => {
    vi.mocked(fetch).mockImplementation(async () =>
      Response.json({ error: { code: "internal_error", message: "Erreur interne" } }, { status: 500 }),
    );
    renderThreadView();
    expect(await screen.findByRole("alert")).toHaveTextContent(/Erreur interne/);
    expect(screen.queryByText("Chargement…")).toBeNull();
  });


  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/threads/1") {
        return Response.json(thread);
      }
      if (url.startsWith("/api/messages/") && url.endsWith("/body")) {
        return Response.json({ html: null, text: "corps du message", hasRemoteImages: false });
      }
      if (url === "/api/admin/reimport") {
        const { keys } = JSON.parse(String(init!.body)) as { keys: string[] };
        return Response.json({ results: keys.map((key) => ({ key, outcome: "reparsed", messageIds: [11] })) });
      }
      if (init?.method === "PATCH") {
        return Response.json({ ok: true });
      }
      return Response.json({});
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("déplie le dernier message par défaut et affiche expéditeur/destinataires/date", async () => {
    renderThreadView();
    expect(await screen.findByText("Facture de septembre")).toBeDefined();

    // Le dernier message (id 11) est déplié : ses actions sont visibles.
    await waitFor(() => {
      expect(screen.getAllByText("Zoé").length).toBe(2);
    });
    const buttons = await screen.findAllByRole("button", { name: /Répondre/ });
    expect(buttons.length).toBe(1);
    expect(screen.getByText(/Bob/)).toBeDefined();
  });

  it("marque les messages non lus comme lus avec une requête PATCH par message, sans boucle", async () => {
    renderThreadView();
    await screen.findByText("Facture de septembre");

    await waitFor(() => {
      const patchCalls = fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === "PATCH");
      expect(patchCalls.length).toBe(2);
    });

    // Laisse le temps à d'éventuels effets superflus de se déclencher, puis vérifie
    // qu'aucune requête PATCH supplémentaire n'a été émise (pas de boucle de rendu).
    await new Promise((resolve) => setTimeout(resolve, 50));
    const patchCalls = fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === "PATCH");
    expect(patchCalls.length).toBe(2);
  });

  it("affiche les pièces jointes en lien vers /api/attachments/:id", async () => {
    renderThreadView();
    const link = await screen.findByRole("link", { name: /facture.pdf/ });
    expect(link.getAttribute("href")).toBe("/api/attachments/99");
  });

  it("réimporte un message reçu et recharge la conversation", async () => {
    renderThreadView();
    const button = await screen.findByRole("button", { name: "Réimporter" });
    const threadFetchesBefore = fetchMock.mock.calls.filter(([url]) => url === "/api/threads/1").length;

    await userEvent.click(button);

    await waitFor(() => {
      const post = fetchMock.mock.calls.find(([url]) => url === "/api/admin/reimport");
      expect(JSON.parse(String((post![1] as RequestInit).body))).toEqual({ keys: ["raw/b.eml"] });
    });
    await waitFor(() => {
      const after = fetchMock.mock.calls.filter(([url]) => url === "/api/threads/1").length;
      expect(after).toBeGreaterThan(threadFetchesBefore);
    });
  });

  it("affiche le résultat quand le réimport n'aboutit pas", async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === "/api/threads/1") return Response.json(thread);
      if (url === "/api/admin/reimport") {
        return Response.json({ results: [{ key: "raw/b.eml", outcome: "not_found" }] });
      }
      if (url.endsWith("/body")) return Response.json({ html: null, text: "corps", hasRemoteImages: false });
      if (init?.method === "PATCH") return Response.json({ ok: true });
      return Response.json({});
    });
    renderThreadView();

    await userEvent.click(await screen.findByRole("button", { name: "Réimporter" }));

    expect(await screen.findByText("Introuvable dans le stockage")).toBeDefined();
  });

  it("ne propose pas le réimport pour un message envoyé", async () => {
    const sent = { ...thread, messages: [{ ...thread.messages[1], direction: "out" as const, rawKey: "sent/<b@example.com>" }] };
    fetchMock.mockImplementation(async (url: string) =>
      url === "/api/threads/1" ? Response.json(sent) : Response.json({ html: null, text: "corps", hasRemoteImages: false }),
    );
    renderThreadView();

    await screen.findByRole("button", { name: /Répondre/ });
    expect(screen.queryByRole("button", { name: "Réimporter" })).toBeNull();
  });
});
