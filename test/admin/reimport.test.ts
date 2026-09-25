import { env, applyD1Migrations } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { listOrphans, listParseErrors, reimportKey } from "../../src/admin/reimport";
import { storeIncoming } from "../../src/ingest/store";
import { moveToFolder, setRead } from "../../src/db/mutations";

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

// Ingère un brut comme le ferait handleEmail, sans redirection.
const ingest = async (raw: ArrayBuffer) => {
  const res = await storeIncoming(env, raw, { from: "zoe@example.com", to: "thomas@example.com" });
  return { id: res.messageId!, rawKey: res.rawKey };
};

const messageRow = (id: number) =>
  env.DB.prepare(
    "SELECT id, message_id, thread_id, folder, is_read, subject, parse_error FROM messages WHERE id = ?"
  ).bind(id).first<{
    id: number; message_id: string; thread_id: number; folder: string;
    is_read: number; subject: string | null; parse_error: number;
  }>();

const threadTotals = () =>
  env.DB.prepare("SELECT COUNT(*) AS n, SUM(message_count) AS mc, SUM(unread_count) AS uc FROM threads")
    .first<{ n: number; mc: number; uc: number }>();

const countMessages = async () =>
  (await env.DB.prepare("SELECT COUNT(*) AS n FROM messages").first<{ n: number }>())!.n;

const NO_MESSAGE_ID = "From: zoe@example.com\r\nTo: thomas@example.com\r\nSubject: Sans identifiant\r\n\r\nBonjour\r\n";

// Deux pièces jointes, pour observer un échec d'écriture R2 après la première.
const TWO_ATTACHMENTS = [
  "From: a@example.com",
  "To: thomas@example.com",
  "Subject: Deux PJ",
  "Message-ID: <two-att@example.com>",
  "Date: Mon, 08 Sep 2026 12:00:00 +0200",
  'Content-Type: multipart/mixed; boundary="b3"',
  "",
  "--b3",
  "Content-Type: text/plain; charset=utf-8",
  "",
  "Voir les pièces jointes.",
  "--b3",
  'Content-Type: text/csv; name="un.csv"',
  'Content-Disposition: attachment; filename="un.csv"',
  "Content-Transfer-Encoding: base64",
  "",
  "YSxiCjEsMgo=",
  "--b3",
  'Content-Type: text/csv; name="deux.csv"',
  'Content-Disposition: attachment; filename="deux.csv"',
  "Content-Transfer-Encoding: base64",
  "",
  "YywkCjMsNAo=",
  "--b3--",
].join("\r\n");

describe("reimportKey — orphelins", () => {
  it("importe un orphelin comme un message neuf, non lu, en boîte de réception", async () => {
    const raw = loadBytes("simple.eml");
    const key = await rawKeyOf(raw);
    await env.MAIL.put(key, raw);

    const result = await reimportKey(env, key, "dev@localhost");

    expect(result).toMatchObject({ key, outcome: "imported" });
    const id = (result as { messageIds: number[] }).messageIds[0];
    expect(await messageRow(id)).toMatchObject({ folder: "inbox", is_read: 0, message_id: "<simple-1@example.com>" });
  });

  it("signale en doublon un orphelin dont le Message-ID existe déjà sous un autre brut", async () => {
    const first = await ingest(loadBytes("simple.eml"));
    // Même message, octets différents (un en-tête Received de plus) : autre clé, même Message-ID.
    const copy = textBytes(`Received: from relay.example.com\r\n${new TextDecoder().decode(loadBytes("simple.eml"))}`);
    const key = await rawKeyOf(copy);
    await env.MAIL.put(key, copy);

    const result = await reimportKey(env, key, "dev@localhost");

    expect(result).toEqual({ key, outcome: "duplicate", messageIds: [first.id] });
    expect(await countMessages()).toBe(1);
  });

  it("renvoie not_found quand l'objet R2 n'existe pas", async () => {
    const key = `raw/${"0".repeat(64)}.eml`;
    expect(await reimportKey(env, key, "dev@localhost")).toEqual({ key, outcome: "not_found" });
  });
});

