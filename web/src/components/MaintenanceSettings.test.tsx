import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderWithI18n as render } from "../test/i18n";
import { MaintenanceSettings } from "./MaintenanceSettings";

afterEach(() => vi.unstubAllGlobals());

const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    {children}
  </QueryClientProvider>
);

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const k = (n: number) => `raw/${String(n).padStart(64, "0")}.eml`;
const orphan = (n: number) => ({ key: k(n), size: 2048, uploaded: "2026-09-20T10:00:00.000Z" });

type Stub = {
  orphanPages?: Record<string, unknown>; // curseur ("" pour la première page) -> réponse
  failOrphanCursor?: string;
  parseErrors?: unknown[];
  reimport?: (keys: string[]) => unknown[];
  maintenance?: unknown;
  orphanCheck?: { status: number; body: unknown };
};

const stubApi = (opts: Stub) => {
  const posts: string[][] = [];
  const calls: string[] = [];
  const failed = new Set<string>();
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    calls.push(`${init?.method ?? "GET"} ${url}`);
    if (url === "/api/admin/maintenance/orphan-check") {
      const r = opts.orphanCheck ?? { status: 200, body: {} };
      return json(r.body, r.status);
    }
    if (url === "/api/admin/maintenance") {
      return json(opts.maintenance ?? { retentionDays: 30, lastRun: null, lastCheck: null });
    }
    if (url.startsWith("/api/admin/orphans")) {
      const cursor = new URL(url, "https://x").searchParams.get("cursor") ?? "";
      // Échoue une seule fois, pour tester la reprise.
      if (cursor === opts.failOrphanCursor && !failed.has(cursor)) {
        failed.add(cursor);
        return json({ error: { code: "storage_unavailable", message: "Stockage indisponible" } }, 503);
      }
      return json(opts.orphanPages?.[cursor] ?? { orphans: [], cursor: null });
    }
    if (url.startsWith("/api/admin/parse-errors")) {
      return json({ messages: opts.parseErrors ?? [], cursor: null });
    }
    if (url === "/api/admin/reimport") {
      const { keys } = JSON.parse(String(init!.body)) as { keys: string[] };
      posts.push(keys);
      return json({ results: (opts.reimport ?? ((ks) => ks.map((key) => ({ key, outcome: "imported", messageIds: [1] }))))(keys) });
    }
    return json({});
  }));
  // `calls` non énumérable : les tests existants comparent `posts` par égalité structurelle
  // (toEqual([[...]])), qui échouerait si une propriété supplémentaire apparaissait dessus.
  Object.defineProperty(posts, "calls", { value: calls, enumerable: false });
  return posts as string[][] & { calls: string[] };
};

