import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sendEmail, payloadSize, SendError, type SendRequest } from "../../src/send/client";

const base: SendRequest = {
  from: "thomas@planigramme.fr",
  to: ["zoe@example.com"],
  subject: "Bonjour",
  text: "Salut",
};

const testEnv = () => ({ ...env, CF_ACCOUNT_ID: "acc123", CF_API_TOKEN: "tok" });

afterEach(() => vi.unstubAllGlobals());

describe("sendEmail", () => {
  it("appelle le bon endpoint avec le bon en-tête d'autorisation", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return Response.json({ result: { delivered: ["zoe@example.com"], queued: [], permanent_bounces: [] }, success: true });
    });

    const res = await sendEmail(testEnv(), base);
    expect(calls[0].url).toBe("https://api.cloudflare.com/client/v4/accounts/acc123/email/sending/send");
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe("Bearer tok");
    expect(JSON.parse(calls[0].init.body as string)).toMatchObject({
      from: "thomas@planigramme.fr",
      to: ["zoe@example.com"],
      subject: "Bonjour",
      text: "Salut",
    });
    expect(res).toEqual({ delivered: ["zoe@example.com"], queued: [], permanentBounces: [] });
  });

  it("ajoute les en-têtes de threading sur une réponse", async () => {
    let body: Record<string, unknown> = {};
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      body = JSON.parse(init.body as string);
      return Response.json({ result: { delivered: [], queued: [], permanent_bounces: [] }, success: true });
    });

    await sendEmail(testEnv(), { ...base, inReplyTo: "<parent@x>", references: ["<a@x>", "<parent@x>"] });
    expect(body.headers).toEqual({
      "In-Reply-To": "<parent@x>",
      References: "<a@x> <parent@x>",
    });
  });

  it("lève une SendError avec le statut sur une erreur 429", async () => {
    vi.stubGlobal("fetch", async () => new Response("rate limited", { status: 429 }));
    await expect(sendEmail(testEnv(), base)).rejects.toMatchObject({ status: 429 });
  });

  it("lève une SendError sur une réponse success:false", async () => {
    vi.stubGlobal("fetch", async () =>
      Response.json({ success: false, errors: [{ message: "from non vérifié" }] }, { status: 400 })
    );
    await expect(sendEmail(testEnv(), base)).rejects.toThrow(/from non vérifié/);
  });
});

describe("payloadSize", () => {
  it("compte le corps et les pièces jointes décodées", () => {
    const size = payloadSize({
      ...base,
      attachments: [{ filename: "a.bin", mimeType: "application/octet-stream", contentBase64: "AAAA" }],
    });
    expect(size).toBeGreaterThan(base.text.length);
  });

  it("dépasse la limite pour une pièce jointe de 6 MiB", () => {
    const big = "A".repeat(Math.ceil((6 * 1024 * 1024 * 4) / 3));
    expect(payloadSize({ ...base, attachments: [{ filename: "b", mimeType: "x/y", contentBase64: big }] }))
      .toBeGreaterThan(5 * 1024 * 1024);
  });
});
