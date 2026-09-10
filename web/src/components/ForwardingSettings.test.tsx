import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ForwardingSettings } from "./ForwardingSettings";

afterEach(() => vi.unstubAllGlobals());

const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    {children}
  </QueryClientProvider>
);

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const rule = (over: Partial<Record<string, unknown>> = {}) => ({
  id: 1, matchLocal: "contact", destination: "gmail@exemple.com", enabled: true,
  createdAt: 1, lastAttemptAt: null, lastStatus: null, lastError: null, ...over,
});

// Route les appels selon le chemin : le composant en émet trois au montage
// (config, règles, destinations) et l'ordre n'est pas garanti.
const stubApi = (opts: {
  rules?: unknown[];
  rulesStatus?: number;
  configStatus?: number;
  destinations?: string[];
  destinationsStatus?: number;
  mutationStatus?: number;
  mutationPending?: boolean;
}) =>
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (url === "/api/config") {
      return opts.configStatus
        ? json({ error: { code: "internal", message: "panne" } }, opts.configStatus)
        : json({ mailDomain: "example.com" });
    }
    if (url === "/api/forwarding/rules" && (init?.method ?? "GET") === "GET") {
      return opts.rulesStatus
        ? json({ error: { code: "internal", message: "no such table: forward_rules" } }, opts.rulesStatus)
        : json(opts.rules ?? []);
    }
    if (url === "/api/forwarding/destinations") {
      return opts.destinationsStatus === 503
        ? json({ error: { code: "routing_unavailable", message: "indisponible" } }, 503)
        : json({ destinations: opts.destinations ?? [] });
    }
    // Une mutation qui ne répond jamais : la seule façon d'observer l'état
    // « envoi en cours » d'un formulaire qui se referme dès le succès.
    if (opts.mutationPending) return new Promise<Response>(() => {});
    // Les mutations (POST/PATCH/DELETE) partagent le même sort : c'est leur
    // échec qui doit devenir visible, pas la route précise qui l'a produit.
    if (opts.mutationStatus) {
      return json(
        { error: { code: "not_found", message: "Redirection introuvable" } },
        opts.mutationStatus,
      );
    }
    return json({ ok: true });
  }));

