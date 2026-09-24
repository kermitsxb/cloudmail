import { env, applyD1Migrations } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { FORWARD_TIMEOUT_MS, handleEmail, reparse } from "../src/email";
import { moveToFolder, setRead } from "../src/db/mutations";

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

  // Ingère simple.eml et renvoie sa ligne, pour les tests de rejeu ci-dessous.
  const ingestSimple = async () => {
    await handleEmail(fakeMessage("simple.eml"), env);
    return (await env.DB.prepare("SELECT id, raw_key, thread_id FROM messages LIMIT 1")
      .first<{ id: number; raw_key: string; thread_id: number }>())!;
  };

  const threadRows = () =>
    env.DB.prepare("SELECT id, message_count, unread_count FROM threads ORDER BY id")
      .all<{ id: number; message_count: number; unread_count: number }>()
      .then((r) => r.results);

  it("supprime l'ancien thread resté vide quand le message rejoué y était seul", async () => {
    const row = await ingestSimple();

    await reparse(env, row.raw_key, "zoe@example.com");

    const threads = await threadRows();
    expect(threads).toHaveLength(1);
    expect(threads[0]).toMatchObject({ message_count: 1, unread_count: 1 });
  });

  it("conserve l'ancien thread s'il contient d'autres messages", async () => {
    const row = await ingestSimple();
    // Un second message, lu, dans le même thread.
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO messages (thread_id, message_id, direction, folder, from_addr, received_at, is_read, raw_key)
         VALUES (?, 'autre@example.com', 'in', 'inbox', 'zoe@example.com', 0, 1, 'raw/autre.eml')`
      ).bind(row.thread_id),
      env.DB.prepare("UPDATE threads SET message_count = message_count + 1 WHERE id = ?").bind(row.thread_id),
    ]);

    await reparse(env, row.raw_key, "zoe@example.com");

    const old = await env.DB.prepare("SELECT message_count, unread_count FROM threads WHERE id = ?")
      .bind(row.thread_id)
      .first<{ message_count: number; unread_count: number }>();
    expect(old).not.toBeNull();
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM messages WHERE thread_id = ?")
      .bind(row.thread_id)
      .first<{ n: number }>();
    expect(old!.message_count).toBe(n!.n);
  });

  it("conserve le dossier et l'état lu du message rejoué", async () => {
    const row = await ingestSimple();
    await setRead(env.DB, row.id, true);

    await reparse(env, row.raw_key, "zoe@example.com");

    const replayed = await env.DB.prepare("SELECT folder, is_read, thread_id FROM messages LIMIT 1")
      .first<{ folder: string; is_read: number; thread_id: number }>();
    expect(replayed).toMatchObject({ folder: "inbox", is_read: 1 });
    const thread = await env.DB.prepare("SELECT message_count, unread_count FROM threads WHERE id = ?")
      .bind(replayed!.thread_id)
      .first<{ message_count: number; unread_count: number }>();
    expect(thread).toMatchObject({ message_count: 1, unread_count: 0 });
  });

  it("rejoue un message de la corbeille sans toucher aux compteurs d'un thread qui a d'autres messages", async () => {
    const row = await ingestSimple();
    // Un second message non lu dans le même thread, puis le premier part à la corbeille :
    // le thread ne compte plus que le second (message_count 1, unread_count 1).
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO messages (thread_id, message_id, direction, folder, from_addr, received_at, is_read, raw_key)
         VALUES (?, 'autre@example.com', 'in', 'inbox', 'zoe@example.com', 0, 0, 'raw/autre.eml')`
      ).bind(row.thread_id),
      env.DB.prepare(
        "UPDATE threads SET message_count = message_count + 1, unread_count = unread_count + 1 WHERE id = ?"
      ).bind(row.thread_id),
    ]);
    await moveToFolder(env.DB, row.id, "trash");

    await reparse(env, row.raw_key, "zoe@example.com");

    const replayed = await env.DB.prepare("SELECT folder, is_read FROM messages WHERE message_id != 'autre@example.com'")
      .first<{ folder: string; is_read: number }>();
    expect(replayed).toMatchObject({ folder: "trash", is_read: 0 });
    // Aucun thread ne compte le message à la corbeille ; l'autre message reste compté.
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

  it("archive le message même si le forward ne rend jamais la main", async () => {
    await addRule("thomas", "gmail@exemple.com");
    const msg = fakeMessage("simple.eml");
    // Une promesse jamais résolue : le cas qu'aucun try/catch ne rattrape, et
    // qui sans borne de temps consommerait tout le budget du handler avant la
    // moindre écriture durable.
    (msg.forward as ReturnType<typeof vi.fn>).mockReturnValue(new Promise(() => {}));

    vi.useFakeTimers();
    const done = handleEmail(msg, env);
    await vi.advanceTimersByTimeAsync(FORWARD_TIMEOUT_MS + 1);
    // On rend la main aux vrais timers avant d'attendre la fin : la suite du
    // handler passe par D1 et R2, dont les I/O ne doivent pas dépendre d'une
    // horloge figée.
    vi.useRealTimers();
    await expect(done).resolves.toBeUndefined();

    expect(await countMessages()).toBe(1);
    expect(msg.setReject).not.toHaveBeenCalled();
    const rule = await env.DB.prepare(
      "SELECT last_status, last_error FROM forward_rules LIMIT 1"
    ).first<{ last_status: string; last_error: string }>();
    expect(rule?.last_status).toBe("error");
    expect(rule?.last_error).toMatch(/délai dépassé/i);
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
