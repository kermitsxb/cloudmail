import type { ReimportResult } from "../api/client";

// Libellé affiché pour le résultat du réimport d'une clé.
export function outcomeLabel(result: ReimportResult): string {
  switch (result.outcome) {
    case "imported":
      return "Importé";
    case "reparsed":
      return "Réanalysé";
    case "duplicate":
      return `Déjà présent (message #${result.messageIds[0]})`;
    case "not_found":
      return "Introuvable dans le stockage";
    case "error":
      return `Échec : ${result.error}`;
  }
}
