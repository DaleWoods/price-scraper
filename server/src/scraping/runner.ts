import { query } from '../db/pool.js';
import type { Competitor, Product, ScrapeRun } from '../domain/types.js';
import { logger } from '../lib/logger.js';
import { discoverMatchesForProduct } from '../matching/discovery.js';
import { countCachedUrls, refreshCompetitorUrls } from '../matching/sitemapDiscovery.js';
import {
  raiseListingGoneAlert,
  resolveListingGone,
  syncPriceDropAlert,
  syncUndercutAlerts,
} from '../services/alerts.js';
import { closeBrowser } from './browser.js';
import { listCompetitors } from './competitorRegistry.js';
import { ScrapeError } from './errors.js';
import { fetchAndExtract } from './fetchAndExtract.js';

export type RunMode = 'prices' | 'discover' | 'both';

export interface StartRunOptions {
  mode?: RunMode;
  competitorId?: number | null;
  trigger?: string;
  /** Cap on products processed, mainly to keep the first manual runs short. */
  limit?: number | null;
  /**
   * Scope the run to one product.
   *
   * The testing case: you know a competitor lists a particular watch and want
   * to see whether we pick it up, without waiting on the whole catalogue. A
   * named product is also re-discovered even if it already has candidates,
   * since otherwise the run you just asked for would do nothing.
   */
  productId?: number | null;
  /**
   * Scope the run to a specific, larger set of products — an uploaded list of
   * SKUs rather than the single-product test case above. Takes the same
   * "always re-discovered, cache reused unless forceHarvest" treatment as a
   * single product; the only difference is how many products it covers.
   * Mutually exclusive with productId — pass at most one of the two.
   */
  productIds?: number[] | null;
  /**
   * Re-harvest a competitor's sitemap even when the run is already scoped
   * (productId or productIds) and URLs are cached for them. Off by default: a
   * scoped run is meant to be quick, and Beaverbrooks alone lists 15,000+
   * URLs, so re-walking the whole tree to test a handful of SKUs took minutes
   * for no benefit most of the time. Tick it when the pages you're testing
   * against are new enough that they might not be in the cache yet.
   */
  forceHarvest?: boolean;
}

let activeRunId: number | null = null;

/**
 * Set synchronously the moment a run is accepted, and cleared once the run row
 * exists (or the insert fails).
 *
 * `activeRunId` cannot guard this on its own: it is only known *after* the
 * INSERT that creates the run row, and awaiting that INSERT yields the event
 * loop. Two callers arriving together — a double-clicked "Run now", two open
 * tabs, a retried request — would both read `activeRunId === null`, both pass
 * the guard, and both start a run, double-scraping every competitor and racing
 * the run counters. This flag closes that window, because the check and the
 * set happen in the same tick.
 */
let runStarting = false;

export function getActiveRunId(): number | null {
  return activeRunId;
}

interface MatchRow {
  match_id: number;
  product_id: number;
  competitor_id: number;
  competitor_url: string;
  internal_sku: string;
}

/**
 * Manual "run now" trigger (MVP — no scheduler yet).
 *
 * Returns as soon as the run row exists; the scrape itself continues in the
 * background and its progress is readable from scrape_runs / scrape_run_items.
 */
