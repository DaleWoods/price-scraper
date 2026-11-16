import { query } from '../db/pool.js';
import type { Competitor, Product } from '../domain/types.js';
import { logger } from '../lib/logger.js';
import { env } from '../config/env.js';
import { harvestSitemapUrls, slugWords } from '../scraping/sitemap.js';
import { isProductUrl } from '../scraping/catalogue.js';
import { canonicalAttributeName } from './attributes.js';
import { isUsableReference, refKey } from './identifiers.js';

/**
 * Discovery from a competitor's sitemap rather than their on-site search.
 *
 * Every competitor disallows /search in robots.txt, so searching their site is
 * not available to us. A sitemap is published for crawlers and lists the
 * product pages directly, which makes it the sanctioned route to the same
 * listings. Each product page is still checked against robots.txt before it is
 * fetched — being in a sitemap grants no exemption.
 */

/** Words too common in a retail URL to narrow anything down. */
const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'ct', 'carat', 'gold', 'silver', 'watch', 'watches',
  'ring', 'rings', 'necklace', 'bracelet', 'earrings', 'mens', 'womens', 'ladies',
  'new', 'p', 'product', 'products', 'jewellery', 'jewelry', 'uk', 'com',
]);

/**
 * The words worth searching a competitor's URLs for.
 *
 * A manufacturer reference is the strongest signal — retailers put it in the
 * slug — so it leads. Otherwise brand and the distinctive words of the name.
 */
