import { describe, expect, it } from "vitest";
import { NO_AUTH, parseAuthentication } from "../../src/ingest/auth";

const h = (key: string, value: string) => ({ key, value });

// Forme réelle relevée sur une installation (adresses remplacées), avec le repliement
// CRLF + tabulation tel que livré.
const CLOUDFLARE =
  "mx.cloudflare.net;\r\n\tdkim=pass header.d=example.com header.s=s1 header.b=abc;\r\n" +
  "\tdmarc=pass header.from=example.com policy.dmarc=none;\r\n" +
  "\tspf=none (mx.cloudflare.net: no SPF records found for postmaster@mail.example.com) smtp.helo=mail.example.com;\r\n" +
  "\tspf=pass (mx.cloudflare.net: domain of zoe@example.com designates 2001:db8::1 as permitted sender) smtp.mailfrom=zoe@example.com";

describe("parseAuthentication", () => {
  it("lit les verdicts de l'en-tête Cloudflare réel", () => {
    expect(parseAuthentication([
      h("received", "from mail.example.com by cloudflare-email.net"),
      h("authentication-results", CLOUDFLARE),
      h("x-cf-spamh-score", "0"),
    ])).toEqual({ spf: "pass", dkim: "pass", dmarc: "pass", spamScore: 0, trust: "trusted" });
  });

  it("lit une valeur sur une seule ligne comme une valeur repliée", () => {
    const oneLine = CLOUDFLARE.replace(/\r\n\t/g, " ");
    expect(parseAuthentication([h("authentication-results", oneLine)]))
      .toEqual(parseAuthentication([h("authentication-results", CLOUDFLARE)]));
  });

  it("ne lit que le premier en-tête : un en-tête falsifié placé plus bas est ignoré", () => {
    const res = parseAuthentication([
      h("authentication-results", "mx.cloudflare.net; dmarc=fail header.from=bank.example; spf=fail smtp.mailfrom=x@bank.example"),
      h("authentication-results", "mx.cloudflare.net; dmarc=pass header.from=bank.example; spf=pass smtp.mailfrom=x@bank.example"),
    ]);
    expect(res.dmarc).toBe("fail");
    expect(res.spf).toBe("fail");
  });

  it("ignore tout quand le premier en-tête ne vient pas de Cloudflare", () => {
    expect(parseAuthentication([
      h("authentication-results", "mx.example.com; dmarc=pass"),
      h("authentication-results", "mx.cloudflare.net; dmarc=fail"),
    ])).toEqual({ ...NO_AUTH, trust: "foreign_authserv" });
  });

  it("refuse un identifiant qui ressemble seulement à celui de Cloudflare", () => {
    for (const id of ["mx.cloudflare.net.example.com", "mx.cloudflare.net2", "cloudflare.net"]) {
      const res = parseAuthentication([h("authentication-results", `${id}; dmarc=pass; spf=pass; dkim=pass`)]);
      expect(res).toEqual({ ...NO_AUTH, trust: "foreign_authserv" });
    }
  });

  it("accepte l'identifiant Cloudflare quelle que soit la casse, suivi d'une version", () => {
    expect(parseAuthentication([h("authentication-results", "MX.Cloudflare.NET 1; dmarc=fail")]).dmarc).toBe("fail");
  });

  it("préfère le résultat SPF de smtp.mailfrom, sinon prend le premier", () => {
    expect(parseAuthentication([h("authentication-results", "mx.cloudflare.net; spf=pass smtp.helo=a; spf=softfail smtp.mailfrom=b")]).spf)
      .toBe("softfail");
    expect(parseAuthentication([h("authentication-results", "mx.cloudflare.net; spf=neutral smtp.helo=a")]).spf)
      .toBe("neutral");
  });

  it("retient pass si l'une des signatures DKIM est valide, sinon la première", () => {
    expect(parseAuthentication([h("authentication-results", "mx.cloudflare.net; dkim=fail header.d=a; dkim=pass header.d=b")]).dkim)
      .toBe("pass");
    expect(parseAuthentication([h("authentication-results", "mx.cloudflare.net; dkim=permerror header.d=a; dkim=fail header.d=b")]).dkim)
      .toBe("permerror");
  });

  it("ignore les commentaires qui contiennent ; et =", () => {
    const res = parseAuthentication([
      h("authentication-results", "mx.cloudflare.net; spf=pass (note; dmarc=fail) smtp.mailfrom=a; dmarc=pass"),
    ]);
    expect(res).toMatchObject({ spf: "pass", dmarc: "pass" });
  });

  it("met en minuscules et écarte les valeurs inconnues", () => {
    const res = parseAuthentication([h("authentication-results", "mx.cloudflare.net; DMARC=FAIL; dkim=bestguesspass; spf=policy")]);
    expect(res).toEqual({ spf: null, dkim: null, dmarc: "fail", spamScore: null, trust: "trusted" });
  });

  it("renvoie des verdicts vides pour « none » sans méthode, ou sans en-tête", () => {
    // En-tête Cloudflare présent mais sans méthode : de confiance, simplement vide.
    expect(parseAuthentication([h("authentication-results", "mx.cloudflare.net; none")]))
      .toEqual({ ...NO_AUTH, trust: "trusted" });
    expect(parseAuthentication([])).toEqual({ ...NO_AUTH, trust: "missing" });
  });

  it("ne garde qu'un score entier", () => {
    expect(parseAuthentication([h("x-cf-spamh-score", "12")]).spamScore).toBe(12);
    expect(parseAuthentication([h("x-cf-spamh-score", "-3")]).spamScore).toBe(-3);
    expect(parseAuthentication([h("x-cf-spamh-score", "1.5")]).spamScore).toBeNull();
    expect(parseAuthentication([h("x-cf-spamh-score", "élevé")]).spamScore).toBeNull();
  });

  it("ne lève jamais, même sur une valeur vide", () => {
    expect(() => parseAuthentication([h("authentication-results", ""), h("x-cf-spamh-score", "")])).not.toThrow();
  });
});
