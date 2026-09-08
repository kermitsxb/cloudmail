import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { parseEmail, normalizeSubject, safeKey, snippetOf } from "../../src/ingest/parse";

interface TestEnv {
  TEST_FIXTURES: Record<string, string>;
}

const testEnv = env as unknown as TestEnv;

const load = async (name: string): Promise<ArrayBuffer> => {
  const b64 = testEnv.TEST_FIXTURES[name];
  if (!b64) throw new Error(`fixture introuvable: ${name}`);
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
};

describe("parseEmail", () => {
  it("décode le sujet encodé et l'expéditeur", async () => {
    const m = await parseEmail(await load("simple.eml"), "zoe@example.com");
    expect(m.subject).toBe("Facture réglée");
    expect(m.from).toEqual({ address: "zoe@example.com", name: "Zoé Martin" });
    expect(m.messageId).toBe("<simple-1@example.com>");
    expect(m.text.trim()).toBe("Bonjour, la facture est réglée.");
    expect(m.parseError).toBe(false);
  });

  it("extrait les destinataires multiples et le HTML", async () => {
    const m = await parseEmail(await load("multipart.eml"), "bot@example.com");
    expect(m.to.map((a) => a.address)).toEqual(["thomas@planigramme.fr", "autre@planigramme.fr"]);
    expect(m.cc.map((a) => a.address)).toEqual(["chef@example.com"]);
    expect(m.html).toContain("<b>HTML</b>");
    expect(m.text).toContain("Version texte");
  });

  it("décode une pièce jointe base64", async () => {
    const m = await parseEmail(await load("attachment.eml"), "a@example.com");
    expect(m.attachments).toHaveLength(1);
    const att = m.attachments[0];
    expect(att.filename).toBe("data.csv");
    expect(att.mimeType).toBe("text/csv");
    expect(new TextDecoder().decode(att.content)).toBe("a,b,c\n1,2,3\n");
    expect(att.size).toBe(12);
  });

  it("expose le contentId d'une image inline sans chevrons", async () => {
    const m = await parseEmail(await load("inline-image.eml"), "a@example.com");
    expect(m.attachments[0].contentId).toBe("logo123");
  });

  it("décode le latin-1 en quoted-printable", async () => {
    const m = await parseEmail(await load("latin1.eml"), "a@example.com");
    expect(m.subject).toBe("Réunion");
    expect(m.text).toContain("Réunion prévue à 14h.");
  });

  it("dégrade proprement un message malformé", async () => {
    const m = await parseEmail(await load("malformed.eml"), "inconnu@example.com");
    expect(m.parseError).toBe(true);
    expect(m.from.address).toBe("inconnu@example.com");
    expect(m.messageId).toMatch(/^<[0-9a-f-]{36}@cloudmail\.local>$/);
  });
});

describe("normalizeSubject", () => {
  it("retire les préfixes de réponse et de transfert", () => {
    expect(normalizeSubject("Re: Fwd: RE : Tr: Facture")).toBe("facture");
    expect(normalizeSubject("")).toBe("");
  });
});

describe("safeKey", () => {
  it("réduit le Message-ID aux caractères sûrs", () => {
    expect(safeKey("<a/b c@ex.com>")).toBe("a-b-c-ex.com");
  });

  it("tronque à 200 caractères", () => {
    expect(safeKey("<" + "x".repeat(400) + ">").length).toBe(200);
  });
});

describe("snippetOf", () => {
  it("normalise les espaces et tronque à 200 caractères", () => {
    expect(snippetOf("  a\n\n  b  ")).toBe("a b");
    expect(snippetOf("y".repeat(300)).length).toBe(200);
  });
});
