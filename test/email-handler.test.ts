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
    env.DB.prepare("DELETE FROM forward_rules"),
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

const addRule = (matchLocal: string, destination: string, enabled = 1) =>
  env.DB.prepare(
    "INSERT INTO forward_rules (match_local, destination, enabled, created_at) VALUES (?, ?, ?, 0)"
  ).bind(matchLocal, destination, enabled).run();

const countMessages = async () =>
  (await env.DB.prepare("SELECT COUNT(*) AS n FROM messages").first<{ n: number }>())?.n;

describe("handleEmail — redirections", () => {
  it("ne forwarde rien quand aucune règle ne correspond", async () => {
    const msg = fakeMessage("simple.eml");
    await handleEmail(msg, env);
    expect(msg.forward).not.toHaveBeenCalled();
    expect(await countMessages()).toBe(1);
  });

  it("forwarde vers la destination de la règle qui correspond", async () => {
    await addRule("thomas", "gmail@exemple.com");
    const msg = fakeMessage("simple.eml");
    await handleEmail(msg, env);
    expect(msg.forward).toHaveBeenCalledWith("gmail@exemple.com");
    expect(await countMessages()).toBe(1);
  });

  it("n'envoie qu'une copie quand deux règles visent la même destination", async () => {
    await addRule("*", "gmail@exemple.com");
    await addRule("thomas", "gmail@exemple.com");
    const msg = fakeMessage("simple.eml");
    await handleEmail(msg, env);
    expect(msg.forward).toHaveBeenCalledTimes(1);
  });

  it("archive le message même si le forward échoue, et enregistre l'erreur", async () => {
    await addRule("thomas", "gmail@exemple.com");
    const msg = fakeMessage("simple.eml");
    (msg.forward as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("destination non vérifiée"));

    await expect(handleEmail(msg, env)).resolves.toBeUndefined();

    expect(await countMessages()).toBe(1);
    expect(msg.setReject).not.toHaveBeenCalled();
    const rule = await env.DB.prepare(
      "SELECT last_status, last_error FROM forward_rules LIMIT 1"
    ).first<{ last_status: string; last_error: string }>();
    expect(rule).toMatchObject({ last_status: "error", last_error: "destination non vérifiée" });
  });

  it("archive le message même si la lecture des règles échoue", async () => {
    const msg = fakeMessage("simple.eml");
    // Proxy et non un objet étalé : les méthodes de D1Database vivent sur le
    // prototype, donc `{ ...env.DB }` perdrait batch(), exec() et consorts dont
    // storeIncoming a besoin pour archiver — le test échouerait alors pour la
    // mauvaise raison.
    const brokenRules = {
      ...env,
      DB: new Proxy(env.DB, {
        get(target, prop) {
          if (prop === "prepare") {
            return (sql: string) => {
              if (sql.includes("forward_rules")) throw new Error("d1 down");
              return target.prepare(sql);
            };
          }
          const value = Reflect.get(target, prop, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      }),
    } as unknown as typeof env;

    await expect(handleEmail(msg, brokenRules)).resolves.toBeUndefined();
    expect(await countMessages()).toBe(1);
    expect(msg.setReject).not.toHaveBeenCalled();
  });

  it("forwarde même si l'archivage échoue", async () => {
    await addRule("thomas", "gmail@exemple.com");
    const msg = fakeMessage("simple.eml");
    const brokenR2 = {
      ...env,
      MAIL: {
        put: () => {
          throw new Error("r2 down");
        },
      },
    } as unknown as typeof env;

    await expect(handleEmail(msg, brokenR2)).resolves.toBeUndefined();
    expect(msg.forward).toHaveBeenCalledWith("gmail@exemple.com");
    expect(msg.setReject).not.toHaveBeenCalled();
  });

  it("forwarde avant de consommer message.raw", async () => {
    await addRule("thomas", "gmail@exemple.com");
    const msg = fakeMessage("simple.eml");
    let rawWasLockedAtForward: boolean | null = null;
    (msg.forward as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      rawWasLockedAtForward = msg.raw.locked;
    });

    await handleEmail(msg, env);
    expect(rawWasLockedAtForward).toBe(false);
  });
});
