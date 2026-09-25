import { describe, expect, it } from "vitest";
import type { ReimportResult } from "../api/client";
import { outcomeLabel } from "./reimport";

const key = "raw/x.eml";
const cases: [ReimportResult, string][] = [
  [{ key, outcome: "imported", messageIds: [3] }, "Importé"],
  [{ key, outcome: "reparsed", messageIds: [3] }, "Réanalysé"],
  [{ key, outcome: "duplicate", messageIds: [7] }, "Déjà présent (message #7)"],
  [{ key, outcome: "not_found" }, "Introuvable dans le stockage"],
  [{ key, outcome: "error", error: "D1 indisponible" }, "Échec : D1 indisponible"],
];

describe("outcomeLabel", () => {
  it.each(cases)("libelle %o", (result, label) => {
    expect(outcomeLabel(result)).toBe(label);
  });
});
