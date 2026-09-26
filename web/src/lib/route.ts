// Emplacement courant de la boîte mail, reflété dans l'URL (`/inbox/42`) pour qu'une
// actualisation ou un lien rouvre la même conversation. Le Worker sert l'index pour tout
// chemin inconnu (`not_found_handling: "single-page-application"`), Vite aussi en dev.

export const FOLDERS = ["inbox", "sent", "trash"] as const;

export type MailRoute = { folder: string; threadId: number | null };

const DEFAULT_ROUTE: MailRoute = { folder: "inbox", threadId: null };

export function parseRoute(pathname: string): MailRoute {
  const [folder, id, ...rest] = pathname.split("/").filter(Boolean);
  if (folder === undefined) return DEFAULT_ROUTE;
  if (!(FOLDERS as readonly string[]).includes(folder) || rest.length > 0) return DEFAULT_ROUTE;
  const threadId = id !== undefined && /^[1-9]\d*$/.test(id) ? Number(id) : null;
  return { folder, threadId };
}

export function routePath({ folder, threadId }: MailRoute): string {
  return threadId === null ? `/${folder}` : `/${folder}/${threadId}`;
}
