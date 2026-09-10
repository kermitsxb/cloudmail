import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IdentitiesSettings } from "./IdentitiesSettings";

afterEach(() => vi.unstubAllGlobals());

const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    {children}
  </QueryClientProvider>
);

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const identity = (over: Partial<Record<string, unknown>> = {}) => ({
  address: "thomas@example.com", displayName: "Thomas", isDefault: true, ...over,
});

const stubApi = (opts: {
  identities?: unknown[];
  identitiesStatus?: number;
  configStatus?: number;
  mutationStatus?: number;
  mutationCode?: string;
  mutationMessage?: string;
}) =>
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (url === "/api/config") {
      return opts.configStatus
        ? json({ error: { code: "internal", message: "panne" } }, opts.configStatus)
        : json({ mailDomain: "example.com" });
    }
    if (url === "/api/identities" && (init?.method ?? "GET") === "GET") {
      return opts.identitiesStatus
        ? json({ error: { code: "internal", message: "panne" } }, opts.identitiesStatus)
        : json(opts.identities ?? []);
    }
    if (opts.mutationStatus) {
      return json(
        { error: { code: opts.mutationCode ?? "not_found", message: opts.mutationMessage ?? "Identité introuvable" } },
        opts.mutationStatus,
      );
    }
    return json({ address: "a@example.com", displayName: null, isDefault: false, ok: true }, 201);
  }));

describe("IdentitiesSettings", () => {
  it("liste les identités existantes", async () => {
    stubApi({ identities: [identity(), identity({ address: "b@example.com", displayName: "B", isDefault: false })] });
    render(<IdentitiesSettings />, { wrapper });

    expect(await screen.findByText("Thomas")).toBeDefined();
    expect(screen.getByText("thomas@example.com")).toBeDefined();
    expect(screen.getByText("B")).toBeDefined();
  });

  it("annonce l'absence d'identité", async () => {
    stubApi({ identities: [] });
    render(<IdentitiesSettings />, { wrapper });
    expect(await screen.findByText("Aucune identité.")).toBeDefined();
  });

  it("affiche l'identité par défaut distinctement de celles qui ne le sont pas", async () => {
    stubApi({ identities: [identity(), identity({ address: "b@example.com", displayName: "B", isDefault: false })] });
    render(<IdentitiesSettings />, { wrapper });

    expect(await screen.findByText("Par défaut")).toBeDefined();
    expect(
      await screen.findByRole("button", { name: "Définir b@example.com comme identité par défaut" }),
    ).toBeDefined();
  });

  it("crée une identité", async () => {
    stubApi({ identities: [] });
    render(<IdentitiesSettings />, { wrapper });

    await userEvent.click(await screen.findByRole("button", { name: "Ajouter une identité" }));
    await userEvent.type(await screen.findByLabelText("Partie locale"), "thomas");
    await userEvent.type(screen.getByLabelText("Nom affiché"), "Your Name");
    await userEvent.click(screen.getByRole("button", { name: "Enregistrer" }));

    await waitFor(() => {
      const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.find(
        ([, init]) => (init as RequestInit | undefined)?.method === "POST",
      );
      expect(JSON.parse((call?.[1] as RequestInit).body as string)).toEqual({
        localPart: "thomas",
        displayName: "Your Name",
      });
    });
  });

  it("définit une identité comme identité par défaut", async () => {
    stubApi({ identities: [identity(), identity({ address: "b@example.com", displayName: "B", isDefault: false })] });
    render(<IdentitiesSettings />, { wrapper });

    await userEvent.click(
      await screen.findByRole("button", { name: "Définir b@example.com comme identité par défaut" }),
    );
    await waitFor(() => {
      const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.find(
        ([, init]) => (init as RequestInit | undefined)?.method === "PATCH",
      );
      expect(call?.[0]).toBe("/api/identities/b%40example.com");
      expect(JSON.parse((call?.[1] as RequestInit).body as string)).toEqual({ isDefault: true });
    });
  });

  it("supprime une identité", async () => {
    stubApi({ identities: [identity()] });
    render(<IdentitiesSettings />, { wrapper });

    await userEvent.click(
      await screen.findByRole("button", { name: "Supprimer l'identité thomas@example.com" }),
    );
    await waitFor(() => {
      const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.find(
        ([, init]) => (init as RequestInit | undefined)?.method === "DELETE",
      );
      expect(call?.[0]).toBe("/api/identities/thomas%40example.com");
    });
  });

  it("signale l'échec de suppression de la dernière identité restante", async () => {
    stubApi({
      identities: [identity()],
      mutationStatus: 409,
      mutationCode: "last_identity",
      mutationMessage: "Impossible de supprimer la dernière identité restante",
    });
    render(<IdentitiesSettings />, { wrapper });

    await userEvent.click(
      await screen.findByRole("button", { name: "Supprimer l'identité thomas@example.com" }),
    );
    expect(await screen.findByText(/dernière identité restante/)).toBeDefined();
  });

  it("signale l'échec de lecture des identités au lieu d'un état vide", async () => {
    stubApi({ identitiesStatus: 500 });
    render(<IdentitiesSettings />, { wrapper });

    expect(await screen.findByText(/Impossible de lire les identités/)).toBeDefined();
    expect(screen.queryByText("Aucune identité.")).toBeNull();
  });
});
