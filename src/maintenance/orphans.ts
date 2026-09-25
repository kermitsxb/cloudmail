import type { Env } from "../env";
import { ORPHAN_PAGE_SIZE, listOrphans } from "../admin/reimport";

// 20 pages de 500 objets : au-delà, le compte est un minimum (complete = false). Le plan
// gratuit limite le temps CPU d'une invocation.
export const ORPHAN_CHECK_MAX_PAGES = 20;
export const ORPHAN_SAMPLE_SIZE = 20;

export type OrphanCheck = { count: number; complete: boolean; sample: string[] };

// Compte les bruts de raw/ sans ligne D1. Ne réimporte rien et ne supprime rien : la
// récupération reste une action de l'utilisateur dans la vue Maintenance.
export async function checkOrphans(
  env: Env,
  opts: { pageSize?: number; maxPages?: number } = {},
): Promise<OrphanCheck> {
  const maxPages = opts.maxPages ?? ORPHAN_CHECK_MAX_PAGES;
  const sample: string[] = [];
  let count = 0;
  let cursor: string | undefined;

  for (let page = 0; page < maxPages; page++) {
    const res = await listOrphans(env, { cursor, limit: opts.pageSize ?? ORPHAN_PAGE_SIZE });
    count += res.orphans.length;
    for (const o of res.orphans) {
      if (sample.length < ORPHAN_SAMPLE_SIZE) sample.push(o.key);
    }
    if (res.cursor === null) return { count, complete: true, sample };
    cursor = res.cursor;
  }
  return { count, complete: false, sample };
}
