import { env } from '../config/env.js';
import { query } from '../db/pool.js';
import { logger } from '../lib/logger.js';
import { refKey } from '../matching/identifiers.js';
import { harvestSitemapUrls } from '../scraping/sitemap.js';
import { OWN_SITES, skuFromUrl } from './readOwnProduct.js';

/**
 * An index of our own product addresses, for finding a product by its
 * manufacturer reference when we do not hold it yet. See migration 023.
 */

const MAX_AGE_MS = 24 * 60 * 60 * 1000;
let refreshing: Promise<void> | null = null;

async function indexAge(): Promise<number> {
  const { rows } = await query<{ newest: string | null }>('SELECT max(seen_at) AS newest FROM own_site_urls');
  return rows[0]?.newest ? Date.now() - new Date(rows[0].newest).getTime() : Infinity;
}

async function rebuild(): Promise<void> {
  for (const site of OWN_SITES) {
    const harvest = await harvestSitemapUrls(site.origin, env.scraperUserAgent, {
      maxUrls: 400_000,
      maxSitemaps: 80,
    });
    // Pre-owned stock carries the same reference as new; it is not what
    // someone checking our price for that reference means.
    const rows = harvest.urls
      .map((entry) => entry.loc)
      .filter((url) => !/pre[^/]*owned/i.test(url))
      .map((url) => ({ url, sku: skuFromUrl(url) }))
      .filter((row): row is { url: string; sku: string } => Boolean(row.sku));

    for (let i = 0; i < rows.length; i += 1000) {
      const chunk = rows.slice(i, i + 1000);
      const values: unknown[] = [];
      const tuples = chunk.map((row, index) => {
        values.push(row.url, site.fasciaCode, row.sku, row.url.toLowerCase().replace(/[^a-z0-9]/g, ''));
        const base = index * 4;
        return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, now())`;
      });
      await query(
        `INSERT INTO own_site_urls (url, fascia_code, sku, path_key, seen_at) VALUES ${tuples.join(', ')}
         ON CONFLICT (url) DO UPDATE SET seen_at = now()`,
        values,
      );
    }
    logger.info('own-index', `${site.name}: ${rows.length} product address(es) indexed`);
  }
  await query(`DELETE FROM own_site_urls WHERE seen_at < now() - interval '3 days'`);
}

/** Make sure the index is no more than a day old, rebuilding it if needed. */
export async function ensureOwnIndex(): Promise<void> {
  if ((await indexAge()) < MAX_AGE_MS) return;
  refreshing ??= rebuild().finally(() => {
    refreshing = null;
  });
  await refreshing;
}

/** Our SKUs whose address contains this reference, the site asked for first. */
export async function skusForReference(
  reference: string,
  preferredFasciaCode?: string | null,
): Promise<{ sku: string; fasciaCode: string }[]> {
  const key = refKey(reference);
  if (key.length < 5) return [];
  await ensureOwnIndex();
  const { rows } = await query<{ sku: string; fascia_code: string }>(
    `SELECT sku, fascia_code FROM own_site_urls
     WHERE strpos(path_key, $1) > 0
     GROUP BY sku, fascia_code
     ORDER BY (fascia_code = $2) DESC, sku
     LIMIT 5`,
    [key, preferredFasciaCode ?? ''],
  );
  return rows.map((row) => ({ sku: row.sku, fasciaCode: row.fascia_code }));
}
