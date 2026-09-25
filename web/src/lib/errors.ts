import { ApiError } from "../api/client";
import type { Catalog } from "../i18n/fr";

type Entry = string | ((serverMessage: string) => string) | undefined;

// Texte d'erreur à afficher, dans l'ordre : raison traduite, code traduit,
// message du serveur (anglais), puis statut HTTP. Une entrée de catalogue qui
// est une fonction reçoit le message du serveur pour en garder le détail.
export function errorText(err: unknown, t: Catalog): string {
  if (err instanceof ApiError) {
    const reasons = t.errors.reasons as Record<string, Entry>;
    const reason: Entry = err.reason && Object.hasOwn(reasons, err.reason) ? reasons[err.reason] : undefined;
    if (typeof reason === "string") return reason;
    const codes = t.errors.codes as Record<string, Entry>;
    const code: Entry = err.code && Object.hasOwn(codes, err.code) ? codes[err.code] : undefined;
    if (typeof code === "string") return code;
    // Un message serveur vide (ex. 401 sans corps) laisserait un préfixe suivi
    // de rien de lisible : on retombe alors sur le statut HTTP comme détail.
    if (typeof code === "function") return code(err.message || t.errors.http(err.status));
    if (err.message) return err.message;
    return t.errors.http(err.status);
  }
  if (err instanceof Error && err.message) return err.message;
  return t.errors.unknown;
}
