import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
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
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/threads/1") {
        return Response.json(thread);
      }
      if (url.startsWith("/api/messages/") && url.endsWith("/body")) {
        return Response.json({ html: null, text: "corps du message", hasRemoteImages: false });
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
});