export async function startRun(options: StartRunOptions = {}): Promise<ScrapeRun> {
  if (activeRunId !== null || runStarting) {
    // The id is only available once the row exists, so a caller that loses the
    // race by a few milliseconds is told a run is in progress without one.
    const which = activeRunId !== null ? ` (run #${activeRunId})` : '';
    throw new Error(`A scrape run is already in progress${which}. Wait for it to finish.`);
  }
  runStarting = true;

  try {
    const mode = options.mode ?? 'both';
    // Normalise the two scoping options into one list, so everything past this
    // point only has to reason about "a set of product ids, or none". A single
    // product still gets its own product_id column (existing single-product
    // test UI reads that); a list of several gets product_count instead, since
    // there is no one product to point a foreign key at.
    const productIds =
      options.productIds && options.productIds.length > 0
        ? options.productIds
        : options.productId != null
          ? [options.productId]
          : null;
    const singleProductId = productIds && productIds.length === 1 ? productIds[0] : null;
    const productCount = productIds && productIds.length > 1 ? productIds.length : null;

    const { rows } = await query<ScrapeRun>(
      `INSERT INTO scrape_runs (trigger, status, competitor_id, product_id, product_count)
       VALUES ($1, 'running', $2, $3, $4)
       RETURNING *`,
      [options.trigger ?? 'manual', options.competitorId ?? null, singleProductId, productCount],
    );

    const run = rows[0];
    if (!run) throw new Error('Failed to create scrape run');
    activeRunId = run.id;

    // Deliberately not awaited: the HTTP caller gets the run id immediately.
    void executeRun(run.id, mode, productIds, options)
      .catch(async (err) => {
        logger.error('runner', `run ${run.id} failed: ${(err as Error).message}`, err);
        await query(
          `UPDATE scrape_runs SET status = 'failed', error = $2, finished_at = now() WHERE id = $1`,
          [run.id, (err as Error).message],
        ).catch(() => undefined);
      })
      .finally(() => {
        activeRunId = null;
      });

    return run;
  } finally {
    // By here `activeRunId` is set (or the insert threw and no run exists), so
    // the reservation has done its job either way.
    runStarting = false;
  }
}

async function executeRun(
  runId: number,
  mode: RunMode,
  productIds: number[] | null,
  options: StartRunOptions,
): Promise<void> {
  const all = await listCompetitors(true);
  const competitors = options.competitorId
    ? all.filter((competitor) => competitor.id === options.competitorId)
    : all;

  if (competitors.length === 0) {
    await query(
      `UPDATE scrape_runs
       SET status = 'completed', finished_at = now(),
           error = 'No enabled competitors — nothing to scrape.'
       WHERE id = $1`,
      [runId],
    );
    return;
  }

  try {
    // Competitors are independent of each other — nothing about scanning
    // Beaverbrooks depends on Ernest Jones having finished — so they run
    // concurrently rather than one after another. Each competitor's own
    // requests stay sequential and rate-limited exactly as before; this only
    // overlaps *different* competitors' waits with each other, which is where
    // almost all of a run's wall-clock time was going. Bounded rather than
    // unbounded: Playwright's Chromium is real memory and CPU per concurrent
    // page, and letting every enabled competitor render at once on a small
    // deployment is exactly what starved the process enough to fail its own
    // health check once already (see CLAUDE.md).
    const results = await mapWithConcurrency(competitors, COMPETITOR_CONCURRENCY, (competitor) =>
      runCompetitor(runId, competitor, mode, options.limit ?? null, productIds, options.forceHarvest),
    );

    let ok = 0;
    let errored = 0;
    let skipped = 0;
    for (const result of results) {
      ok += result.ok;
      errored += result.errored;
      skipped += result.skipped;
    }

    await query(
      `UPDATE scrape_runs
       SET status = 'completed', finished_at = now(),
           ok_count = $2, error_count = $3, skipped_count = $4
       WHERE id = $1`,
      [runId, ok, errored, skipped],
    );
    logger.info('runner', `run ${runId} completed: ${ok} ok, ${errored} error, ${skipped} skipped`);
  } finally {
    // Free the Chromium process between manual runs — nothing is scheduled yet.
    await closeBrowser();
  }
}

/** How many competitors run concurrently within one scrape run. */
const COMPETITOR_CONCURRENCY = 3;

