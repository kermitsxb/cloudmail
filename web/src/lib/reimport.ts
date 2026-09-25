import type { ReimportResult } from "../api/client";
import type { Catalog } from "../i18n/fr";

// Libellé affiché pour le résultat du réimport d'une clé.
export function outcomeLabel(result: ReimportResult, t: Catalog): string {
  switch (result.outcome) {
    case "imported":
      return t.reimportOutcome.imported;
    case "reparsed":
      return t.reimportOutcome.reparsed;
    case "duplicate":
      return t.reimportOutcome.duplicate(result.messageIds[0]);
    case "not_found":
      return t.reimportOutcome.notFound;
    case "error":
      return t.reimportOutcome.error(result.error);
  }
}
