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
  destinations?: string[];
  destinationsStatus?: number;
}) =>
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url === "/api/config") return json({ mailDomain: "example.com" });
    if (url === "/api/forwarding/rules") return json(opts.rules ?? []);
    if (url === "/api/forwarding/destinations") {
      return opts.destinationsStatus === 503
        ? json({ error: { code: "routing_unavailable", message: "indisponible" } }, 503)
        : json({ destinations: opts.destinations ?? [] });
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

    await userEvent.click(await screen.findByRole("switch", { name: /Activer/ }));
    await waitFor(() => {
      const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.find(
        ([, init]) => (init as RequestInit | undefined)?.method === "PATCH",
      );
      expect(JSON.parse((call?.[1] as RequestInit).body as string)).toEqual({ enabled: false });
    });
  });
});
