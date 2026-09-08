import { env, applyD1Migrations } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { app } from "../../src/index";

interface TestEnv {
  DB: D1Database;
  MAIL: R2Bucket;
  TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
}

const testEnv = env as unknown as TestEnv;

beforeAll(async () => {
  await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);

  await env.DB.prepare(
    "INSERT OR IGNORE INTO threads (id, subject_norm, last_message_at) VALUES (1, 'x', 1)"
  ).run();
  await env.DB.prepare(
    `INSERT OR IGNORE INTO messages (id, thread_id, message_id, direction, folder, from_addr, received_at, raw_key)
     VALUES (1, 1, '<att@x>', 'in', 'inbox', 'a@b.c', 1, 'raw/att.eml')`
  ).run();
  await env.DB.prepare(
    `INSERT OR IGNORE INTO attachments (id, message_id, filename, mime_type, size, r2_key)
     VALUES (1, 1, 'rapport final.pdf', 'application/pdf', 5, 'att/att/0-rapport.pdf')`
  ).run();
  await env.DB.prepare(
    `INSERT OR IGNORE INTO attachments (id, message_id, filename, mime_type, size, r2_key)
     VALUES (2, 1, 'missing.pdf', 'application/pdf', 5, 'att/att/absent.pdf')`
  ).run();
  await env.MAIL.put("att/att/0-rapport.pdf", "%PDF%");
  await env.MAIL.put("raw/att.eml", "From: a@b.c\r\n\r\nbonjour");
});

// Les corps de ces réponses sont binaires (flux R2) : les lire avec .text() fait émettre à
// workerd un avertissement à chaque exécution de la suite. On passe par arrayBuffer() puis on
// décode explicitement, pour garder une sortie de test sans le moindre avertissement.
const bodyText = async (res: Response): Promise<string> =>
  new TextDecoder().decode(await res.arrayBuffer());

const testEnvWithBypass = () => ({ ...env, DEV_BYPASS_AUTH: "1" });
const authed = (path: string) => app.request(`https://example.com${path}`, {}, testEnvWithBypass());

