import { capacity } from '../lib/capacity.js';
import { env } from '../config/env.js';
import { query } from '../db/pool.js';
import type { Competitor } from '../domain/types.js';
import { logger } from '../lib/logger.js';
import { ScrapeError } from './errors.js';
import type { ExtractedListing } from './extract.js';
import { fetchAndExtract } from './fetchAndExtract.js';
import type { FetchedPage } from './fetcher.js';
import { slugWords } from './sitemap.js';

/**
 * Reading a competitor's whole catalogue, one page each, and remembering it.
 *
 * The idea in one line: a competitor lists a few thousand products, and every
 * product page states its own barcode. Read each page once, keep what it says
 * in `competitor_products`, and "which of their pages is our product?" becomes
 * a lookup rather than a search (see matching/catalogueMatch.ts).
 *
 * The first read of a competitor is the expensive part — every product page
 * they publish, at a polite pace. After that a run only reads pages that are
 * new in their sitemap, a slice of the oldest ones to keep the rest honest,
 * and anything that failed last time.
 */

export type CatalogueStatus = 'ok' | 'not_product' | 'gone' | 'error';

export interface CatalogueHarvestOptions {
  runId?: number | null;
  /** Stop after this many pages. Null means no cap beyond the time limit. */
  maxPages?: number | null;
  /** Wall-clock time (ms since epoch) after which no new page is started. */
  deadline?: number | null;
  /** Called after every page, so a run can show progress while it works. */
  onPage?: (status: CatalogueStatus) => void | Promise<void>;
  /** Told how many pages this harvest means to read, before it starts. */
  onQueue?: (pages: number) => void;
  /** Read only pages whose address matches, e.g. one brand's (see brandUrlPattern). */
  only?: RegExp;
  /** Read only pages never read before (and last night's failures): no refreshing. */
  unreadOnly?: boolean;
}

/**
 * Matches the addresses of one brand's product pages. All three main
 * competitors put the brand in a product's address ("/Rotary-Apex100-…",
 * "rotary-apex100-…", "…-seiko-5-sports-…").
 *
 * The first word of the brand when it is distinctive enough alone ("seiko"
 * for our "Seiko 5 Sports", "vivienne" for "Vivienne Westwood"), else the
 * first two together ("tag heuer"). Erring wide only costs a few extra pages;
 * erring narrow would miss the product.
 */
