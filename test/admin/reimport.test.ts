import { env, applyD1Migrations } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { listOrphans, listParseErrors } from "../../src/admin/reimport";

interface TestEnv {
  TEST_FIXTURES: Record<string, string>;
  TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
}

const testEnv = env as unknown as TestEnv;

beforeAll(async () => {
  await applyD1Migrations(env.DB, testEnv.TEST_MIGRATIONS);
});

// Le stockage n'est pas isolé entre tests : on vide D1 et tout le bucket R2.
const clearBucket = async () => {
  let cursor: string | undefined;
  do {
    const page = await env.MAIL.list({ cursor });
    if (page.objects.length > 0) await env.MAIL.delete(page.objects.map((o) => o.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
};

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM attachments"),
    env.DB.prepare("DELETE FROM recipients"),
    env.DB.prepare("DELETE FROM messages"),
    env.DB.prepare("DELETE FROM threads"),
    env.DB.prepare("DELETE FROM forward_rules"),
  ]);
  await clearBucket();
});

const loadBytes = (name: string): ArrayBuffer => {
  const b64 = testEnv.TEST_FIXTURES[name];
  if (!b64) throw new Error(`fixture introuvable: ${name}`);
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
};

// Clé adressée par contenu, calculée comme storeIncoming.
const rawKeyOf = async (raw: ArrayBuffer) => {
  const digest = await crypto.subtle.digest("SHA-256", raw);
  return `raw/${[...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("")}.eml`;
};

const textBytes = (s: string) => new TextEncoder().encode(s).buffer as ArrayBuffer;

// Ligne D1 minimale pointant vers un brut donné.
const insertRow = async (over: { rawKey: string; messageId: string; direction?: "in" | "out"; parseError?: number; subject?: string }) => {
  const thread = await env.DB.prepare(
    "INSERT INTO threads (subject_norm, last_message_at, message_count, unread_count) VALUES ('sujet', 0, 1, 1)"
  ).run();
  const res = await env.DB.prepare(
    `INSERT INTO messages (thread_id, message_id, direction, folder, from_addr, subject, received_at, raw_key, parse_error)
     VALUES (?, ?, ?, 'inbox', 'zoe@example.com', ?, 1757318400, ?, ?)`
  ).bind(
    thread.meta.last_row_id, over.messageId, over.direction ?? "in", over.subject ?? "Sujet",
    over.rawKey, over.parseError ?? 0,
  ).run();
  return Number(res.meta.last_row_id);
};

describe("listOrphans", () => {
  it("ne renvoie que les bruts sans ligne D1, page après page", async () => {
    const keys: string[] = [];
    for (const n of [1, 2, 3]) {
      const raw = textBytes(`Subject: orphelin ${n}\r\n\r\ncorps\r\n`);
      const key = await rawKeyOf(raw);
      await env.MAIL.put(key, raw);
      keys.push(key);
    }
    await insertRow({ rawKey: keys[1], messageId: "<connu@example.com>" });

    const found: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await listOrphans(env, { cursor, limit: 2 });
      found.push(...page.orphans.map((o) => o.key));
      cursor = page.cursor ?? undefined;
      pages++;
    } while (cursor);

    expect(pages).toBe(2);
    expect(found.sort()).toEqual([keys[0], keys[2]].sort());
  });

  it("décrit chaque orphelin par sa taille et sa date de dépôt", async () => {
    const raw = textBytes("Subject: seul\r\n\r\ncorps\r\n");
    const key = await rawKeyOf(raw);
    await env.MAIL.put(key, raw);

    const page = await listOrphans(env);

    expect(page.cursor).toBeNull();
    expect(page.orphans).toHaveLength(1);
    expect(page.orphans[0]).toMatchObject({ key, size: raw.byteLength });
    expect(Number.isNaN(Date.parse(page.orphans[0].uploaded))).toBe(false);
  });

  it("ignore les objets hors du préfixe raw/", async () => {
    await env.MAIL.put("att/a-example.com/0-data.csv", "a,b");
    const page = await listOrphans(env);
    expect(page).toEqual({ orphans: [], cursor: null });
  });
});

describe("listParseErrors", () => {
  it("liste les messages reçus en erreur d'analyse, du plus récent au plus ancien, par pages", async () => {
    const a = await insertRow({ rawKey: "raw/a.eml", messageId: "<a@example.com>", parseError: 1, subject: "A" });
    await insertRow({ rawKey: "raw/b.eml", messageId: "<b@example.com>", parseError: 0 });
    await insertRow({ rawKey: "sent/c", messageId: "<c@example.com>", parseError: 1, direction: "out" });
    const d = await insertRow({ rawKey: "raw/d.eml", messageId: "<d@example.com>", parseError: 1, subject: "D" });

    const first = await listParseErrors(env, { limit: 1 });
    expect(first.messages).toEqual([{ id: d, rawKey: "raw/d.eml", subject: "D", receivedAt: 1757318400 }]);
    expect(first.cursor).toBe(String(d));

    const second = await listParseErrors(env, { cursor: Number(first.cursor), limit: 1 });
    expect(second.messages.map((m) => m.id)).toEqual([a]);
    expect(second.cursor).toBeNull();
  });
});