describe("ForwardingSettings", () => {
  it("liste les règles existantes", async () => {
    stubApi({ rules: [rule(), rule({ id: 2, matchLocal: "*", destination: "a@exemple.com" })] });
    render(<ForwardingSettings />, { wrapper });

    expect(await screen.findByText("contact@example.com")).toBeDefined();
    expect(screen.getByText("Toutes les adresses")).toBeDefined();
    expect(screen.getByText("gmail@exemple.com")).toBeDefined();
  });

  it("affiche l'erreur de la dernière tentative", async () => {
    stubApi({ rules: [rule({ lastStatus: "error", lastError: "destination non vérifiée" })] });
    render(<ForwardingSettings />, { wrapper });
    expect(await screen.findByText(/destination non vérifiée/)).toBeDefined();
  });

  it("annonce l'absence de règle", async () => {
    stubApi({ rules: [] });
    render(<ForwardingSettings />, { wrapper });
    expect(await screen.findByText("Aucune redirection.")).toBeDefined();
  });

  it("renvoie vers le dashboard Cloudflare sans destination vérifiée", async () => {
    stubApi({ rules: [], destinations: [] });
    render(<ForwardingSettings />, { wrapper });

    await userEvent.click(await screen.findByRole("button", { name: "Ajouter une redirection" }));
    expect(await screen.findByRole("link", { name: /dashboard Cloudflare/ })).toBeDefined();
    expect(screen.queryByRole("combobox", { name: "Vers" })).toBeNull();
  });

  it("signale une configuration de routage manquante", async () => {
    stubApi({ rules: [], destinationsStatus: 503 });
    render(<ForwardingSettings />, { wrapper });

    await userEvent.click(await screen.findByRole("button", { name: "Ajouter une redirection" }));
    expect(await screen.findByText(/Impossible de lire les destinations/)).toBeDefined();
  });

  it("crée une redirection sur une adresse", async () => {
    stubApi({ rules: [], destinations: ["gmail@exemple.com"] });
    render(<ForwardingSettings />, { wrapper });

    await userEvent.click(await screen.findByRole("button", { name: "Ajouter une redirection" }));
    await userEvent.type(await screen.findByLabelText("Partie locale"), "contact");
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Vers" }), "gmail@exemple.com");
    await userEvent.click(screen.getByRole("button", { name: "Enregistrer" }));

    await waitFor(() => {
      const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.find(
        ([, init]) => (init as RequestInit | undefined)?.method === "POST",
      );
      expect(JSON.parse((call?.[1] as RequestInit).body as string)).toEqual({
        matchLocal: "contact",
        destination: "gmail@exemple.com",
      });
    });
  });

  it("crée une redirection catch-all", async () => {
    stubApi({ rules: [], destinations: ["gmail@exemple.com"] });
    render(<ForwardingSettings />, { wrapper });

    await userEvent.click(await screen.findByRole("button", { name: "Ajouter une redirection" }));
    await userEvent.click(await screen.findByLabelText("Toutes les adresses du domaine"));
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Vers" }), "gmail@exemple.com");
    await userEvent.click(screen.getByRole("button", { name: "Enregistrer" }));

    await waitFor(() => {
      const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.find(
        ([, init]) => (init as RequestInit | undefined)?.method === "POST",
      );
      expect(JSON.parse((call?.[1] as RequestInit).body as string).matchLocal).toBe("*");
    });
  });

  it("supprime une redirection", async () => {
    stubApi({ rules: [rule()] });
    render(<ForwardingSettings />, { wrapper });

    await userEvent.click(
      await screen.findByRole("button", { name: "Supprimer la redirection contact@example.com" }),
    );
    await waitFor(() => {
      const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.find(
        ([, init]) => (init as RequestInit | undefined)?.method === "DELETE",
      );
      expect(call?.[0]).toBe("/api/forwarding/rules/1");
    });
  });

  it("bascule l'activation d'une redirection", async () => {
    stubApi({ rules: [rule()] });
    render(<ForwardingSettings />, { wrapper });

    // La règle du fixture est active : l'action offerte est donc de la désactiver.
    await userEvent.click(await screen.findByRole("switch", { name: /Désactiver/ }));
    await waitFor(() => {
      const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.find(
        ([, init]) => (init as RequestInit | undefined)?.method === "PATCH",
      );
      expect(JSON.parse((call?.[1] as RequestInit).body as string)).toEqual({ enabled: false });
    });
  });

  it("signale l'échec de lecture des règles au lieu d'un état vide", async () => {
    stubApi({ rulesStatus: 500 });
    render(<ForwardingSettings />, { wrapper });

    expect(await screen.findByText(/Impossible de lire les redirections/)).toBeDefined();
    // Un 500 ne doit surtout pas se lire comme « vous n'avez aucune redirection ».
    expect(screen.queryByText("Aucune redirection.")).toBeNull();
  });

  it("signale l'échec de la bascule dans la ligne concernée", async () => {
    stubApi({ rules: [rule()], mutationStatus: 404 });
    render(<ForwardingSettings />, { wrapper });

    await userEvent.click(await screen.findByRole("switch", { name: /Désactiver/ }));
    expect(await screen.findByText(/Activation inchangée/)).toBeDefined();
  });

  it("signale l'échec de la suppression dans la ligne concernée", async () => {
    stubApi({ rules: [rule()], mutationStatus: 404 });
    render(<ForwardingSettings />, { wrapper });

    await userEvent.click(
      await screen.findByRole("button", { name: "Supprimer la redirection contact@example.com" }),
    );
    expect(await screen.findByText(/Suppression impossible/)).toBeDefined();
  });

  it("propose de désactiver une règle active et d'activer une règle inactive", async () => {
    stubApi({ rules: [rule(), rule({ id: 2, matchLocal: "perso", enabled: false })] });
    render(<ForwardingSettings />, { wrapper });

    expect(
      await screen.findByRole("switch", { name: "Désactiver la redirection contact@example.com" }),
    ).toBeDefined();
    expect(
      screen.getByRole("switch", { name: "Activer la redirection perso@example.com" }),
    ).toBeDefined();
  });

  it("désactive Enregistrer pendant l'envoi pour empêcher un double POST", async () => {
    stubApi({ rules: [], destinations: ["gmail@exemple.com"], mutationPending: true });
    render(<ForwardingSettings />, { wrapper });

    await userEvent.click(await screen.findByRole("button", { name: "Ajouter une redirection" }));
    await userEvent.type(await screen.findByLabelText("Partie locale"), "contact");
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Vers" }), "gmail@exemple.com");
    const submit = screen.getByRole("button", { name: "Enregistrer" });
    await userEvent.click(submit);
    await waitFor(() => expect((submit as HTMLButtonElement).disabled).toBe(true));
  });

  it("n'affiche aucune adresse tronquée quand le domaine est inconnu", async () => {
    stubApi({ rules: [rule()], configStatus: 500 });
    render(<ForwardingSettings />, { wrapper });

    expect(await screen.findByText(/domaine de messagerie/i)).toBeDefined();
    expect(screen.queryByText(/contact@$/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Ajouter une redirection" })).toBeNull();
  });
});
