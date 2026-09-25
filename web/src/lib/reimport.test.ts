import { describe, expect, it } from "vitest";
import type { ReimportResult } from "../api/client";
import { en } from "../i18n/en";
import { fr } from "../i18n/fr";
import { outcomeLabel } from "./reimport";

const key = "raw/x.eml";
const cases: [ReimportResult, string, string][] = [
  [{ key, outcome: "imported", messageIds: [3] }, "Importé", "Imported"],
  [{ key, outcome: "reparsed", messageIds: [3] }, "Réanalysé", "Re-parsed"],
  [{ key, outcome: "duplicate", messageIds: [7] }, "Déjà présent (message #7)", "Already present (message #7)"],
  [{ key, outcome: "not_found" }, "Introuvable dans le stockage", "Not found in storage"],
  [{ key, outcome: "error", error: "D1 unavailable" }, "Échec : D1 unavailable", "Failed: D1 unavailable"],
];

describe("outcomeLabel", () => {
  it.each(cases)("libelle %o", (result, inFrench, inEnglish) => {
    expect(outcomeLabel(result, fr)).toBe(inFrench);
    expect(outcomeLabel(result, en)).toBe(inEnglish);
  });
});
