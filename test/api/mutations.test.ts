import { env, applyD1Migrations } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { setRead, moveToFolder, purgeMessage } from "../../src/db/mutations";
import { app } from "../../src/index";
import type { Env } from "../../src/env";

interface TestEnv {
  DB: D1Database;
  TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
}

const testEnv = env as unknown as TestEnv;

beforeAll(async () => {
  await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
});

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM attachments"),
    env.DB.prepare("DELETE FROM recipients"),
    env.DB.prepare("DELETE FROM messages"),
    env.DB.prepare("DELETE FROM threads"),
  ]);
  await env.DB.prepare(
    "INSERT INTO threads (id, subject_norm, last_message_at, message_count, unread_count) VALUES (1, 'x', 100, 2, 2)"
  ).run();
  for (const id of [1, 2]) {
    await env.DB.prepare(
      `INSERT INTO messages (id, thread_id, message_id, direction, folder, from_addr, subject, received_at, raw_key)
       VALUES (?, 1, ?, 'in', 'inbox', 'a@b.c', 'x', 100, ?)`
    ).bind(id, `<m${id}@x>`, `raw/m${id}.eml`).run();
  }
});

describe("setRead", () => {
  it("marque lu et décrémente le compteur du thread", async () => {
    expect(await setRead(env.DB, 1, true)).toBe(true);
    const t = await env.DB.prepare("SELECT unread_count FROM threads WHERE id = 1").first<{ unread_count: number }>();
    expect(t?.unread_count).toBe(1);
  });

  it("est idempotent", async () => {
    await setRead(env.DB, 1, true);
    await setRead(env.DB, 1, true);
    const t = await env.DB.prepare("SELECT unread_count FROM threads WHERE id = 1").first<{ unread_count: number }>();
    expect(t?.unread_count).toBe(1);
  });

  it("remet non-lu et réincrémente", async () => {
    await setRead(env.DB, 1, true);
    await setRead(env.DB, 1, false);
    const t = await env.DB.prepare("SELECT unread_count FROM threads WHERE id = 1").first<{ unread_count: number }>();
    expect(t?.unread_count).toBe(2);
  });

  it("retourne false pour un message inexistant", async () => {
    expect(await setRead(env.DB, 999, true)).toBe(false);
  });

  it("ne touche pas unread_count pour un message à la corbeille", async () => {
    await moveToFolder(env.DB, 1, "trash");
    const before = await env.DB.prepare("SELECT unread_count FROM threads WHERE id = 1").first<{ unread_count: number }>();
    expect(before?.unread_count).toBe(1); // décrémenté une seule fois par moveToFolder

    await setRead(env.DB, 1, true);
    const after = await env.DB.prepare("SELECT unread_count FROM threads WHERE id = 1").first<{ unread_count: number }>();
    expect(after?.unread_count).toBe(1); // pas de seconde décrémentation
  });
});

describe("moveToFolder", () => {
  it("met un message à la corbeille et ajuste les compteurs", async () => {
    expect(await moveToFolder(env.DB, 1, "trash")).toBe(true);
    const t = await env.DB.prepare("SELECT message_count, unread_count FROM threads WHERE id = 1")
      .first<{ message_count: number; unread_count: number }>();
    expect(t).toMatchObject({ message_count: 1, unread_count: 1 });
  });

  it("accepte la restauration vers sent (pas seulement inbox)", async () => {
    await moveToFolder(env.DB, 1, "trash");
    expect(await moveToFolder(env.DB, 1, "sent")).toBe(true);
    const m = await env.DB.prepare("SELECT folder FROM messages WHERE id = 1").first<{ folder: string }>();
    expect(m?.folder).toBe("sent");
  });

  it("un aller-retour inbox <-> sent ne modifie pas les compteurs du thread", async () => {
    await moveToFolder(env.DB, 1, "sent");
    const t = await env.DB.prepare("SELECT message_count, unread_count FROM threads WHERE id = 1")
      .first<{ message_count: number; unread_count: number }>();
    expect(t).toMatchObject({ message_count: 2, unread_count: 2 });
  });

  it("retourne false pour un message inexistant", async () => {
    expect(await moveToFolder(env.DB, 999, "trash")).toBe(false);
  });

  it("séquence verrouillée : corbeille (non lu) -> lu -> restauration ramène le compteur à sa valeur juste", async () => {
    // Départ : thread à 2 messages non lus (unread_count=2, message_count=2).
    expect(await moveToFolder(env.DB, 1, "trash")).toBe(true);
    // -1 message_count, -1 unread_count (message 1 était non lu)
    let t = await env.DB.prepare("SELECT message_count, unread_count FROM threads WHERE id = 1")
      .first<{ message_count: number; unread_count: number }>();
    expect(t).toMatchObject({ message_count: 1, unread_count: 1 });

    expect(await setRead(env.DB, 1, true)).toBe(true);
    // message à la corbeille : setRead ne doit pas toucher unread_count (déjà ajusté ci-dessus)
    t = await env.DB.prepare("SELECT message_count, unread_count FROM threads WHERE id = 1")
      .first<{ message_count: number; unread_count: number }>();
    expect(t).toMatchObject({ message_count: 1, unread_count: 1 });

    expect(await moveToFolder(env.DB, 1, "inbox")).toBe(true);
    // restauration : message_count +1, mais le message est maintenant lu -> unread_count inchangé
    t = await env.DB.prepare("SELECT message_count, unread_count FROM threads WHERE id = 1")
      .first<{ message_count: number; unread_count: number }>();
    expect(t).toMatchObject({ message_count: 2, unread_count: 1 });
  });
});