describe("reimportKey — réanalyse sur place", () => {
  it("remplace le contenu issu du parsing et conserve id, thread, dossier et état lu", async () => {
    const msg = await ingest(loadBytes("simple.eml"));
    await setRead(env.DB, msg.id, true);
    // Simule un ancien parsing défectueux.
    await env.DB.prepare("UPDATE messages SET subject = 'ancien', parse_error = 1 WHERE id = ?").bind(msg.id).run();
    const before = await messageRow(msg.id);
    const totalsBefore = await threadTotals();

    const result = await reimportKey(env, msg.rawKey, "dev@localhost");

    expect(result).toEqual({ key: msg.rawKey, outcome: "reparsed", messageIds: [msg.id] });
    expect(await messageRow(msg.id)).toMatchObject({
      id: msg.id,
      thread_id: before!.thread_id,
      folder: "inbox",
      is_read: 1,
      subject: "Facture réglée",
      parse_error: 0,
    });
    expect(await threadTotals()).toEqual(totalsBefore);
    expect(await countMessages()).toBe(1);
  });

  it("laisse un message de la corbeille à la corbeille sans toucher aux compteurs", async () => {
    const msg = await ingest(loadBytes("simple.eml"));
    await moveToFolder(env.DB, msg.id, "trash");
    const totalsBefore = await threadTotals();

    await reimportKey(env, msg.rawKey, "dev@localhost");

    expect(await messageRow(msg.id)).toMatchObject({ folder: "trash", is_read: 0 });
    expect(await threadTotals()).toEqual(totalsBefore);
  });

  it("conserve la date déjà en base pour un message dont la date a été inventée", async () => {
    const msg = await ingest(loadBytes("malformed.eml"));
    await env.DB.prepare("UPDATE messages SET received_at = 1700000000 WHERE id = ?").bind(msg.id).run();
    const totalsBefore = await threadTotals();

    await reimportKey(env, msg.rawKey, "dev@localhost");

    const row = await env.DB.prepare("SELECT received_at FROM messages WHERE id = ?").bind(msg.id).first<{ received_at: number }>();
    expect(row!.received_at).toBe(1700000000);
    expect(await threadTotals()).toEqual(totalsBefore);
  });

  it("reprend la date de l'en-tête pour un message dont la date a été correctement analysée", async () => {
    const msg = await ingest(loadBytes("simple.eml"));
    const original = (await env.DB.prepare("SELECT received_at FROM messages WHERE id = ?").bind(msg.id).first<{ received_at: number }>())!.received_at;
    await env.DB.prepare("UPDATE messages SET received_at = 1700000000 WHERE id = ?").bind(msg.id).run();

    await reimportKey(env, msg.rawKey, "dev@localhost");

    const row = await env.DB.prepare("SELECT received_at FROM messages WHERE id = ?").bind(msg.id).first<{ received_at: number }>();
    expect(row!.received_at).toBe(original);
    expect(row!.received_at).not.toBe(1700000000);
  });

  it("ne duplique pas un message dont le Message-ID a été inventé", async () => {
    const msg = await ingest(loadBytes("malformed.eml"));
    const before = await messageRow(msg.id);

    const result = await reimportKey(env, msg.rawKey, "dev@localhost");

    expect(result).toMatchObject({ outcome: "reparsed", messageIds: [msg.id] });
    expect(await countMessages()).toBe(1);
    expect((await messageRow(msg.id))!.message_id).toBe(before!.message_id);
  });

  it("réanalyse chaque ligne qui partage le même brut", async () => {
    // Deux livraisons identiques d'un message sans Message-ID : même clé, deux lignes.
    const a = await ingest(textBytes(NO_MESSAGE_ID));
    const b = await ingest(textBytes(NO_MESSAGE_ID));
    expect(a.rawKey).toBe(b.rawKey);
    const ids = [(await messageRow(a.id))!.message_id, (await messageRow(b.id))!.message_id];

    const result = await reimportKey(env, a.rawKey, "dev@localhost");

    expect(result).toMatchObject({ outcome: "reparsed", messageIds: [a.id, b.id] });
    expect(await countMessages()).toBe(2);
    expect([(await messageRow(a.id))!.message_id, (await messageRow(b.id))!.message_id]).toEqual(ids);
  });

  it("supprime les anciennes pièces jointes remplacées, après validation", async () => {
    const msg = await ingest(loadBytes("attachment.eml"));
    // Simule une pièce jointe rangée sous une clé que le nouveau parsing ne produit plus.
    await env.MAIL.put("att/ancien/0-vieux.csv", "x");
    await env.DB.prepare("UPDATE attachments SET r2_key = 'att/ancien/0-vieux.csv' WHERE message_id = ?").bind(msg.id).run();

    await reimportKey(env, msg.rawKey, "dev@localhost");

    expect(await env.MAIL.head("att/ancien/0-vieux.csv")).toBeNull();
    const att = await env.DB.prepare("SELECT r2_key FROM attachments WHERE message_id = ?").bind(msg.id).first<{ r2_key: string }>();
    expect(att!.r2_key).toBe("att/att-1-example.com/0-data.csv");
    expect(await env.MAIL.head(att!.r2_key)).not.toBeNull();
  });

  it("échoue sans rien modifier quand le nouveau Message-ID appartient à un autre message", async () => {
    const msg = await ingest(loadBytes("simple.eml"));
    await env.DB.prepare("UPDATE messages SET message_id = '<ancien@example.com>' WHERE id = ?").bind(msg.id).run();
    const other = await insertRow({ rawKey: "raw/autre.eml", messageId: "<simple-1@example.com>" });

    const result = await reimportKey(env, msg.rawKey, "dev@localhost");

    expect(result).toMatchObject({ key: msg.rawKey, outcome: "error" });
    expect((result as { error: string }).error).toContain(`#${other}`);
    expect((await messageRow(msg.id))!.message_id).toBe("<ancien@example.com>");
  });

  it("nettoie les pièces jointes écrites si le lot D1 échoue", async () => {
    const msg = await ingest(loadBytes("attachment.eml"));
    // Ancienne clé différente de celle que le nouveau parsing va écrire.
    await env.DB.batch([
      env.DB.prepare("UPDATE messages SET message_id = '<att-ancien@example.com>' WHERE id = ?").bind(msg.id),
      env.DB.prepare("UPDATE attachments SET r2_key = 'att/att-ancien-example.com/0-data.csv' WHERE message_id = ?").bind(msg.id),
    ]);
    await env.MAIL.put("att/att-ancien-example.com/0-data.csv", "a,b,c");
    await env.MAIL.delete("att/att-1-example.com/0-data.csv");
    const failingDb = new Proxy(env.DB, {
      get(target, prop) {
        if (prop === "batch") return async () => { throw new Error("D1 indisponible"); };
        const value = Reflect.get(target, prop);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });

    const result = await reimportKey({ ...env, DB: failingDb }, msg.rawKey, "dev@localhost");

    expect(result).toMatchObject({ outcome: "error", error: "D1 indisponible" });
    expect(await env.MAIL.head("att/att-1-example.com/0-data.csv")).toBeNull();
    expect(await env.MAIL.head("att/att-ancien-example.com/0-data.csv")).not.toBeNull();
  });

  it("nettoie les pièces jointes déjà écrites si une écriture R2 échoue en cours de réanalyse", async () => {
    // Ligne existante sans aucune pièce jointe : celles écrites pendant la réanalyse sont
    // donc entièrement nouvelles, aucune ne préexiste sous le même nom.
    const raw = textBytes(TWO_ATTACHMENTS);
    const rawKey = await rawKeyOf(raw);
    await env.MAIL.put(rawKey, raw);
    const id = await insertRow({ rawKey, messageId: "<ancien@example.com>", subject: "ancien" });
    const before = await messageRow(id);
    let attWrites = 0;
    const failingMail = new Proxy(env.MAIL, {
      get(target, prop) {
        if (prop === "put") {
          return async (key: string, ...rest: unknown[]) => {
            if (key.startsWith("att/")) {
              attWrites++;
              if (attWrites === 2) throw new Error("R2 indisponible");
            }
            return (target.put as (...a: unknown[]) => unknown)(key, ...rest);
          };
        }
        const value = Reflect.get(target, prop);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });

    const result = await reimportKey({ ...env, MAIL: failingMail }, rawKey, "dev@localhost");

    expect(result).toMatchObject({ outcome: "error", error: "R2 indisponible" });
    const remaining = await env.MAIL.list({ prefix: "att/two-att-example.com/" });
    expect(remaining.objects).toHaveLength(0);
    expect((await messageRow(id))!.subject).toBe(before!.subject);
  });
});

describe("reimportKey — garanties", () => {
  it("ne lit ni ne modifie les règles de redirection", async () => {
    await env.DB.prepare(
      "INSERT INTO forward_rules (match_local, destination, enabled, created_at) VALUES ('*', 'ext@example.com', 1, 0)"
    ).run();
    const raw = loadBytes("simple.eml");
    const key = await rawKeyOf(raw);
    await env.MAIL.put(key, raw);

    await reimportKey(env, key, "dev@localhost");

    const rule = await env.DB.prepare("SELECT last_attempt_at FROM forward_rules").first<{ last_attempt_at: number | null }>();
    expect(rule!.last_attempt_at).toBeNull();
  });

  it("ne supprime jamais le brut", async () => {
    const msg = await ingest(loadBytes("simple.eml"));
    await reimportKey(env, msg.rawKey, "dev@localhost");
    expect(await env.MAIL.head(msg.rawKey)).not.toBeNull();
  });

  it("journalise chaque réimport avec son auteur", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const key = `raw/${"0".repeat(64)}.eml`;

    await reimportKey(env, key, "dev@localhost");

    const lines = log.mock.calls.map(([line]) => JSON.parse(String(line)));
    expect(lines).toContainEqual({ event: "reimport", key, outcome: "not_found", by: "dev@localhost" });
    log.mockRestore();
  });
});
