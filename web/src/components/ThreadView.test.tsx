import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ThreadDetail } from "../api/client";
import { renderWithI18n as render } from "../test/i18n";
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
      to: [{ address: "contact@example.com", name: "Équipe" }],
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

function renderThreadView({
  locale,
  folder = "inbox",
  onClose = vi.fn(),
}: { locale?: "fr" | "en"; folder?: string; onClose?: () => void } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ThreadView threadId={1} folder={folder} onClose={onClose} />
    </QueryClientProvider>,
    { locale },
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
      if (url === "/api/identities") {
        return Response.json([]);
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

  it("donne l'adresse exacte de l'expéditeur et des destinataires", async () => {
    renderThreadView();
    await waitFor(() => {
      expect(screen.getAllByText("Zoé").length).toBe(2);
    });

    // Au survol, sur chaque message (replié ou non).
    for (const name of screen.getAllByText("Zoé")) {
      expect(name).toHaveAttribute("title", "zoe@example.com");
    }
    expect(screen.getByText("Bob")).toHaveAttribute("title", "bob@example.com");

    // En toutes lettres aussi, sur chaque message, replié compris : le nom seul ne
    // dit pas à quelle adresse le message a été envoyé.
    expect(screen.getAllByText("<zoe@example.com>")).toHaveLength(2);
    expect(screen.getByText("<contact@example.com>")).toBeDefined();
    expect(screen.getByText("<bob@example.com>")).toBeDefined();
  });

  it("traduit le bouton de fermeture de la boîte de dialogue de réponse", async () => {
    renderThreadView();
    await screen.findByText("Facture de septembre");

    await userEvent.click((await screen.findAllByRole("button", { name: /Répondre/ }))[0]);
    expect(await screen.findByRole("button", { name: "Fermer" })).toBeDefined();
  });

  it("traduit le bouton de fermeture en anglais", async () => {
    renderThreadView({ locale: "en" });
    await screen.findByText("Facture de septembre");

    await userEvent.click((await screen.findAllByRole("button", { name: /Reply/ }))[0]);
    expect(await screen.findByRole("button", { name: "Close" })).toBeDefined();
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

  it("s'affiche en anglais", async () => {
    // Même fixture que « déplie le dernier message par défaut… ».
    renderThreadView({ locale: "en" });
    expect(await screen.findByRole("button", { name: "Reply" })).toBeDefined();
    expect(screen.getByText(/^\d+ messages?$/)).toBeDefined();
  });
  describe("suppression", () => {
    const single = (over: Partial<ThreadDetail["messages"][number]> = {}): ThreadDetail => ({
      ...thread,
      messages: [{ ...thread.messages[1], ...over }],
    });
    const serve = (t: ThreadDetail, handler?: (url: string, init?: RequestInit) => Response | undefined) =>
      fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
        const custom = handler?.(url, init);
        if (custom) return custom;
        if (url === "/api/threads/1") return Response.json(t);
        if (url.endsWith("/body")) return Response.json({ html: null, text: "corps", hasRemoteImages: false });
        return Response.json({ ok: true });
      });
    const calls = (method: string) =>
      fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === method);
    const bodies = (method: string) => calls(method).map(([, init]) => JSON.parse(String((init as RequestInit).body ?? "null")));

    it("n'affiche pas, hors corbeille, un message déjà en corbeille", async () => {
      serve({ ...thread, messages: [thread.messages[0], { ...thread.messages[1], folder: "trash" }] });
      renderThreadView();
      expect(await screen.findByText("1 message")).toBeDefined();
      expect(screen.queryByText("Voici le complément")).toBeNull();
    });

    it("met le message à la corbeille et ferme la conversation s'il était le dernier", async () => {
      serve(single());
      const onClose = vi.fn();
      renderThreadView({ onClose });
      await userEvent.click(await screen.findByRole("button", { name: "Supprimer" }));
      await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
      expect(calls("PATCH").some(([url]) => url === "/api/messages/11")).toBe(true);
      expect(bodies("PATCH")).toContainEqual(expect.objectContaining({ id: 11, folder: "trash" }));
    });

    it("ne ferme pas la conversation s'il reste d'autres messages visibles", async () => {
      const onClose = vi.fn();
      renderThreadView({ onClose });
      await userEvent.click(await screen.findByRole("button", { name: "Supprimer" }));
      await waitFor(() => expect(bodies("PATCH")).toContainEqual(expect.objectContaining({ folder: "trash" })));
      expect(onClose).not.toHaveBeenCalled();
    });

    it("affiche la raison traduite quand le déplacement échoue, sans fermer", async () => {
      serve(single(), (_url, init) =>
        init?.method === "PATCH"
          ? Response.json({ error: { code: "purge_in_progress", message: "busy" } }, { status: 409 })
          : undefined,
      );
      const onClose = vi.fn();
      renderThreadView({ onClose });
      await userEvent.click(await screen.findByRole("button", { name: "Supprimer" }));
      const alert = await screen.findByRole("alert");
      expect(alert).toHaveTextContent(/Suppression impossible/);
      expect(onClose).not.toHaveBeenCalled();
    });

    it("dans la corbeille, n'affiche que les messages supprimés avec Restaurer et Supprimer définitivement", async () => {
      serve({ ...thread, messages: [thread.messages[0], { ...thread.messages[1], folder: "trash" }] });
      renderThreadView({ folder: "trash" });
      expect(await screen.findByText("1 message")).toBeDefined();
      expect(await screen.findByRole("button", { name: "Restaurer" })).toBeDefined();
      expect(screen.getByRole("button", { name: "Supprimer définitivement" })).toBeDefined();
      expect(screen.queryByRole("button", { name: "Supprimer" })).toBeNull();
    });

    it.each([
      ["in", "inbox"],
      ["out", "sent"],
    ] as const)("restaure un message %s vers %s", async (direction, target) => {
      serve(single({ folder: "trash", direction }));
      const onClose = vi.fn();
      renderThreadView({ folder: "trash", onClose });
      await userEvent.click(await screen.findByRole("button", { name: "Restaurer" }));
      await waitFor(() => expect(bodies("PATCH")).toContainEqual(expect.objectContaining({ id: 11, folder: target })));
      await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    });

    it("affiche une erreur quand la restauration échoue", async () => {
      serve(single({ folder: "trash" }), (_url, init) =>
        init?.method === "PATCH" ? Response.json({ error: { code: "internal_error", message: "boom" } }, { status: 500 }) : undefined,
      );
      renderThreadView({ folder: "trash" });
      await userEvent.click(await screen.findByRole("button", { name: "Restaurer" }));
      expect(await screen.findByRole("alert")).toHaveTextContent(/Restauration impossible/);
    });

    it("demande confirmation avant la suppression définitive, puis ferme", async () => {
      serve(single({ folder: "trash" }));
      const onClose = vi.fn();
      renderThreadView({ folder: "trash", onClose });

      await userEvent.click(await screen.findByRole("button", { name: "Supprimer définitivement" }));
      expect(calls("DELETE")).toHaveLength(0);
      expect(screen.getByText(/Cette action est irréversible/)).toBeDefined();

      await userEvent.click(screen.getByRole("button", { name: "Annuler" }));
      expect(calls("DELETE")).toHaveLength(0);
      expect(screen.queryByText(/Cette action est irréversible/)).toBeNull();

      await userEvent.click(screen.getByRole("button", { name: "Supprimer définitivement" }));
      await userEvent.click(screen.getByRole("button", { name: "Confirmer" }));
      await waitFor(() => expect(calls("DELETE")).toHaveLength(1));
      expect(calls("DELETE")[0][0]).toBe("/api/messages/11");
      await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    });

    it("affiche une erreur quand la suppression définitive échoue", async () => {
      serve(single({ folder: "trash" }), (_url, init) =>
        init?.method === "DELETE"
          ? Response.json({ error: { code: "purge_in_progress", message: "busy" } }, { status: 409 })
          : undefined,
      );
      const onClose = vi.fn();
      renderThreadView({ folder: "trash", onClose });
      await userEvent.click(await screen.findByRole("button", { name: "Supprimer définitivement" }));
      await userEvent.click(screen.getByRole("button", { name: "Confirmer" }));
      expect(await screen.findByRole("alert")).toHaveTextContent(/Suppression impossible/);
      expect(onClose).not.toHaveBeenCalled();
    });

    it("ne recharge pas la conversation après la purge de son dernier message", async () => {
      serve(single({ folder: "trash" }));
      renderThreadView({ folder: "trash" });
      await userEvent.click(await screen.findByRole("button", { name: "Supprimer définitivement" }));
      const before = fetchMock.mock.calls.filter(([url]) => url === "/api/threads/1").length;
      await userEvent.click(screen.getByRole("button", { name: "Confirmer" }));
      await waitFor(() => expect(calls("DELETE")).toHaveLength(1));
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(fetchMock.mock.calls.filter(([url]) => url === "/api/threads/1").length).toBe(before);
    });

    it("met toute la conversation à la corbeille en une requête, puis ferme", async () => {
      const onClose = vi.fn();
      renderThreadView({ onClose });
      await userEvent.click(await screen.findByRole("button", { name: "Supprimer la conversation" }));
      await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
      expect(calls("PATCH").filter(([url]) => url === "/api/threads/1")).toHaveLength(1);
      expect(bodies("PATCH")).toContainEqual({ trashed: true });
    });

    it("affiche une erreur quand la mise à la corbeille de la conversation échoue, sans fermer", async () => {
      serve(thread, (url, init) =>
        init?.method === "PATCH" && url === "/api/threads/1"
          ? Response.json({ error: { code: "purge_in_progress", message: "busy" } }, { status: 409 })
          : undefined,
      );
      const onClose = vi.fn();
      renderThreadView({ onClose });
      await userEvent.click(await screen.findByRole("button", { name: "Supprimer la conversation" }));
      expect(await screen.findByRole("alert")).toHaveTextContent(/Suppression impossible/);
      expect(onClose).not.toHaveBeenCalled();
    });

    it("dans la corbeille, restaure toute la conversation puis ferme", async () => {
      serve({ ...thread, messages: thread.messages.map((m) => ({ ...m, folder: "trash" })) });
      const onClose = vi.fn();
      renderThreadView({ folder: "trash", onClose });
      expect(screen.queryByRole("button", { name: "Supprimer la conversation" })).toBeNull();
      await userEvent.click(await screen.findByRole("button", { name: "Restaurer la conversation" }));
      await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
      expect(bodies("PATCH")).toContainEqual({ trashed: false });
    });

    it("demande confirmation avant de supprimer définitivement la conversation, puis ferme sans la recharger", async () => {
      serve({ ...thread, messages: thread.messages.map((m) => ({ ...m, folder: "trash" })) });
      const onClose = vi.fn();
      renderThreadView({ folder: "trash", onClose });

      await userEvent.click(await screen.findByRole("button", { name: "Supprimer définitivement la conversation" }));
      expect(calls("DELETE")).toHaveLength(0);
      expect(screen.getByText(/Supprimer définitivement les 2 messages de cette conversation/)).toBeDefined();

      await userEvent.click(screen.getByRole("button", { name: "Annuler" }));
      expect(calls("DELETE")).toHaveLength(0);

      await userEvent.click(screen.getByRole("button", { name: "Supprimer définitivement la conversation" }));
      const reloads = () =>
        fetchMock.mock.calls.filter(([url, init]) => url === "/api/threads/1" && !(init as RequestInit | undefined)?.method).length;
      const before = reloads();
      await userEvent.click(screen.getByRole("button", { name: "Confirmer" }));
      await waitFor(() => expect(calls("DELETE")).toHaveLength(1));
      expect(calls("DELETE")[0][0]).toBe("/api/threads/1");
      await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(reloads()).toBe(before);
    });

    it("affiche une erreur quand la suppression définitive de la conversation échoue", async () => {
      serve({ ...thread, messages: thread.messages.map((m) => ({ ...m, folder: "trash" })) }, (_url, init) =>
        init?.method === "DELETE"
          ? Response.json({ error: { code: "internal_error", message: "boom" } }, { status: 500 })
          : undefined,
      );
      const onClose = vi.fn();
      renderThreadView({ folder: "trash", onClose });
      await userEvent.click(await screen.findByRole("button", { name: "Supprimer définitivement la conversation" }));
      await userEvent.click(screen.getByRole("button", { name: "Confirmer" }));
      expect(await screen.findByRole("alert")).toHaveTextContent(/Suppression impossible/);
      expect(onClose).not.toHaveBeenCalled();
    });

    it("propose la suppression de la conversation en anglais", async () => {
      renderThreadView({ locale: "en" });
      expect(await screen.findByRole("button", { name: "Delete conversation" })).toBeDefined();
    });

    it("déplie le dernier message visible quand le message ouvert disparaît", async () => {
      let trashed = false;
      fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
        if (url === "/api/threads/1") {
          return Response.json({
            ...thread,
            messages: [thread.messages[0], { ...thread.messages[1], folder: trashed ? "trash" : "inbox" }],
          });
        }
        if (url.endsWith("/body")) return Response.json({ html: null, text: "corps", hasRemoteImages: false });
        if (init?.method === "PATCH" && String(init.body).includes("trash")) trashed = true;
        return Response.json({ ok: true });
      });
      renderThreadView();
      // Le message 11 est ouvert ; on le met à la corbeille, le 10 doit se déplier.
      await userEvent.click(await screen.findByRole("button", { name: "Supprimer" }));
      await waitFor(() => expect(screen.getByText("1 message")).toBeDefined());
      expect(await screen.findByRole("button", { name: "Répondre" })).toBeDefined();
    });
  });
});
