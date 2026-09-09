import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  RoutingUnavailableError,
  listVerifiedDestinations,
} from "../../src/forwarding/destinations";

afterEach(() => vi.unstubAllGlobals());

const withRouting = () => ({ ...env, CF_ACCOUNT_ID: "acc", CF_ROUTING_TOKEN: "tok" });

describe("listVerifiedDestinations", () => {
  it("ne renvoie que les destinations vérifiées", async () => {
    vi.stubGlobal("fetch", async () =>
      Response.json({
        success: true,
        result: [
          { email: "ok@exemple.com", verified: "2026-01-01T00:00:00Z" },
          { email: "attente@exemple.com", verified: null },
        ],
      })
    );
    expect(await listVerifiedDestinations(withRouting())).toEqual(["ok@exemple.com"]);
  });

  it("appelle l'API compte avec le token de routage", async () => {
    const fetchSpy = vi.fn(async () => Response.json({ success: true, result: [] }));
    vi.stubGlobal("fetch", fetchSpy);
    await listVerifiedDestinations(withRouting());
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/accounts/acc/email/routing/addresses");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok");
  });

  it("lève RoutingUnavailableError quand le secret est absent", async () => {
    await expect(
      listVerifiedDestinations({ ...env, CF_ACCOUNT_ID: "acc", CF_ROUTING_TOKEN: "" } as typeof env)
    ).rejects.toBeInstanceOf(RoutingUnavailableError);
  });

  it("lève RoutingUnavailableError quand l'API refuse", async () => {
    vi.stubGlobal("fetch", async () =>
      Response.json({ success: false, errors: [{ message: "nope" }] }, { status: 403 })
    );
    await expect(listVerifiedDestinations(withRouting())).rejects.toBeInstanceOf(
      RoutingUnavailableError
    );
  });

  it("lève RoutingUnavailableError sur une réponse illisible", async () => {
    vi.stubGlobal("fetch", async () => new Response("pas du json", { status: 200 }));
    await expect(listVerifiedDestinations(withRouting())).rejects.toBeInstanceOf(
      RoutingUnavailableError
    );
  });

  it("lève RoutingUnavailableError quand l'API répond succès=false avec un statut 200", async () => {
    vi.stubGlobal("fetch", async () =>
      Response.json({ success: false, errors: [{ message: "nope" }] }, { status: 200 })
    );
    await expect(listVerifiedDestinations(withRouting())).rejects.toBeInstanceOf(
      RoutingUnavailableError
    );
  });

  it("lève RoutingUnavailableError quand fetch rejette (panne réseau)", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("network down");
    });
    await expect(listVerifiedDestinations(withRouting())).rejects.toBeInstanceOf(
      RoutingUnavailableError
    );
  });
});
