import { describe, expect, it } from "vitest";
import { ApiError } from "../api/client";
import { en } from "../i18n/en";
import { fr } from "../i18n/fr";
import { errorText } from "./errors";

describe("errorText", () => {
  it("traduit la raison en priorité sur le code", () => {
    const err = new ApiError("Invalid local part", 400, "invalid_body", "invalid_local_part");
    expect(errorText(err, fr)).toBe("Partie locale invalide.");
    expect(errorText(err, en)).toBe("Invalid local part.");
  });

  it("traduit un code connu", () => {
    expect(errorText(new ApiError("Identity already exists", 409, "duplicate_identity"), fr))
      .toBe("Cette identité existe déjà.");
  });

  it("ignore une raison inconnue et retombe sur le code", () => {
    expect(errorText(new ApiError("x", 400, "invalid_body", "nouvelle_raison"), fr)).toBe("Requête invalide.");
  });

  it("garde le détail du serveur derrière un préfixe traduit pour send_failed", () => {
    expect(errorText(new ApiError("Domain not verified", 400, "send_failed"), fr))
      .toBe("Échec de l'envoi : Domain not verified");
  });

  it("affiche le message du serveur pour un code inconnu", () => {
    expect(errorText(new ApiError("Brand new failure", 400, "brand_new"), fr)).toBe("Brand new failure");
  });

  it("retombe sur le statut HTTP quand le corps n'a pas d'erreur exploitable", () => {
    expect(errorText(new ApiError("", 502), fr)).toBe("Erreur 502");
    expect(errorText(new ApiError("", 502), en)).toBe("Error 502");
  });

  it("affiche le message d'une erreur ordinaire, ou un libellé générique", () => {
    expect(errorText(new Error("réseau coupé"), fr)).toBe("réseau coupé");
    expect(errorText("pas une erreur", fr)).toBe("Erreur inconnue");
  });

  it("garde le diagnostic opérateur derrière un préfixe traduit pour unauthenticated", () => {
    expect(errorText(new ApiError("CF_ROUTING_TOKEN manquant", 401, "unauthenticated"), fr))
      .toBe("Accès refusé : CF_ROUTING_TOKEN manquant");
    expect(errorText(new ApiError("CF_ROUTING_TOKEN missing", 401, "unauthenticated"), en))
      .toBe("Access denied: CF_ROUTING_TOKEN missing");
  });

  it("retombe sur le statut HTTP comme détail quand le message serveur est vide", () => {
    expect(errorText(new ApiError("", 401, "unauthenticated"), fr)).toBe("Accès refusé : Erreur 401");
    expect(errorText(new ApiError("", 401, "unauthenticated"), en)).toBe("Access denied: Error 401");
  });

  it("ignore un code hérité du prototype d'objet et retombe sur le message serveur", () => {
    expect(errorText(new ApiError("payload attaquant", 400, "constructor"), fr)).toBe("payload attaquant");
  });
});
