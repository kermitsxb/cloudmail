import { env, applyD1Migrations } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { handleEmail, reparse } from "../src/email";

interface TestEnv {
  TEST_FIXTURES: Record<string, string>;
  TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
}

const testEnv = env as unknown as TestEnv;

beforeAll(async () => {
  await applyD1Migrations(env.DB, testEnv.TEST_MIGRATIONS);
});

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM attachments"),
    env.DB.prepare("DELETE FROM recipients"),
    env.DB.prepare("DELETE FROM messages"),
    env.DB.prepare("DELETE FROM threads"),
  ]);
});

const loadBytes = (name: string): ArrayBuffer => {
  const b64 = testEnv.TEST_FIXTURES[name];
  if (!b64) throw new Error(`fixture introuvable: ${name}`);
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
};

const fakeMessage = (fixture: string) => {
  const bytes = loadBytes(fixture);
  return {
    from: "zoe@example.com",
    to: "thomas@example.com",
    rawSize: bytes.byteLength,
    raw: new Response(bytes).body!,
    headers: new Headers(),
    setReject: vi.fn(),
    forward: vi.fn(),
    reply: vi.fn(),
  } as unknown as ForwardableEmailMessage & { setReject: ReturnType<typeof vi.fn> };
};

describe("handleEmail", () => {
  it("persiste un message reçu", async () => {
    await handleEmail(fakeMessage("simple.eml"), env);
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM messages").first<{ n: number }>();
    expect(n?.n).toBe(1);
  });

  it("ne rejette jamais le message, même en cas d'erreur interne", async () => {
    const msg = fakeMessage("simple.eml");
    const broken = {
      ...env,
      MAIL: {
        put: () => {
          throw new Error("r2 down");
        },
      },
    } as unknown as typeof env;
    await expect(handleEmail(msg, broken)).resolves.toBeUndefined();
    expect(msg.setReject).not.toHaveBeenCalled();
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM messages").first<{ n: number }>();
    expect(n?.n).toBe(0);
  });
});

describe("reparse", () => {
  it("rejoue un message depuis R2 sans le dupliquer ni gonfler durablement les compteurs de threads", async () => {
    const msg = fakeMessage("simple.eml");
    await handleEmail(msg, env);
    const row = await env.DB.prepare("SELECT raw_key, thread_id FROM messages LIMIT 1")
      .first<{ raw_key: string; thread_id: number }>();
    expect(row).not.toBeNull();

    await reparse(env, row!.raw_key, "zoe@example.com");

    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM messages").first<{ n: number }>();
    expect(n?.n).toBe(1);

    // Sans participant restant dans l'ancien thread, resolveThread ne peut
    // plus le retrouver : le message rejoué atterrit dans un nouveau thread.
    // Ce qui compte est que la somme des compteurs sur l'ensemble des
    // threads reste cohérente avec le nombre réel de messages (pas de
    // gonflement dû à un double incrément).
    const totals = await env.DB.prepare(
      "SELECT SUM(message_count) AS mc, SUM(unread_count) AS uc FROM threads"
    ).first<{ mc: number; uc: number }>();
    expect(totals).toMatchObject({ mc: 1, uc: 1 });
  });

  it("lève si l'objet R2 est introuvable", async () => {
    await expect(reparse(env, "raw/inexistant.eml", "zoe@example.com")).rejects.toThrow();
  });
});