describe("MaintenanceSettings — orphelins", () => {
  it("parcourt toutes les pages de l'analyse", async () => {
    stubApi({
      orphanPages: {
        "": { orphans: [orphan(1)], cursor: "c1" },
        c1: { orphans: [], cursor: "c2" },
        c2: { orphans: [orphan(2)], cursor: null },
      },
    });
    render(<MaintenanceSettings />, { wrapper });

    await userEvent.click(screen.getByRole("button", { name: "Analyser le stockage" }));

    expect(await screen.findByText(k(1))).toBeDefined();
    expect(await screen.findByText(k(2))).toBeDefined();
  });

  it("annonce l'absence d'orphelin", async () => {
    stubApi({});
    render(<MaintenanceSettings />, { wrapper });
    await userEvent.click(screen.getByRole("button", { name: "Analyser le stockage" }));
    expect(await screen.findByText("Aucun message orphelin.")).toBeDefined();
  });

  it("garde les orphelins trouvés et reprend depuis la page en échec", async () => {
    stubApi({
      orphanPages: {
        "": { orphans: [orphan(1)], cursor: "c1" },
        c1: { orphans: [orphan(2)], cursor: null },
      },
      failOrphanCursor: "c1",
    });
    render(<MaintenanceSettings />, { wrapper });

    await userEvent.click(screen.getByRole("button", { name: "Analyser le stockage" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Stockage indisponible");
    expect(screen.getByText(k(1))).toBeDefined();

    await userEvent.click(screen.getByRole("button", { name: "Reprendre" }));
    expect(await screen.findByText(k(2))).toBeDefined();
    expect(screen.getAllByText(k(1))).toHaveLength(1);
  });

  it("réimporte la sélection par lots de dix et affiche chaque résultat", async () => {
    const orphans = Array.from({ length: 12 }, (_, i) => orphan(i));
    const posts = stubApi({
      orphanPages: { "": { orphans, cursor: null } },
      reimport: (keys) => keys.map((key) =>
        key === k(0) ? { key, outcome: "duplicate", messageIds: [7] } : { key, outcome: "imported", messageIds: [1] }),
    });
    render(<MaintenanceSettings />, { wrapper });
    await userEvent.click(screen.getByRole("button", { name: "Analyser le stockage" }));
    await screen.findByText(k(11));

    await userEvent.click(screen.getByRole("checkbox", { name: "Tout sélectionner" }));
    await userEvent.click(screen.getByRole("button", { name: "Réimporter la sélection (12)" }));

    await waitFor(() => expect(posts.map((p) => p.length)).toEqual([10, 2]));
    const row = screen.getByText(k(0)).closest("li")!;
    expect(await within(row).findByText("Déjà présent (message #7)")).toBeDefined();
    expect(screen.getAllByText("Importé")).toHaveLength(11);
  });
});

describe("MaintenanceSettings — erreurs d'analyse", () => {
  it("liste les messages en erreur et les réimporte tous", async () => {
    const posts = stubApi({
      parseErrors: [
        { id: 2, rawKey: k(2), subject: "Relevé", receivedAt: 1757318400 },
        { id: 1, rawKey: k(1), subject: null, receivedAt: 1757318400 },
      ],
      reimport: (keys) => keys.map((key) =>
        key === k(1) ? { key, outcome: "error", error: "D1 indisponible" } : { key, outcome: "reparsed", messageIds: [2] }),
    });
    render(<MaintenanceSettings />, { wrapper });

    expect(await screen.findByText("Relevé")).toBeDefined();
    expect(screen.getByText("(sans objet)")).toBeDefined();

    await userEvent.click(screen.getByRole("button", { name: "Tout réimporter (2)" }));

    await waitFor(() => expect(posts).toEqual([[k(2), k(1)]]));
    expect(await screen.findByText("1 réanalysé(s), 1 échec(s)")).toBeDefined();
    expect(screen.getByText(`${k(1)} — Échec : D1 indisponible`)).toBeDefined();
  });

  it("annonce l'absence de message en erreur", async () => {
    stubApi({});
    render(<MaintenanceSettings />, { wrapper });
    expect(await screen.findByText("Aucun message en erreur d'analyse.")).toBeDefined();
  });
});

describe("MaintenanceSettings — anglais", () => {
  it("s'affiche en anglais", async () => {
    stubApi({});
    render(<MaintenanceSettings />, { wrapper, locale: "en" });
    await userEvent.click(screen.getByRole("button", { name: "Scan storage" }));
    expect(await screen.findByText("No orphaned messages.")).toBeDefined();
  });
});

const run = (over: Record<string, unknown> = {}) => ({
  id: 1, ranAt: 1_790_000_000, trigger: "cron", trashPurged: null, trashFailed: null, trashRemaining: null,
  orphansCount: 0, orphansComplete: true, orphansSample: [], error: null, ...over,
});

describe("MaintenanceSettings — maintenance planifiée", () => {
  it("indique qu'aucun passage n'a encore eu lieu", async () => {
    stubApi({});
    render(<MaintenanceSettings />, { wrapper });
    expect(await screen.findByText("Aucun passage planifié pour l'instant.")).toBeDefined();
    expect(screen.getByText("Stockage jamais vérifié.")).toBeDefined();
    expect(screen.getByText("La corbeille est vidée des messages de plus de 30 jours.")).toBeDefined();
  });

  it("résume le dernier passage et la dernière vérification", async () => {
    stubApi({
      maintenance: {
        retentionDays: 30,
        lastRun: run({ trashPurged: 12, trashFailed: 1, trashRemaining: 3 }),
        lastCheck: run({ orphansCount: 3 }),
      },
    });
    render(<MaintenanceSettings />, { wrapper });
    expect(await screen.findByText("12 messages supprimés de la corbeille")).toBeDefined();
    expect(screen.getByText("1 suppression en échec")).toBeDefined();
    expect(screen.getByText("3 messages restent à supprimer au prochain passage")).toBeDefined();
    expect(screen.getByText(/3 messages orphelins détectés/)).toBeDefined();
  });

  it("signale une vérification partielle", async () => {
    stubApi({ maintenance: { retentionDays: 30, lastRun: null, lastCheck: run({ orphansCount: 4, orphansComplete: false }) } });
    render(<MaintenanceSettings />, { wrapper });
    expect(await screen.findByText(/Vérification partielle : 4 orphelins parmi les 10 000 premiers objets/)).toBeDefined();
  });

  it("indique une purge désactivée et l'erreur du dernier passage", async () => {
    stubApi({ maintenance: { retentionDays: null, lastRun: run({ error: "orphans: R2 indisponible" }), lastCheck: null } });
    render(<MaintenanceSettings />, { wrapper });
    expect(await screen.findByText("Purge automatique de la corbeille désactivée.")).toBeDefined();
    expect(screen.getByText("Erreur lors du passage : orphans: R2 indisponible")).toBeDefined();
  });

  it("relance la vérification et rafraîchit l'état", async () => {
    const api = stubApi({ orphanCheck: { status: 200, body: run({ trigger: "manual" }) } });
    render(<MaintenanceSettings />, { wrapper });
    await userEvent.click(await screen.findByRole("button", { name: "Relancer la vérification" }));
    await waitFor(() =>
      expect(api.calls.filter((c) => c === "GET /api/admin/maintenance").length).toBeGreaterThanOrEqual(2),
    );
    expect(api.calls).toContain("POST /api/admin/maintenance/orphan-check");
  });

  it("affiche l'échec d'une vérification relancée", async () => {
    stubApi({ orphanCheck: { status: 503, body: { error: { code: "storage_unavailable", message: "x" } } } });
    render(<MaintenanceSettings />, { wrapper });
    await userEvent.click(await screen.findByRole("button", { name: "Relancer la vérification" }));
    expect(await screen.findByText("Stockage indisponible : réessayez dans un instant.")).toBeDefined();
  });

  it("relance la vérification après un réimport qui a importé un message", async () => {
    const api = stubApi({ orphanPages: { "": { orphans: [orphan(1)], cursor: null } } });
    render(<MaintenanceSettings />, { wrapper });
    await userEvent.click(screen.getByRole("button", { name: "Analyser le stockage" }));
    await userEvent.click(await screen.findByLabelText(`Sélectionner ${k(1)}`));
    await userEvent.click(screen.getByRole("button", { name: "Réimporter la sélection (1)" }));
    await waitFor(() => expect(api.calls).toContain("POST /api/admin/maintenance/orphan-check"));
  });
});
