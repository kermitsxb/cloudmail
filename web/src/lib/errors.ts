import { ApiError } from "../api/client";
import type { Catalog } from "../i18n/fr";

type Entry = string | ((serverMessage: string) => string) | undefined;

// Texte d'erreur à afficher, dans l'ordre : raison traduite, code traduit,
// message du serveur (anglais), puis statut HTTP. Une entrée de catalogue qui
// est une fonction reçoit le message du serveur pour en garder le détail.
export function errorText(err: unknown, t: Catalog): string {
  if (err instanceof ApiError) {
    const reason: Entry = err.reason ? (t.errors.reasons as Record<string, Entry>)[err.reason] : undefined;
    if (typeof reason === "string") return reason;
    const code: Entry = err.code ? (t.errors.codes as Record<string, Entry>)[err.code] : undefined;
    if (typeof code === "string") return code;
    if (typeof code === "function") return code(err.message);
    if (err.message) return err.message;
    return t.errors.http(err.status);
  }
  if (err instanceof Error && err.message) return err.message;
  return t.errors.unknown;
}