describe("purgeMessage", () => {
  it("supprime la ligne D1 et les objets R2", async () => {
    await env.MAIL.put("raw/m1.eml", "brut");
    await env.MAIL.put("att/m1/0-f.pdf", "pdf");
    await env.DB.prepare(
      "INSERT INTO attachments (message_id, filename, mime_type, size, r2_key) VALUES (1, 'f.pdf', 'application/pdf', 3, 'att/m1/0-f.pdf')"
    ).run();

    expect(await purgeMessage(env as unknown as Env, 1)).toBe(true);
    expect(await env.DB.prepare("SELECT id FROM messages WHERE id = 1").first()).toBeNull();
    expect(await env.DB.prepare("SELECT id FROM attachments WHERE message_id = 1").first()).toBeNull();
    expect(await env.MAIL.get("raw/m1.eml")).toBeNull();
    expect(await env.MAIL.get("att/m1/0-f.pdf")).toBeNull();

    // Le message 1 était dans inbox et non lu : le thread (2 messages, 2 non lus au départ)
    // doit refléter qu'il n'en reste plus qu'un, encore non lu.
    const t = await env.DB.prepare("SELECT message_count, unread_count FROM threads WHERE id = 1")
      .first<{ message_count: number; unread_count: number }>();
    expect(t).toMatchObject({ message_count: 1, unread_count: 1 });
  });

  it("supprime le thread devenu vide", async () => {
    await purgeMessage(env as unknown as Env, 1);
    await purgeMessage(env as unknown as Env, 2);
    expect(await env.DB.prepare("SELECT id FROM threads WHERE id = 1").first()).toBeNull();
  });

  it("retourne false pour un message inexistant, sans toucher R2", async () => {
    expect(await purgeMessage(env as unknown as Env, 999)).toBe(false);
  });

  it("ne touche pas les compteurs quand le message purgé était déjà à la corbeille", async () => {
    // moveToFolder a déjà décrémenté message_count/unread_count au passage en corbeille ;
    // purgeMessage ne doit pas les décrémenter une seconde fois.
    await moveToFolder(env.DB, 1, "trash");
    let t = await env.DB.prepare("SELECT message_count, unread_count FROM threads WHERE id = 1")
      .first<{ message_count: number; unread_count: number }>();
    expect(t).toMatchObject({ message_count: 1, unread_count: 1 });

    expect(await purgeMessage(env as unknown as Env, 1)).toBe(true);
    t = await env.DB.prepare("SELECT message_count, unread_count FROM threads WHERE id = 1")
      .first<{ message_count: number; unread_count: number }>();
    expect(t).toMatchObject({ message_count: 1, unread_count: 1 });
  });

  it("supprime les objets R2 avant la ligne D1 : si R2 échoue, la ligne D1 reste intacte", async () => {
    await env.MAIL.put("raw/m1.eml", "brut");
    const wrappedEnv = {
      ...env,
      MAIL: {
        ...env.MAIL,
        delete: async () => {
          throw new Error("R2 indisponible");
        },
      },
    } as unknown as Env;

    await expect(purgeMessage(wrappedEnv, 1)).rejects.toThrow("R2 indisponible");

    const m = await env.DB.prepare("SELECT id FROM messages WHERE id = 1").first();
    expect(m).not.toBeNull();
    const t = await env.DB.prepare("SELECT message_count, unread_count FROM threads WHERE id = 1")
      .first<{ message_count: number; unread_count: number }>();
    expect(t).toMatchObject({ message_count: 2, unread_count: 2 });
  });
});

