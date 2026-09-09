import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  useCreateForwardRule,
  useDeleteForwardRule,
  useForwardRules,
  useThreads,
} from "./client";

const wrapper = ({ children }: { children: ReactNode }) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
};

let calls: string[];

beforeEach(() => {
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      calls.push(url);
      // Première page : un curseur ; page suivante : plus rien.
      return url.includes("cursor=")
        ? Response.json({ threads: [{ id: 2 }], cursor: null })
        : Response.json({ threads: [{ id: 1 }], cursor: "Y3Vyc2V1ci0x" });
    }),
  );
});

describe("useThreads", () => {
  // Régression : le back-end paginait par curseur et renvoyait `cursor`, mais le front ne le
  // renvoyait jamais et rien ne demandait la page suivante — seules les 30 conversations les
  // plus récentes (limite par défaut du back-end) étaient atteignables, recherche comprise.
  it("demande la page suivante avec le curseur reçu", async () => {
    const { result } = renderHook(() => useThreads("inbox", ""), { wrapper });

    await waitFor(() => expect(result.current.hasNextPage).toBe(true));
    expect(calls[0]).toBe("/api/threads?folder=inbox");

    result.current.fetchNextPage();

    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1]).toBe("/api/threads?folder=inbox&cursor=Y3Vyc2V1ci0x");
    await waitFor(() =>
      expect(result.current.data?.pages.flatMap((p) => p.threads).map((t) => t.id)).toEqual([1, 2]),
    );
    // Le back-end renvoie cursor: null sur la dernière page : la pagination s'arrête.
    await waitFor(() => expect(result.current.hasNextPage).toBe(false));
  });

  it("transporte la recherche dans chaque page", async () => {
    const { result } = renderHook(() => useThreads("inbox", "facture"), { wrapper });
    await waitFor(() => expect(result.current.hasNextPage).toBe(true));
    result.current.fetchNextPage();
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1]).toContain("q=facture");
    expect(calls[1]).toContain("cursor=Y3Vyc2V1ci0x");
  });
});

describe("hooks de redirection", () => {
  it("useForwardRules lit /api/forwarding/rules", async () => {
    const fetchSpy = vi.fn(async (_url: string, _init: RequestInit) =>
      new Response(JSON.stringify([
        {
          id: 1, matchLocal: "*", destination: "a@exemple.com", enabled: true,
          createdAt: 1, lastAttemptAt: null, lastStatus: null, lastError: null,
        },
      ]), { status: 200, headers: { "content-type": "application/json" } })
    );
    vi.stubGlobal("fetch", fetchSpy);

    const { result } = renderHook(() => useForwardRules(), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(fetchSpy.mock.calls[0][0]).toBe("/api/forwarding/rules");
    expect(result.current.data?.[0].matchLocal).toBe("*");
  });

  it("useCreateForwardRule poste la règle", async () => {
    const fetchSpy = vi.fn(async (_url: string, _init: RequestInit) =>
      new Response(JSON.stringify({ id: 1 }), {
        status: 201, headers: { "content-type": "application/json" },
      })
    );
    vi.stubGlobal("fetch", fetchSpy);

    const { result } = renderHook(() => useCreateForwardRule(), { wrapper });
    result.current.mutate({ matchLocal: "contact", destination: "a@exemple.com" });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe("/api/forwarding/rules");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({
      matchLocal: "contact",
      destination: "a@exemple.com",
    });
  });

  it("useDeleteForwardRule appelle DELETE sur l'identifiant", async () => {
    const fetchSpy = vi.fn(async (_url: string, _init: RequestInit) =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200, headers: { "content-type": "application/json" },
      })
    );
    vi.stubGlobal("fetch", fetchSpy);

    const { result } = renderHook(() => useDeleteForwardRule(), { wrapper });
    result.current.mutate(7);
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe("/api/forwarding/rules/7");
    expect(init.method).toBe("DELETE");
  });
});