export function searchTermsFor(product: Product): string[] {
  const specs = Object.fromEntries(
    Object.entries(product.specs ?? {}).map(([key, value]) => [
      canonicalAttributeName(key),
      String(value),
    ]),
  );

  const reference = (specs.reference_number ?? product.mpn ?? product.ean_mpn ?? '').trim();
  const words = `${product.brand} ${product.product_name} ${reference}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 1 && !STOP_WORDS.has(word));

  // Longest first: the distinctive words carry the most signal, and the query
  // is capped so one very long product name cannot dominate a run.
  return [...new Set(words)].sort((a, b) => b.length - a.length).slice(0, 8);
}

function referenceFromSpecs(product: Product): string | null {
  for (const [key, value] of Object.entries(product.specs ?? {})) {
    if (canonicalAttributeName(key) === 'reference_number' && value) return String(value);
  }
  return null;
}

export interface CandidateUrl {
  url: string;
  rank: number;
}

/**
 * Find the cached URLs that look most like this product.
 *
 * Ranking happens in Postgres against a GIN index, so a competitor with 100k
 * cached URLs costs one indexed query per product rather than a scan.
 */
export async function findCandidateUrls(
  product: Product,
  competitor: Competitor,
  limit = 5,
): Promise<CandidateUrl[]> {
  // The reference first. Berry's, Fraser Hart and Beaverbrooks put the maker's
  // reference in their addresses, so a page whose address contains ours is
  // almost certainly the product — and it is the one page worth opening.
  const exact: CandidateUrl[] = [];
  for (const reference of [product.mpn, referenceFromSpecs(product)]) {
    const key = refKey(reference);
    if (!isUsableReference(key)) continue;
    const { rows } = await query<{ url: string }>(
      `SELECT url FROM competitor_urls
       WHERE competitor_id = $1 AND regexp_replace(lower(url), '[^a-z0-9]', '', 'g') LIKE '%' || $2 || '%'
       LIMIT 20`,
      [competitor.id, key],
    );
    for (const row of rows) {
      if (isProductUrl(competitor, row.url) && !exact.some((entry) => entry.url === row.url)) {
        exact.push({ url: row.url, rank: 1 });
      }
    }
  }

  const terms = searchTermsFor(product);
  if (terms.length === 0) return exact.slice(0, limit);

  // OR rather than AND: a slug rarely contains every word, and ranking sorts
  // the near-misses below the strong hits anyway.
  // The brand must be in the address. Every verified competitor puts it there
  // for a branded product, and without it a search for an Omega diver's watch
  // at Ernest Jones offered their Seiko and Casio divers first.
  const brandWords = (product.brand ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((word) => word.length > 1);
  const brandKnown = brandWords.length > 0 && product.brand.toLowerCase() !== 'unknown';
  const otherTerms = terms.filter((term) => !brandWords.includes(term));
  const tsquery =
    brandKnown && otherTerms.length > 0
      ? `(${brandWords.join(' & ')}) & (${otherTerms.join(' | ')})`
      : terms.join(' | ');

  // Over-fetch, then keep only product pages. A brand's blog post and its
  // landing page carry exactly the words a product's title does, and without
  // this they out-ranked the products and used up every attempt — the search
  // for an Omega at Ernest Jones opened "discover-omega" and two blog posts.
  const { rows } = await query<{ url: string; rank: number }>(
    `SELECT url, ts_rank(to_tsvector('simple', slug), q) AS rank
     FROM competitor_urls, to_tsquery('simple', $2) AS q
     WHERE competitor_id = $1
       AND to_tsvector('simple', slug) @@ q
     ORDER BY rank DESC, length(url)
     LIMIT $3`,
    [competitor.id, tsquery, limit * 20],
  );

  const byTitle = rows
    .filter((row) => isProductUrl(competitor, row.url) && !exact.some((entry) => entry.url === row.url))
    .map((row) => ({ url: row.url, rank: Number(row.rank) }));
  return [...exact, ...byTitle].slice(0, limit);
}

export interface UrlRefreshResult {
  competitor: string;
  urlsFound: number;
  urlsStored: number;
  sitemapsRead: number;
  error: string | null;
}

/**
 * Rebuild a competitor's cached URL index from their sitemaps.
 *
 * Run once per scrape run rather than once per product: the sitemap is the same
 * for every product, and re-walking it thousands of times would be both slow
 * and rude.
 */
export async function refreshCompetitorUrls(
  competitor: Competitor,
  options: { maxUrls?: number } = {},
): Promise<UrlRefreshResult> {
  const result: UrlRefreshResult = {
    competitor: competitor.display_name,
    urlsFound: 0,
    urlsStored: 0,
    sitemapsRead: 0,
    error: null,
  };

  let origin: string;
  try {
    origin = new URL(competitor.base_url).origin;
  } catch {
    result.error = `"${competitor.base_url}" is not a valid URL`;
    return result;
  }

  const harvest = await harvestSitemapUrls(origin, env.scraperUserAgent, options);
  result.sitemapsRead = harvest.fetched.filter((entry) => entry.ok).length;
  result.urlsFound = harvest.urls.length;

  if (harvest.error) {
    result.error = harvest.error;
    return result;
  }
  if (harvest.urls.length === 0) {
    result.error =
      harvest.fetched.length === 0
        ? 'no sitemaps could be read'
        : `sitemaps were read but listed no URLs (${harvest.fetched.length} file(s))`;
    return result;
  }

  const CHUNK = 500;
  try {
    for (let i = 0; i < harvest.urls.length; i += CHUNK) {
      const chunk = harvest.urls.slice(i, i + CHUNK);
      const values: unknown[] = [];
      const tuples = chunk.map((entry, index) => {
        const base = index * 4;
        const lastmod = entry.lastmod ? new Date(entry.lastmod) : null;
        values.push(
          competitor.id,
          entry.loc,
          slugWords(entry.loc),
          lastmod && !Number.isNaN(lastmod.getTime()) ? lastmod : null,
        );
        return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4})`;
      });

      await query(
        `INSERT INTO competitor_urls (competitor_id, url, slug, lastmod)
         VALUES ${tuples.join(', ')}
         ON CONFLICT (competitor_id, url) DO UPDATE SET
           slug         = EXCLUDED.slug,
           lastmod      = EXCLUDED.lastmod,
           last_seen_at = now()`,
        values,
      );
      result.urlsStored += chunk.length;
    }
  } catch (err) {
    // One competitor's unusable sitemap must not abort the entire run. Report
    // it and let the caller fall back on the URLs already cached for them.
    result.error = `could not cache URLs: ${(err as Error).message}`;
    return result;
  }

  logger.info(
    'sitemap',
    `${competitor.slug}: cached ${result.urlsStored} URL(s) from ${result.sitemapsRead} sitemap(s)`,
  );
  return result;
}

/** How many URLs we currently hold for a competitor. */
export async function countCachedUrls(competitorId: number): Promise<number> {
  const { rows } = await query<{ count: number }>(
    'SELECT count(*)::int AS count FROM competitor_urls WHERE competitor_id = $1',
    [competitorId],
  );
  return rows[0]?.count ?? 0;
}