export function brandUrlPattern(brand: string | null | undefined): RegExp | null {
  const words = (brand ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter((word) => word.length > 1);
  if (words.length === 0 || words.join(' ') === 'unknown') return null;
  const key = words[0]!.length >= 4 || words.length === 1 ? words[0]! : `${words[0]}[^a-z0-9]+${words[1]}`;
  return new RegExp(`(^|[^a-z0-9])${key}([^a-z0-9]|$)`, 'i');
}

export interface CatalogueHarvestResult {
  /** Pages we attempted this time. */
  attempted: number;
  products: number;
  notProducts: number;
  gone: number;
  errors: number;
  /** Pages still waiting for a first read after this run. */
  remaining: number;
  /** Why the harvest ended before the queue was empty, if it did. */
  stopped: 'blocked' | 'deadline' | 'page_cap' | null;
  detail: string | null;
}

/** A run of refusals this long means the site is turning us away, not hiccuping. */
const BLOCK_STREAK_LIMIT = 5;

/**
 * How many plain-HTTP successes, with no page having needed a browser, before
 * we stop offering unreadable pages to the browser at all.
 *
 * Without this, every category page or sold-out listing on a site whose prices
 * read fine over HTTP costs a full Chromium page load to confirm there was
 * never a price on it — the most expensive possible way to learn nothing.
 */
const HTTP_PROVEN_AFTER = 20;

/**
 * Does this URL look like a product page?
 *
 * A sitemap lists everything — categories, articles, store pages — and only
 * the competitor's config knows which shape is a product. With no pattern
 * configured every URL is tried once; the ones that turn out not to be
 * products are remembered as such and not re-read for a month.
 */
export function isProductUrl(competitor: Competitor, url: string): boolean {
  const pattern = competitor.config.productUrlPattern;
  if (!pattern) return true;
  let path: string;
  try {
    const parsed = new URL(url);
    path = parsed.pathname + parsed.search;
  } catch {
    return false;
  }
  try {
    return new RegExp(pattern).test(path);
  } catch {
    // A broken pattern in a config file must not silently empty the catalogue.
    logger.warn('catalogue', `[${competitor.slug}] productUrlPattern is not a valid expression; ignoring it`);
    return true;
  }
}

/**
 * Our brands as one pattern, for reading the pages most likely to match first.
 *
 * A competitor's first read can take hours. Their Omega and TAG Heuer pages
 * are worth far more to us than their own-label charms, so pages whose address
 * mentions a brand we sell go to the front of the queue and the first night
 * already yields most of the comparisons that will ever exist.
 */
async function ourBrandPattern(): Promise<RegExp | null> {
  const { rows } = await query<{ brand: string }>(
    `SELECT DISTINCT lower(brand) AS brand FROM products
     WHERE delisted_at IS NULL AND brand IS NOT NULL AND lower(brand) <> 'unknown'`,
  );
  const brands = rows
    .map((row) => row.brand.replace(/[^a-z0-9]+/g, ' ').trim())
    .filter((brand) => brand.length >= 3)
    .map((brand) => brand.replace(/ /g, '[^a-z0-9]+'));
  if (brands.length === 0) return null;
  return new RegExp(`(^|[^a-z0-9])(${brands.join('|')})([^a-z0-9]|$)`, 'i');
}

interface QueueRow {
  url: string;
  fetched_at: string | null;
  status: CatalogueStatus | null;
}

/**
 * The pages due a read, most valuable first.
 *
 *   1. never read, address mentions a brand we sell;
 *   2. never read, everything else;
 *   3. failed last time (after 20 hours, so a bad night is retried the next);
 *   4. the oldest slice of pages already read, so the whole catalogue is
 *      re-checked over `CATALOGUE_REFRESH_DAYS` rather than all on one night;
 *   5. pages that were not products or had gone, once a month, in case that
 *      changed.
 */
async function buildQueue(
  competitor: Competitor,
  only: RegExp | null = null,
  unreadOnly = false,
): Promise<{ queue: string[]; unread: number }> {
  const { rows } = await query<QueueRow>(
    `SELECT u.url, cp.fetched_at, cp.status
     FROM competitor_urls u
     LEFT JOIN competitor_products cp
       ON cp.competitor_id = u.competitor_id AND cp.url = u.url
     WHERE u.competitor_id = $1
       -- Dropped from their sitemap a fortnight ago or more: no longer a page
       -- they are asking crawlers to read.
       AND u.last_seen_at > now() - interval '14 days'
     ORDER BY cp.fetched_at NULLS FIRST, u.id`,
    [competitor.id],
  );

  const candidates = rows.filter(
    (row) => isProductUrl(competitor, row.url) && (!only || only.test(new URL(row.url).pathname)),
  );
  const brandPattern = await ourBrandPattern();

  const now = Date.now();
  const age = (row: QueueRow) => (row.fetched_at ? now - new Date(row.fetched_at).getTime() : Infinity);
  const HOUR = 3_600_000;
  const DAY = 24 * HOUR;

  const unreadBranded: string[] = [];
  const unreadOther: string[] = [];
  const failed: string[] = [];
  const stale: string[] = [];
  const dormant: string[] = [];
  let okCount = 0;

  for (const row of candidates) {
    if (row.status === null) {
      if (brandPattern?.test(row.url)) unreadBranded.push(row.url);
      else unreadOther.push(row.url);
    } else if (row.status === 'error') {
      if (age(row) > 20 * HOUR) failed.push(row.url);
    } else if (row.status === 'ok') {
      okCount += 1;
      if (age(row) > DAY) stale.push(row.url);
    } else if (age(row) > 30 * DAY) {
      dormant.push(row.url);
    }
  }

  // Rows arrive oldest first, so the head of `stale` is the slice most overdue.
  const refreshDays = Math.max(1, env.catalogueRefreshDays);
  const staleSlice = stale.slice(0, Math.ceil(okCount / refreshDays));

  return {
    queue: unreadOnly
      ? [...unreadBranded, ...unreadOther, ...failed]
      : [...unreadBranded, ...unreadOther, ...failed, ...staleSlice, ...dormant],
    unread: unreadBranded.length + unreadOther.length,
  };
}

/** Store what one page said. Used by the harvest and by the nightly price read. */
export async function recordCatalogueListing(
  competitorId: number,
  url: string,
  page: Pick<FetchedPage, 'renderedWith'>,
  listing: ExtractedListing,
): Promise<void> {
  await query(
    `INSERT INTO competitor_products
       (competitor_id, url, status, title, brand, gtin, mpn, sku, price, was_price, currency,
        promo, in_stock, availability_text, attributes, rendered_with, error_kind, error)
     VALUES ($1, $2, 'ok', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb, $15, NULL, NULL)
     ON CONFLICT (competitor_id, url) DO UPDATE SET
       status = 'ok', title = EXCLUDED.title, brand = EXCLUDED.brand, gtin = EXCLUDED.gtin,
       mpn = EXCLUDED.mpn, sku = EXCLUDED.sku, price = EXCLUDED.price,
       was_price = EXCLUDED.was_price, currency = EXCLUDED.currency, promo = EXCLUDED.promo,
       in_stock = EXCLUDED.in_stock, availability_text = EXCLUDED.availability_text,
       attributes = EXCLUDED.attributes, rendered_with = EXCLUDED.rendered_with,
       error_kind = NULL, error = NULL, fetched_at = now()`,
    [
      competitorId,
      url,
      listing.title,
      listing.brand,
      listing.gtin,
      listing.mpn,
      listing.sku,
      listing.price,
      listing.wasPrice,
      listing.currency,
      listing.promo,
      listing.inStock,
      listing.availabilityText,
      JSON.stringify(listing.attributes ?? {}),
      page.renderedWith,
    ],
  );
}

async function recordCatalogueFailure(
  competitorId: number,
  url: string,
  status: Exclude<CatalogueStatus, 'ok'>,
  errorKind: string,
  message: string,
): Promise<void> {
  // A page that was a product yesterday and failed today keeps what we knew
  // about it — its barcode has not changed because their server hiccuped. Only
  // the status and the reason are overwritten.
  await query(
    `INSERT INTO competitor_products (competitor_id, url, status, error_kind, error)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (competitor_id, url) DO UPDATE SET
       status = EXCLUDED.status, error_kind = EXCLUDED.error_kind, error = EXCLUDED.error,
       fetched_at = now()`,
    [competitorId, url, status, errorKind, message.slice(0, 500)],
  );
}

/** Which bucket a failed read belongs in. */
function classifyFailure(kind: string): Exclude<CatalogueStatus, 'ok'> {
  switch (kind) {
    case 'not_found':
      return 'gone';
    // Reachable and readable, with no product on it: a category page, an
    // article, or a listing with no price to show. Not worth re-reading soon.
    case 'layout_changed':
    case 'no_price_found':
    case 'implausible_price':
    case 'robots_disallowed':
    case 'invalid_url':
      return 'not_product';
    default:
      return 'error';
  }
}

/**
 * Remember the product pages a page links to.
 *
 * A sitemap is not the whole shop. Beaverbrooks' lists the 42mm and 45mm
 * Rotary Apex100 and leaves out a 41mm one; a product's other colours and
 * sizes are often only linked from its siblings' pages. Every product page
 * read is therefore also searched for links to product pages, and any not yet
 * known join the list to be read. Only links to the same site that look like
 * product pages are kept, and never more than 150 from one page.
 */
export async function rememberLinkedProducts(
  competitor: Competitor,
  page: Pick<FetchedPage, 'html' | 'finalUrl'>,
): Promise<number> {
  let host: string;
  try {
    host = new URL(page.finalUrl).host;
  } catch {
    return 0;
  }
  const found = new Set<string>();
  for (const match of page.html.matchAll(/href\s*=\s*["']([^"'#\s]{2,300})["']/gi)) {
    if (found.size >= 150) break;
    try {
      const url = new URL(match[1]!.replace(/&amp;/g, '&'), page.finalUrl);
      if (url.host !== host) continue;
      url.hash = '';
      url.search = '';
      const text = url.toString();
      if (isProductUrl(competitor, text)) found.add(text);
    } catch {
      /* not a usable address */
    }
  }
  if (found.size === 0) return 0;
  const urls = [...found];
  const { rowCount } = await query(
    `INSERT INTO competitor_urls (competitor_id, url, slug)
     SELECT $1, u.url, u.slug FROM unnest($2::text[], $3::text[]) AS u(url, slug)
     ON CONFLICT (competitor_id, url) DO UPDATE SET last_seen_at = now()
     WHERE competitor_urls.last_seen_at < now() - interval '1 day'`,
    [competitor.id, urls, urls.map((url) => slugWords(url))],
  );
  return rowCount ?? 0;
}

/**
 * How many of a competitor's pages are read at the same time: its configured
 * `rateLimit.maxConcurrent`, never more than SCRAPER_MAX_CONCURRENCY. Two by
 * default, chosen 17 November 2026 to fit the first full read of the largest
 * catalogues into one night. Requests are still spaced by the rate limiter;
 * a second page mostly overlaps the seconds a slow site takes to answer.
 */
export function pagesAtOnce(competitor: Competitor): number {
  // Never more than the server's memory allows (lib/capacity.ts).
  return Math.max(1, Math.min(competitor.config.rateLimit?.maxConcurrent ?? 1, env.maxConcurrentScrapes, capacity.pagesPerSite));
}

export async function harvestCatalogue(
  competitor: Competitor,
  options: CatalogueHarvestOptions = {},
): Promise<CatalogueHarvestResult> {
  const result: CatalogueHarvestResult = {
    attempted: 0,
    products: 0,
    notProducts: 0,
    gone: 0,
    errors: 0,
    remaining: 0,
    stopped: null,
    detail: null,
  };

  const { queue, unread } = await buildQueue(competitor, options.only ?? null, options.unreadOnly ?? false);
  result.remaining = unread;
  // A capped harvest means to read only up to its cap.
  options.onQueue?.(options.maxPages != null ? Math.min(queue.length, options.maxPages) : queue.length);
  if (queue.length === 0) return result;

  logger.info(
    'catalogue',
    `[${competitor.slug}] ${queue.length} page(s) to read (${unread} never read before)`,
  );

  let blockStreak = 0;
  let httpSuccesses = 0;
  let browserSuccesses = 0;
  let unreadDone = 0;

  // Pages are read by as many workers as this competitor allows at once (see
  // pagesAtOnce). The rate limiter still spaces every request to the site, so
  // two workers mostly overlap one slow response with the next request.
  let next = 0;
  let stop = false;

  const readPage = async (index: number, url: string): Promise<void> => {
    result.attempted += 1;
    if (index < unread) unreadDone += 1;
    let status: CatalogueStatus;

    try {
      const { page, listing } = await fetchAndExtract(competitor, url, {
        // One attempt: a page that fails is retried on the next run, which is
        // a better use of the time than three goes at it tonight.
        maxAttempts: 1,
        // Never the paid route. Reading a catalogue is thousands of pages most
        // of which are not ours; paying to unblock them would be paying for
        // maybes on an industrial scale.
        unblockerMode: 'never',
        escalate: !(httpSuccesses >= HTTP_PROVEN_AFTER && browserSuccesses === 0),
      });
      await recordCatalogueListing(competitor.id, url, page, listing);
      await rememberLinkedProducts(competitor, page).catch(() => undefined);
      if (page.renderedWith === 'http') httpSuccesses += 1;
      else browserSuccesses += 1;
      blockStreak = 0;
      result.products += 1;
      status = 'ok';
    } catch (err) {
      const kind = err instanceof ScrapeError ? err.kind : 'unknown';
      status = classifyFailure(kind);
      await recordCatalogueFailure(competitor.id, url, status, kind, (err as Error).message);

      if (status === 'gone') result.gone += 1;
      else if (status === 'not_product') result.notProducts += 1;
      else result.errors += 1;

      // Being turned away is the one failure that must stop the harvest. A
      // site refusing us is telling us something, and pressing on through
      // thousands more requests is how a temporary refusal becomes a ban.
      if (kind === 'blocked') {
        blockStreak += 1;
        if (blockStreak >= BLOCK_STREAK_LIMIT && !stop) {
          stop = true;
          result.stopped = 'blocked';
          result.detail =
            `${competitor.display_name} refused ${BLOCK_STREAK_LIMIT} pages in a row ` +
            `(${(err as Error).message}). Stopped reading their catalogue for this run.`;
          logger.warn('catalogue', `[${competitor.slug}] ${result.detail}`);
        }
      } else {
        blockStreak = 0;
      }
    }

    await options.onPage?.(status);
  };

  const worker = async (): Promise<void> => {
    while (!stop) {
      if (options.maxPages != null && result.attempted >= options.maxPages) {
        stop = true;
        result.stopped ??= 'page_cap';
        return;
      }
      if (options.deadline != null && Date.now() > options.deadline) {
        stop = true;
        result.stopped ??= 'deadline';
        return;
      }
      const index = next;
      next += 1;
      if (index >= queue.length) return;
      await readPage(index, queue[index]!);
    }
  };

  await Promise.all(Array.from({ length: Math.min(pagesAtOnce(competitor), queue.length) }, worker));

  result.remaining = Math.max(0, unread - unreadDone);
  logger.info(
    'catalogue',
    `[${competitor.slug}] read ${result.attempted} page(s): ${result.products} product(s), ` +
      `${result.notProducts} not a product, ${result.gone} gone, ${result.errors} failed` +
      (result.remaining > 0 ? `; ${result.remaining} still to read` : '') +
      (result.stopped ? ` (stopped: ${result.stopped})` : ''),
  );
  return result;
}

export interface CatalogueCoverage {
  competitorId: number;
  /** URLs in their sitemap that look like product pages. */
  productUrls: number;
  /** Of those, read at least once. */
  read: number;
  products: number;
  withGtin: number;
  withMpn: number;
  lastReadAt: string | null;
}

/** How much of each competitor's catalogue we hold, for the Admin page. */
export async function catalogueCoverage(competitors: Competitor[]): Promise<CatalogueCoverage[]> {
  const coverage: CatalogueCoverage[] = [];
  for (const competitor of competitors) {
    const { rows: urls } = await query<{ url: string }>(
      `SELECT url FROM competitor_urls
       WHERE competitor_id = $1 AND last_seen_at > now() - interval '14 days'`,
      [competitor.id],
    );
    const { rows } = await query<{
      read: number;
      products: number;
      with_gtin: number;
      with_mpn: number;
      last_read_at: string | null;
    }>(
      `SELECT count(*)::int AS read,
              count(*) FILTER (WHERE status = 'ok')::int AS products,
              count(*) FILTER (WHERE status = 'ok' AND gtin IS NOT NULL)::int AS with_gtin,
              count(*) FILTER (WHERE status = 'ok' AND mpn IS NOT NULL)::int AS with_mpn,
              max(fetched_at) AS last_read_at
       FROM competitor_products WHERE competitor_id = $1`,
      [competitor.id],
    );
    const row = rows[0];
    coverage.push({
      competitorId: competitor.id,
      productUrls: urls.filter((entry) => isProductUrl(competitor, entry.url)).length,
      read: row?.read ?? 0,
      products: row?.products ?? 0,
      withGtin: row?.with_gtin ?? 0,
      withMpn: row?.with_mpn ?? 0,
      lastReadAt: row?.last_read_at ?? null,
    });
  }
  return coverage;
}