describe("routes /api/messages/:id", () => {
  it("répond 401 sans jeton sur PATCH /api/messages/:id", async () => {
    const res = await app.request(
      "https://example.com/api/messages/1",
      { method: "PATCH", body: JSON.stringify({ isRead: true }), headers: { "Content-Type": "application/json" } },
      { ...env, DEV_BYPASS_AUTH: undefined }
    );
    expect(res.status).toBe(401);
  });

  it("marque un message lu via PATCH", async () => {
    const res = await app.request(
      "https://example.com/api/messages/1",
      { method: "PATCH", body: JSON.stringify({ isRead: true }), headers: { "Content-Type": "application/json" } },
      { ...env, DEV_BYPASS_AUTH: "1" }
    );
    expect(res.status).toBe(200);
    const m = await env.DB.prepare("SELECT is_read FROM messages WHERE id = 1").first<{ is_read: number }>();
    expect(m?.is_read).toBe(1);
  });

  it("déplace un message vers la corbeille via PATCH", async () => {
    const res = await app.request(
      "https://example.com/api/messages/1",
      { method: "PATCH", body: JSON.stringify({ folder: "trash" }), headers: { "Content-Type": "application/json" } },
      { ...env, DEV_BYPASS_AUTH: "1" }
    );
    expect(res.status).toBe(200);
    const m = await env.DB.prepare("SELECT folder FROM messages WHERE id = 1").first<{ folder: string }>();
    expect(m?.folder).toBe("trash");
  });

  it("répond 400 pour un corps vide (ni isRead ni folder)", async () => {
    const res = await app.request(
      "https://example.com/api/messages/1",
      { method: "PATCH", body: JSON.stringify({}), headers: { "Content-Type": "application/json" } },
      { ...env, DEV_BYPASS_AUTH: "1" }
    );
    expect(res.status).toBe(400);
  });

  it("garde le message écrit à la main pour un corps vide", async () => {
    const res = await app.request(
      "https://example.com/api/messages/1",
      { method: "PATCH", body: JSON.stringify({}), headers: { "Content-Type": "application/json" } },
      { ...env, DEV_BYPASS_AUTH: "1" }
    );
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toBe("Fournir isRead ou folder");
  });

  it("répond 400 pour un identifiant non numérique via PATCH", async () => {
    const res = await app.request(
      "https://example.com/api/messages/abc",
      { method: "PATCH", body: JSON.stringify({ isRead: true }), headers: { "Content-Type": "application/json" } },
      { ...env, DEV_BYPASS_AUTH: "1" }
    );
    expect(res.status).toBe(400);
  });

  it("répond 404 pour un message inexistant via PATCH", async () => {
    const res = await app.request(
      "https://example.com/api/messages/999",
      { method: "PATCH", body: JSON.stringify({ isRead: true }), headers: { "Content-Type": "application/json" } },
      { ...env, DEV_BYPASS_AUTH: "1" }
    );
    expect(res.status).toBe(404);
  });

  it("répond 401 sans jeton sur DELETE /api/messages/:id", async () => {
    const res = await app.request(
      "https://example.com/api/messages/1",
      { method: "DELETE" },
      { ...env, DEV_BYPASS_AUTH: undefined }
    );
    expect(res.status).toBe(401);
  });

  it("purge un message via DELETE", async () => {
    const res = await app.request(
      "https://example.com/api/messages/1",
      { method: "DELETE" },
      { ...env, DEV_BYPASS_AUTH: "1" }
    );
    expect(res.status).toBe(200);
    expect(await env.DB.prepare("SELECT id FROM messages WHERE id = 1").first()).toBeNull();
  });

  it("répond 400 pour un identifiant non numérique via DELETE", async () => {
    const res = await app.request(
      "https://example.com/api/messages/abc",
      { method: "DELETE" },
      { ...env, DEV_BYPASS_AUTH: "1" }
    );
    expect(res.status).toBe(400);
  });

  it("répond 404 pour un message inexistant via DELETE", async () => {
    const res = await app.request(
      "https://example.com/api/messages/999",
      { method: "DELETE" },
      { ...env, DEV_BYPASS_AUTH: "1" }
    );
    expect(res.status).toBe(404);
  });
});
