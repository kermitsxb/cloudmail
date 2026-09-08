import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("harnais", () => {
  it("sert /healthz", async () => {
    const res = await SELF.fetch("https://example.com/healthz");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("expose les bindings D1 et R2", async () => {
    const row = await env.DB.prepare("SELECT 1 AS n").first<{ n: number }>();
    expect(row?.n).toBe(1);
    await env.MAIL.put("probe.txt", "hello");
    const obj = await env.MAIL.get("probe.txt");
    expect(await obj?.text()).toBe("hello");
  });
});