/** Run every array item through fn, never more than `limit` in flight at once. */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;

  async function worker(): Promise<void> {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await fn(items[index]!);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/** One competitor's full contribution to a run: discovery, then prices. */
async function runCompetitor(
  runId: number,
  competitor: Competitor,
  mode: RunMode,
  limit: number | null,
  productIds: number[] | null,
  forceHarvest: boolean | undefined,
): Promise<{ ok: number; errored: number; skipped: number }> {
  let ok = 0;
  let errored = 0;
  let skipped = 0;

  // Discovery first, then prices. A match auto-confirmed by this run is then
  // priced by this run, so one scan answers "is it listed there, and for how
  // much" — which is the whole question. The other order left a freshly
  // matched product showing no competitor price until someone ran the scan a
  // second time.
  if (mode === 'discover' || mode === 'both') {
    // Sitemap discovery searches a cached index of the competitor's URLs.
    // Harvested once per run rather than per product: it is the same
    // sitemap every time, and re-walking it thousands of times would be
    // both slow and rude.
    //
    // A run scoped to a named set of products (one, or an uploaded list) is a
    // targeted check, not a catalogue-wide sweep, so it reuses whatever is
    // already cached rather than re-harvesting — a large competitor's full
    // tree can run to tens of thousands of URLs and take minutes to walk,
    // which turns "check these products" into a wait that looks like the app
    // has hung. A full run (no products named) always harvests fresh, which
    // is how the cache stays current for everyone else.
    if ((competitor.config?.discovery ?? 'sitemap') === 'sitemap') {
      const alreadyCached = await countCachedUrls(competitor.id);
      const reuseCache = productIds != null && alreadyCached > 0 && !forceHarvest;

      if (reuseCache) {
        logger.info(
          'runner',
          `[${competitor.slug}] scoped run (${productIds!.length} product(s)) — searching ` +
            `${alreadyCached} previously cached URL(s) rather than re-harvesting the sitemap`,
        );
      } else {
        const refresh = await refreshCompetitorUrls(competitor);
        if (refresh.error) {
          logger.warn(
            'runner',
            `[${competitor.slug}] sitemap unavailable (${refresh.error}); ` +
              `falling back on ${alreadyCached} previously cached URL(s)`,
          );
        }
      }
    }

    const result = await discoverUnmatchedProducts(runId, competitor, limit, productIds);
    ok += result.ok;
    errored += result.errored;
    skipped += result.skipped;
  }

  if (mode === 'prices' || mode === 'both') {
    const result = await scrapeConfirmedMatches(runId, competitor, limit, productIds);
    ok += result.ok;
    errored += result.errored;
  }

  return { ok, errored, skipped };
}

/** Scrape the stored URL of every confirmed match (Spec §5.4 — direct-URL path). */
async function scrapeConfirmedMatches(
  runId: number,
  competitor: Competitor,
  limit: number | null,
  productIds: number[] | null,
): Promise<{ ok: number; errored: number }> {
  const { rows: matches } = await query<MatchRow>(
    `SELECT m.id AS match_id, m.product_id, m.competitor_id, m.competitor_url, p.internal_sku
     FROM product_matches m
     JOIN products p ON p.id = m.product_id
     -- A delisted product is no longer sold by us, so re-checking a
     -- competitor's price for it would only add noise.
     WHERE m.competitor_id = $1 AND m.status = 'confirmed' AND p.delisted_at IS NULL
       AND ($2::bigint[] IS NULL OR m.product_id = ANY($2::bigint[]))
     ORDER BY m.id
     ${limit ? 'LIMIT ' + Number(limit) : ''}`,
    [competitor.id, productIds],
  );

  let ok = 0;
  let errored = 0;

  for (const match of matches) {
    const startedAt = Date.now();
    try {
      const { page, listing } = await fetchAndExtract(competitor, match.competitor_url);

      await query(
        `INSERT INTO price_observations
           (product_id, competitor_id, match_id, scrape_run_id, price, was_price, currency,
            promo, in_stock, availability_text, source_url, rendered_with)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [
          match.product_id,
          match.competitor_id,
          match.match_id,
          runId,
          listing.price,
          listing.wasPrice,
          listing.currency,
          listing.promo,
          listing.inStock,
          listing.availabilityText,
          page.finalUrl,
          // What actually produced this price, after any escalation — not what
          // the competitor is configured to prefer.
          page.renderedWith,
        ],
      );

      // A price outlives its own scrape: alert state is checked against every
      // fascia this product prices, not just recorded and left for someone to
      // notice on the comparison page.
      //
      // Every alert call is caught and logged rather than awaited bare: a
      // failed alert write must never lose a price that was scraped
      // successfully. The scrape is the valuable part.
      await syncUndercutAlerts(match.product_id, match.competitor_id, listing.price).catch((err) => {
        logger.warn('runner', `alert sync failed for ${match.internal_sku}: ${(err as Error).message}`);
      });

      // The competitor's own price falling sharply is its own signal (Spec
      // §5.5), separate from whether it undercuts us.
      await syncPriceDropAlert(match.product_id, match.competitor_id, listing.price).catch((err) => {
        logger.warn('runner', `price-drop alert failed for ${match.internal_sku}: ${(err as Error).message}`);
      });

      // inStock is boolean | null, and null means the page did not say —
      // alerting on unknown would fire constantly on sites that never publish
      // availability, so only an explicit false counts.
      if (listing.inStock === false) {
        await raiseListingGoneAlert(
          match.product_id,
          match.competitor_id,
          'it is showing as out of stock',
        ).catch((err) => {
          logger.warn('runner', `listing-gone alert failed for ${match.internal_sku}: ${(err as Error).message}`);
        });
      } else {
        // Back in stock and readable again — clear any standing alert rather
        // than leaving it open with nothing behind it.
        await resolveListingGone(match.product_id, match.competitor_id).catch((err) => {
          logger.warn('runner', `listing-gone resolve failed for ${match.internal_sku}: ${(err as Error).message}`);
        });
      }

      await recordRunItem(runId, {
        matchId: match.match_id,
        productId: match.product_id,
        competitorId: competitor.id,
        url: match.competitor_url,
        status: 'ok',
        durationMs: Date.now() - startedAt,
      });
      ok += 1;
    } catch (err) {
      const kind = err instanceof ScrapeError ? err.kind : 'unknown';
      // Loud, attributable failure — never a silently wrong price (Spec §5.4).
      logger.error(
        'runner',
        `[${competitor.slug}] ${match.internal_sku} ${match.competitor_url} failed (${kind}): ${(err as Error).message}`,
      );

      // A confirmed match whose page has gone is a signal the team wants, not
      // just a run error to scroll past (Spec §5.5).
      if (kind === 'not_found') {
        await raiseListingGoneAlert(
          match.product_id,
          match.competitor_id,
          'the listing no longer exists',
        ).catch((alertErr) => {
          logger.warn('runner', `listing-gone alert failed: ${(alertErr as Error).message}`);
        });
      }

      await recordRunItem(runId, {
        matchId: match.match_id,
        productId: match.product_id,
        competitorId: competitor.id,
        url: match.competitor_url,
        status: 'error',
        errorKind: kind,
        error: (err as Error).message,
        durationMs: Date.now() - startedAt,
      });
      errored += 1;
    }
  }

  return { ok, errored };
}

/** Search for products that have no confirmed match yet and propose candidates. */
async function discoverUnmatchedProducts(
  runId: number,
  competitor: Competitor,
  limit: number | null,
  productIds: number[] | null,
): Promise<{ ok: number; errored: number; skipped: number }> {
  const { rows: products } = await query<Product>(
    `SELECT p.* FROM products p
     -- Only products the latest feed still lists. Without this a one-product
     -- test feed would still scan everything imported before it.
     WHERE p.delisted_at IS NULL
       AND ($2::bigint[] IS NULL OR p.id = ANY($2::bigint[]))
       -- Naming products means "look at these now". Skipping one for already
       -- having a candidate would make the run you just asked for silently do
       -- nothing for it, which is the opposite of what a targeted run is for.
       AND ($2::bigint[] IS NOT NULL OR NOT EXISTS (
         SELECT 1 FROM product_matches m
         WHERE m.product_id = p.id
           AND m.competitor_id = $1
           AND m.status IN ('confirmed', 'pending')
       ))
     ORDER BY p.id
     ${limit ? 'LIMIT ' + Number(limit) : ''}`,
    [competitor.id, productIds],
  );

  let ok = 0;
  let errored = 0;
  let skipped = 0;

  for (const product of products) {
    // Only search competitors that stock the brand, when they've told us.
    if (
      competitor.brands.length > 0 &&
      !competitor.brands.some((brand) => brand.toLowerCase() === product.brand.toLowerCase())
    ) {
      await recordRunItem(runId, {
        productId: product.id,
        competitorId: competitor.id,
        status: 'skipped',
        errorKind: 'brand_not_stocked',
        error: `${competitor.display_name} is not configured as stocking ${product.brand}`,
      });
      skipped += 1;
      continue;
    }

    const startedAt = Date.now();
    const outcome = await discoverMatchesForProduct(product, competitor, { runId });

    if (outcome.error) {
      // A competitor simply not stocking one of our products is the normal
      // case, not a failure — most of our range is not carried by most of them.
      // Counting it as an error would bury the real failures under thousands of
      // rows saying nothing more than "they don't sell this".
      const notStocked = outcome.error.kind === 'not_found';
      if (notStocked) {
        await recordRunItem(runId, {
          productId: product.id,
          competitorId: competitor.id,
          status: 'skipped',
          errorKind: 'not_listed',
          error: outcome.error.message,
          durationMs: Date.now() - startedAt,
        });
        skipped += 1;
        continue;
      }

      logger.warn(
        'runner',
        `[${competitor.slug}] discovery for ${product.internal_sku} failed (${outcome.error.kind}): ${outcome.error.message}`,
      );
      await recordRunItem(runId, {
        productId: product.id,
        competitorId: competitor.id,
        status: 'error',
        errorKind: outcome.error.kind,
        error: outcome.error.message,
        durationMs: Date.now() - startedAt,
      });
      errored += 1;
      continue;
    }

    // A zero here is not necessarily "nothing found" — a page may have been
    // opened and rejected. Say which, so a test run explains itself instead
    // of reporting a bare zero that looks identical to never trying.
    const detail =
      outcome.candidatesStored > 0
        ? `${outcome.candidatesStored} candidate(s) stored, ${outcome.autoConfirmed} auto-confirmed`
        : outcome.bestAttempt
          ? `Found ${outcome.candidatesFound} candidate URL(s). The closest match, ` +
            `${outcome.bestAttempt.url}, was rejected — ${outcome.bestAttempt.reason}.`
          : `Found ${outcome.candidatesFound} candidate URL(s), but none of them opened successfully.`;

    await recordRunItem(runId, {
      productId: product.id,
      competitorId: competitor.id,
      status: 'ok',
      error: detail,
      durationMs: Date.now() - startedAt,
    });
    ok += 1;
  }

  return { ok, errored, skipped };
}

interface RunItemInput {
  matchId?: number | null;
  productId?: number | null;
  competitorId?: number | null;
  url?: string | null;
  status: 'ok' | 'error' | 'skipped';
  errorKind?: string | null;
  error?: string | null;
  durationMs?: number | null;
}

async function recordRunItem(runId: number, item: RunItemInput): Promise<void> {
  await query(
    `INSERT INTO scrape_run_items
       (run_id, match_id, product_id, competitor_id, url, status, error_kind, error, duration_ms)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      runId,
      item.matchId ?? null,
      item.productId ?? null,
      item.competitorId ?? null,
      item.url ?? null,
      item.status,
      item.errorKind ?? null,
      item.error ?? null,
      item.durationMs ?? null,
    ],
  );

  // Keep the counters live so the UI can show progress mid-run.
  const column =
    item.status === 'ok' ? 'ok_count' : item.status === 'error' ? 'error_count' : 'skipped_count';
  await query(`UPDATE scrape_runs SET ${column} = ${column} + 1 WHERE id = $1`, [runId]);
}