describe("GET /api/attachments/:id", () => {
  it("retourne le contenu avec un nom de fichier échappé", async () => {
    const res = await authed("/api/attachments/1");
    expect(res.status).toBe(200);
    expect(await bodyText(res)).toBe("%PDF%");
    expect(res.headers.get("content-disposition")).toContain('filename="rapport final.pdf"');
  });

  it("expose aussi une forme filename* encodée UTF-8", async () => {
    const res = await authed("/api/attachments/1");
    const disp = res.headers.get("content-disposition") ?? "";
    expect(disp).toContain("filename*=UTF-8''");
  });

  it("force un type MIME sûr pour le HTML", async () => {
    await env.DB.prepare("UPDATE attachments SET mime_type = 'text/html' WHERE id = 1").run();
    const res = await authed("/api/attachments/1");
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    await env.DB.prepare("UPDATE attachments SET mime_type = 'application/pdf' WHERE id = 1").run();
  });

  it("normalise casse et paramètres pour un type whitelisté légitime (IMAGE/PNG; charset=utf-8)", async () => {
    await env.DB.prepare("UPDATE attachments SET mime_type = 'IMAGE/PNG; charset=utf-8' WHERE id = 1").run();
    const res = await authed("/api/attachments/1");
    // La casse et les paramètres légitimes (charset, name=...) sont fréquents dans les emails
    // réels : on extrait le type de base (avant le premier ';'), on le met en minuscule, puis
    // on compare EXACTEMENT à la liste blanche. Le header émis est toujours notre chaîne
    // canonique, jamais la valeur brute envoyée par l'expéditeur.
    expect(res.headers.get("content-type")).toBe("image/png");
    await env.DB.prepare("UPDATE attachments SET mime_type = 'application/pdf' WHERE id = 1").run();
  });

  it("rejette un type qui tente d'exploiter un matching par sous-chaîne (text/html; x=image/png)", async () => {
    await env.DB.prepare("UPDATE attachments SET mime_type = 'text/html; x=image/png' WHERE id = 1").run();
    const res = await authed("/api/attachments/1");
    // Si la comparaison utilisait includes()/regex plutôt qu'un parsing strict du type de
    // base, ce type pourrait être confondu avec "image/png". Le type de base réel est
    // "text/html", qui n'est jamais dans la liste blanche.
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    await env.DB.prepare("UPDATE attachments SET mime_type = 'application/pdf' WHERE id = 1").run();
  });

  it("neutralise un type MIME avec caractères de contrôle / retour à la ligne", async () => {
    await env.DB.prepare("UPDATE attachments SET mime_type = ? WHERE id = 1")
      .bind("image/png\r\nX-Injected: evil")
      .run();
    const res = await authed("/api/attachments/1");
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    expect(res.headers.get("x-injected")).toBeNull();
    await env.DB.prepare("UPDATE attachments SET mime_type = 'application/pdf' WHERE id = 1").run();
  });

  it("pose Content-Disposition: attachment (jamais inline) même pour un type sûr", async () => {
    const res = await authed("/api/attachments/1");
    const disp = res.headers.get("content-disposition") ?? "";
    expect(disp.startsWith("attachment")).toBe(true);
  });

  it("échappe un nom de fichier contenant guillemets, backslash, point-virgule et retours à la ligne", async () => {
    await env.DB.prepare("UPDATE attachments SET filename = ? WHERE id = 1")
      .bind('evil".eml"; filename="pwn\r\nX-Injected: yes\\.pdf')
      .run();
    const res = await authed("/api/attachments/1");
    expect(res.status).toBe(200);
    const disp = res.headers.get("content-disposition") ?? "";
    expect(disp).not.toContain("\r");
    expect(disp).not.toContain("\n");
    expect(res.headers.get("x-injected")).toBeNull();
    // le nom échappé ne doit pas contenir de guillemet non échappé qui romprait le paramètre
    const filenameMatch = disp.match(/filename="([^]*?)"(;|$)/);
    expect(filenameMatch).not.toBeNull();
    await env.DB.prepare("UPDATE attachments SET filename = 'rapport final.pdf' WHERE id = 1").run();
  });

  it("gère un nom de fichier non-ASCII (accents, emoji) sans casser le parsing", async () => {
    await env.DB.prepare("UPDATE attachments SET filename = ? WHERE id = 1")
      .bind("facture été 😀.pdf")
      .run();
    const res = await authed("/api/attachments/1");
    expect(res.status).toBe(200);
    const disp = res.headers.get("content-disposition") ?? "";
    expect(disp).toContain("filename*=UTF-8''");
    expect(disp).toContain(encodeURIComponent("facture été 😀.pdf"));
    await env.DB.prepare("UPDATE attachments SET filename = 'rapport final.pdf' WHERE id = 1").run();
  });

  it("pose X-Content-Type-Options: nosniff", async () => {
    const res = await authed("/api/attachments/1");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("retourne 404 pour une pièce jointe inconnue", async () => {
    expect((await authed("/api/attachments/999")).status).toBe(404);
  });

  it("retourne 400 pour un identifiant non numérique", async () => {
    expect((await authed("/api/attachments/abc")).status).toBe(400);
  });

  it("retourne 404 quand la ligne D1 existe mais l'objet R2 est absent", async () => {
    const res = await authed("/api/attachments/2");
    expect(res.status).toBe(404);
  });

  it("répond 401 sans jeton", async () => {
    const res = await app.request("https://example.com/api/attachments/1", {}, { ...env, DEV_BYPASS_AUTH: undefined });
    expect(res.status).toBe(401);
  });
});

describe("GET /api/messages/:id/raw", () => {
  it("retourne le .eml d'origine", async () => {
    const res = await authed("/api/messages/1/raw");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("message/rfc822");
    expect(await bodyText(res)).toContain("bonjour");
  });

  it("force le téléchargement (Content-Disposition: attachment), jamais un rendu inline", async () => {
    const res = await authed("/api/messages/1/raw");
    const disp = res.headers.get("content-disposition") ?? "";
    expect(disp.startsWith("attachment")).toBe(true);
  });

  it("pose X-Content-Type-Options: nosniff", async () => {
    const res = await authed("/api/messages/1/raw");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("retourne 404 pour un message inconnu", async () => {
    expect((await authed("/api/messages/999/raw")).status).toBe(404);
  });

  it("retourne 400 pour un identifiant non numérique", async () => {
    expect((await authed("/api/messages/abc/raw")).status).toBe(400);
  });

  it("retourne 404 quand la ligne D1 existe mais l'objet R2 est absent (purge R2 avant D1)", async () => {
    await env.DB.prepare(
      `INSERT OR IGNORE INTO messages (id, thread_id, message_id, direction, folder, from_addr, received_at, raw_key)
       VALUES (2, 1, '<att2@x>', 'in', 'inbox', 'a@b.c', 1, 'raw/absent.eml')`
    ).run();
    const res = await authed("/api/messages/2/raw");
    expect(res.status).toBe(404);
  });

  it("répond 401 sans jeton", async () => {
    const res = await app.request("https://example.com/api/messages/1/raw", {}, { ...env, DEV_BYPASS_AUTH: undefined });
    expect(res.status).toBe(401);
  });
});

describe("GET /api/attachments/:id — nom de fichier démesuré", () => {
  // Régression : le nom vient de l'expéditeur et n'a aucune borne en MIME ; encodeURIComponent
  // pouvant tripler sa taille, un nom de 50 000 caractères produisait un Content-Disposition
  // d'environ 150 Ko et rendait la pièce jointe définitivement intéléchargeable.
  it("tronque le nom avant les deux encodages", async () => {
    await env.DB.prepare("UPDATE attachments SET filename = ? WHERE id = 1")
      .bind("é".repeat(50_000) + ".pdf").run();

    const res = await authed("/api/attachments/1");
    expect(res.status).toBe(200);
    const disp = res.headers.get("content-disposition") ?? "";
    // 200 caractères, pourcent-encodés sur 9 octets max chacun, plus les paramètres : très
    // largement sous le kilo-octet, alors que l'en-tête faisait ~150 Ko avant correction.
    expect(disp.length).toBeLessThan(2000);

    await env.DB.prepare("UPDATE attachments SET filename = 'rapport final.pdf' WHERE id = 1").run();
  });
});
