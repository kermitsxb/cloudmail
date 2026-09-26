// Dossiers d'un message. trash et spam sont des dossiers « retenus » : leurs messages ne
// comptent pas dans message_count/unread_count du fil, et la maintenance planifiée les purge
// après TRASH_RETENTION_DAYS (trashed_at date leur entrée).
// Tuple `as const` : z.enum (src/api/routes.ts) exige un tuple littéral non vide.
export const FOLDERS = ["inbox", "sent", "trash", "spam"] as const;

export type Folder = (typeof FOLDERS)[number];

export const RETAINED_FOLDERS: readonly Folder[] = ["trash", "spam"];

// Pour les requêtes : folder IN (…). Littéraux fixes, jamais une saisie.
export const RETAINED_FOLDERS_SQL = RETAINED_FOLDERS.map((f) => `'${f}'`).join(",");

export const countsInThread = (folder: string): boolean => !(RETAINED_FOLDERS as readonly string[]).includes(folder);
