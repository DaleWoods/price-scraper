import { query } from '../db/pool.js';
import type { Competitor, Product, ScrapeRun } from '../domain/types.js';
import { logger } from '../lib/logger.js';
import { env } from '../config/env.js';
import { matchFromCatalogue } from '../matching/catalogueMatch.js';
import { pagesAtOnce } from './catalogue.js';
import { beginRunProgress, finishRunProgress, updateCompetitorProgress } from './runProgress.js';
import { discoverMatchesForProduct } from '../matching/discovery.js';
import {
  compareIdentifiers,
  type OurIdentifiers,
  type TheirIdentifiers,
} from '../matching/identifiers.js';
import { countCachedUrls, refreshCompetitorUrls } from '../matching/sitemapDiscovery.js';
import { raiseListingGoneAlert } from '../services/alerts.js';
import { closeBrowser } from './browser.js';
import { harvestCatalogue, recordCatalogueListing } from './catalogue.js';
import { listCompetitors } from './competitorRegistry.js';
import { ScrapeError } from './errors.js';
import { fetchAndExtract } from './fetchAndExtract.js';
import { recordPriceObservation } from './observations.js';
import { UnblockerBudget, isUnblockerConfigured } from './unblocker.js';

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
  /**
   * False for a one-product lookup from the Check a product page. Such a run
   * may start while another is in progress — the nightly job can take hours,
   * and someone checking one watch should not wait behind it. It is small, and
   * every request still goes through the same per-site rate limiter, so two
   * runs together never ask a competitor for pages any faster.
   */
  exclusive?: boolean;
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

/**
 * Mark runs the app was working on when it last stopped as stopped. A run
 * lives in this process; after a restart nothing is running it, and one left
 * saying "running" would read as working for ever.
 */
export async function markInterruptedRuns(): Promise<number> {
  const { rowCount } = await query(
    `UPDATE scrape_runs SET status = 'failed', finished_at = now(),
            error = coalesce(error, 'Stopped when the app restarted.')
     WHERE status = 'running'`,
  );
  return rowCount ?? 0;
}

/** True while any run, a full check or a single product's, is still working. */
export function isAnyRunInFlight(): boolean {
  return runsInFlight > 0;
}

export function getActiveRunId(): number | null {
  return activeRunId;
}

interface MatchRow {
  match_id: number;
  product_id: number;
  competitor_id: number;
  competitor_url: string;
  internal_sku: string;
  /** Ours, for re-checking the page is still the product we matched. */
  ean_mpn: string | null;
  gtin: string | null;
  mpn: string | null;
}

/**
 * Has this page stopped being the product we matched?
 *
 * Only an *explicit disagreement between two barcodes* counts. A page that
 * publishes no identifier tells us nothing, and treating silence as a mismatch
 * would flag most of the web; a product of ours with no barcode cannot be
 * checked either way. A differing reference does not count either: several
 * retailers publish their own stock code where the manufacturer's reference
 * belongs, and flagging those would flag every match they have. The check is
 * for catching a URL that now serves a different product, not for demanding
 * identifiers nobody publishes.
 *
 * Each side may be given as the older single value or as its separate parts.
 */
export function identityMismatch(
  ours: string | null | OurIdentifiers,
  theirs: string | null | undefined | TheirIdentifiers,
): { mismatched: boolean; ours: string; theirs: string } {
  const ourSide: OurIdentifiers = typeof ours === 'string' || ours == null ? { eanMpn: ours } : ours;
  const theirSide: TheirIdentifiers =
    typeof theirs === 'string' || theirs == null ? { ean: theirs } : theirs;

  const verdict = compareIdentifiers(ourSide, theirSide);
  if (verdict.verdict === 'conflict') {
    return { mismatched: true, ours: verdict.ours, theirs: verdict.theirs };
  }
  return { mismatched: false, ours: '', theirs: '' };
}

/**
 * Manual "run now" trigger (MVP — no scheduler yet).
 *
 * Returns as soon as the run row exists; the scrape itself continues in the
 * background and its progress is readable from scrape_runs / scrape_run_items.
 */
/** Runs executing now, exclusive or not; the browser is freed only when none are. */
let runsInFlight = 0;

export async function startRun(options: StartRunOptions = {}): Promise<ScrapeRun> {
  if (options.exclusive === false) return await startLookupRun(options);
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

/** A non-exclusive run: see StartRunOptions.exclusive. */
async function startLookupRun(options: StartRunOptions): Promise<ScrapeRun> {
  const productIds =
    options.productIds && options.productIds.length > 0
      ? options.productIds
      : options.productId != null
        ? [options.productId]
        : null;
  // Any length of named list may run alongside another run. A long one reads
  // catalogues like the nightly job does, but every request still passes the
  // same per-site rate limiter, so two runs together never ask a competitor
  // for pages any faster than one would.
  if (!productIds) {
    throw new Error('Only named products can be checked alongside another run.');
  }
  const { rows } = await query<ScrapeRun>(
    `INSERT INTO scrape_runs (trigger, status, competitor_id, product_id, product_count)
     VALUES ($1, 'running', $2, $3, $4)
     RETURNING *`,
    [
      options.trigger ?? 'lookup',
      options.competitorId ?? null,
      productIds.length === 1 ? productIds[0] : null,
      productIds.length > 1 ? productIds.length : null,
    ],
  );
  const run = rows[0]!;
  void executeRun(run.id, options.mode ?? 'both', productIds, options).catch(async (err) => {
    logger.error('runner', `run ${run.id} failed: ${(err as Error).message}`, err);
    await query(
      `UPDATE scrape_runs SET status = 'failed', error = $2, finished_at = now() WHERE id = $1`,
      [run.id, (err as Error).message],
    ).catch(() => undefined);
  });
  return run;
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

  // A check of every product, or of a list, is shown with a progress bar per
  // competitor. A single product's check answers in a minute and needs none.
  if (!productIds) beginRunProgress(runId, competitors, 'full');
  else if (productIds.length > 1) beginRunProgress(runId, competitors, 'list');
  let failed = true;

  runsInFlight += 1;
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
    // One allowance for the whole run, shared across competitors. Per
    // competitor it would multiply by however many are enabled, which is
    // exactly the number nobody thinks about when setting a ceiling.
    const unblockerBudget = new UnblockerBudget();
    const barcodesBefore = productIds ? await barcodesOf(productIds) : new Map<number, string | null>();

    const results = await mapWithConcurrency(competitors, COMPETITOR_CONCURRENCY, (competitor) =>
      runCompetitor(
        runId,
        competitor,
        mode,
        options.limit ?? null,
        productIds,
        options.forceHarvest,
        unblockerBudget,
      ),
    );

    if (isUnblockerConfigured() && unblockerBudget.spent > 0) {
      logger.info(
        'runner',
        `run ${runId} used ${unblockerBudget.spent} paid unblocking call(s)` +
          `${unblockerBudget.exhausted ? ' and hit the per-run ceiling' : ''}`,
      );
    }

    // A product checked by its reference can pick up a barcode along the way,
    // from a retailer that publishes both (see adoptBarcode). Competitors that
    // publish only a barcode — Ernest Jones, H.Samuel — have already been
    // checked without it by then, so they are checked once more with it.
    if (productIds && productIds.length <= SCOPED_SEARCH_MAX) {
      const retry = await competitorsWorthRetrying(competitors, productIds, barcodesBefore);
      if (retry.length > 0) {
        logger.info(
          'runner',
          `run ${runId}: barcode learned during the run; checking ${retry.map((c) => c.slug).join(', ')} again`,
        );
        results.push(
          ...(await mapWithConcurrency(retry, COMPETITOR_CONCURRENCY, (competitor) =>
            runCompetitor(runId, competitor, mode, null, productIds, false, unblockerBudget),
          )),
        );
      }
    }

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
    failed = false;

    // Every product this run looked for at every competitor has now been
    // compared, found or not. A run over one competitor, or prices only, has
    // not looked everywhere, so it does not count.
    if (mode !== 'prices' && !options.competitorId) {
      await query(
        `UPDATE products SET compared_at = now()
         WHERE delisted_at IS NULL AND ($1::bigint[] IS NULL OR id = ANY($1::bigint[]))`,
        [productIds],
      );
    }
  } finally {
    finishRunProgress(runId, failed);
    runsInFlight -= 1;
    // Free the Chromium process once nothing is using it. Another run may
    // still be in flight — a lookup during the nightly job — and closing the
    // browser under it would fail every page it had open.
    if (runsInFlight === 0) await closeBrowser();
  }
}

async function barcodesOf(productIds: number[]): Promise<Map<number, string | null>> {
  const { rows } = await query<{ id: number; gtin: string | null }>(
    'SELECT id, gtin FROM products WHERE id = ANY($1::bigint[])',
    [productIds],
  );
  return new Map(rows.map((row) => [Number(row.id), row.gtin]));
}

/** Competitors with no confirmed match for a product that gained a barcode during this run. */
async function competitorsWorthRetrying(
  competitors: Competitor[],
  productIds: number[],
  before: Map<number, string | null>,
): Promise<Competitor[]> {
  const after = await barcodesOf(productIds);
  const gained = productIds.filter((id) => !before.get(id) && after.get(id));
  if (gained.length === 0) return [];
  const { rows } = await query<{ competitor_id: number }>(
    `SELECT DISTINCT competitor_id FROM product_matches
     WHERE product_id = ANY($1::bigint[]) AND status = 'confirmed'`,
    [gained],
  );
  const matched = new Set(rows.map((row) => Number(row.competitor_id)));
  return competitors.filter((competitor) => !matched.has(Number(competitor.id)));
}

/**
 * The longest named list still searched for product by product.
 *
 * The per-product search opens up to three guessed pages per product per
 * competitor: fine for checking a handful, ruinous for an uploaded list of
 * thousands (2,500 products at five competitors is up to 37,500 page loads,
 * against about 34,000 to read all five catalogues outright — once). Above
 * this, a scoped run reads catalogues like a full run and matches only the
 * named products against them.
 */
const SCOPED_SEARCH_MAX = 500;

/**
 * How many competitors run concurrently within one scrape run.
 *
 * Every enabled one. Each competitor is a different website, read one page at
 * a time with its own pause between pages, so reading all of them at once adds
 * nothing to any one retailer's load. It only stops some of them waiting
 * hours for a turn. Pages are read over plain HTTP almost everywhere; the
 * browser, when a page does need it, has its own much tighter limit in
 * fetcher.ts, so this is mostly waiting, and waiting on twelve sites costs the
 * same as waiting on one.
 */
const COMPETITOR_CONCURRENCY = 16;

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
  unblockerBudget: UnblockerBudget,
): Promise<{ ok: number; errored: number; skipped: number }> {
  let ok = 0;
  let errored = 0;
  let skipped = 0;
  const runStartedAt = new Date();

  // On a check of every product, the price of everything already matched here
  // is re-read first. That is the answer people come back for in the morning
  // — has anyone changed a price overnight — and it takes minutes, where
  // reading the catalogue for new products can take hours. Done first, it is
  // done even if the night's reading is cut short by the time limit or a
  // restart. Anything the catalogue reading then finds new is priced from the
  // page it reads, and the pass at the end picks up whatever is left.
  if (productIds == null && (mode === 'prices' || mode === 'both')) {
    updateCompetitorProgress(runId, competitor.slug, { stage: 'repricing' });
    const known = await scrapeConfirmedMatches(runId, competitor, limit, null, unblockerBudget, (done, total) =>
      updateCompetitorProgress(runId, competitor.slug, { pricesChecked: done, pricesTotal: total }),
    );
    ok += known.ok;
    errored += known.errored;
  }

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

    // A full run reads the competitor's catalogue: every product page not yet
    // read, plus the slice due a re-read. So does a run over a long uploaded
    // list — for a few hundred products, reading the catalogue is far cheaper
    // than guessing pages product by product. A run over a handful of named
    // products does not: it is meant to answer quickly, from what is held.
    const smallList = productIds != null && productIds.length <= SCOPED_SEARCH_MAX;
    if (!smallList) {
      const harvest = await harvestCatalogue(competitor, {
        runId,
        maxPages: limit,
        deadline: Date.now() + env.catalogueHarvestMinutes * 60_000,
        onQueue: (pages) =>
          updateCompetitorProgress(runId, competitor.slug, {
            stage: 'reading',
            pagesTotal: pages,
            pagesRead: 0,
            readingSince: new Date().toISOString(),
          }),
        // Counters move as pages are read, so a harvest of several thousand
        // pages shows progress rather than a run that looks stuck for hours.
        onPage: async (status) => {
          const column =
            status === 'ok' ? 'ok_count' : status === 'error' ? 'error_count' : 'skipped_count';
          if (status === 'ok') ok += 1;
          else if (status === 'error') errored += 1;
          else skipped += 1;
          updateCompetitorProgress(runId, competitor.slug, (entry) => {
            entry.pagesRead += 1;
          });
          await query(`UPDATE scrape_runs SET ${column} = ${column} + 1 WHERE id = $1`, [runId]);
        },
      });

      if (harvest.stopped === 'deadline' || harvest.stopped === 'blocked') {
        updateCompetitorProgress(runId, competitor.slug, {
          note:
            harvest.stopped === 'blocked'
              ? 'The site started turning requests away, so reading stopped early.'
              : `Stopped at the time limit; ${harvest.remaining} page(s) left for the next check.`,
        });
      }

      if (harvest.attempted > 0 || harvest.stopped) {
        const blocked = harvest.stopped === 'blocked';
        await recordRunItem(runId, {
          competitorId: competitor.id,
          status: blocked ? 'error' : 'ok',
          errorKind: blocked ? 'blocked' : null,
          error:
            `Catalogue: read ${harvest.attempted} page(s) — ${harvest.products} product(s), ` +
            `${harvest.notProducts} not a product, ${harvest.gone} gone, ${harvest.errors} failed.` +
            (harvest.remaining > 0 ? ` ${harvest.remaining} page(s) still to read on a later run.` : '') +
            (harvest.detail ? ` ${harvest.detail}` : ''),
        });
        if (blocked) errored += 1;
        else ok += 1;
      }
    }

    // Match against the catalogue we hold — a database lookup, no requests.
    // On a full run a new match is priced from the page just read, so the
    // price pass below does not fetch the same page a second time.
    updateCompetitorProgress(runId, competitor.slug, { stage: 'matching' });
    const matched = await matchFromCatalogue(competitor, {
      runId,
      productIds,
      priceIfReadSince: smallList ? null : runStartedAt,
    });
    updateCompetitorProgress(runId, competitor.slug, (entry) => {
      entry.matched += matched.byIdentifier;
    });
    if (matched.byIdentifier + matched.byTitle > 0) {
      await recordRunItem(runId, {
        competitorId: competitor.id,
        status: 'ok',
        error:
          `Matched from the stored catalogue: ${matched.byIdentifier} by barcode or reference, ` +
          `${matched.byTitle} by title — ${matched.autoConfirmed} confirmed, ` +
          `${matched.pending} for review, ${matched.priced} priced without a further request.`,
      });
      ok += 1;
    }

    // The older route — guess which of their URLs might be the product, open
    // the likeliest few — is kept for runs scoped to named products, where the
    // catalogue may not have been read yet and an answer is wanted now. A full
    // run does not need it: the harvest above reads those same pages, all of
    // them, and matches on what they say rather than on their address.
    if (smallList && productIds != null) {
      const settled = new Set(matched.matchedProductIds);
      const remaining = productIds.filter((id) => !settled.has(id));
      if (remaining.length > 0) {
        updateCompetitorProgress(runId, competitor.slug, {
          stage: 'searching',
          pagesRead: 0,
          pagesTotal: remaining.length,
          readingSince: new Date().toISOString(),
        });
        const result = await discoverUnmatchedProducts(runId, competitor, limit, remaining, (found) =>
          updateCompetitorProgress(runId, competitor.slug, (entry) => {
            entry.pagesRead += 1;
            if (found) entry.matched += 1;
          }),
        );
        ok += result.ok;
        errored += result.errored;
        skipped += result.skipped;
      }
    }
  }

  if (mode === 'prices' || mode === 'both') {
    updateCompetitorProgress(runId, competitor.slug, { stage: 'pricing' });
    const result = await scrapeConfirmedMatches(
      runId,
      competitor,
      limit,
      productIds,
      unblockerBudget,
    );
    ok += result.ok;
    errored += result.errored;
  }

  updateCompetitorProgress(runId, competitor.slug, { stage: 'done' });
  return { ok, errored, skipped };
}

/** Scrape the stored URL of every confirmed match (Spec §5.4 — direct-URL path). */
/**
 * Re-read the price for every confirmed match.
 *
 * This is the only path that may spend on the paid unblocking backend, and
 * deliberately so: a confirmed match is a page we already know is the right
 * product, so an unblocked fetch of it buys a price we actually want.
 * Discovery, by contrast, opens candidates that are still guesses — several
 * per product, most of which are rejected — so paying to unblock one would be
 * paying for a maybe. It is given no budget and therefore never reaches the
 * paid path at all.
 */
async function scrapeConfirmedMatches(
  runId: number,
  competitor: Competitor,
  limit: number | null,
  productIds: number[] | null,
  unblockerBudget: UnblockerBudget,
  onProgress?: (done: number, total: number) => void,
): Promise<{ ok: number; errored: number }> {
  const { rows: matches } = await query<MatchRow>(
    `SELECT m.id AS match_id, m.product_id, m.competitor_id, m.competitor_url,
            p.internal_sku, p.ean_mpn, p.gtin, p.mpn
     FROM product_matches m
     JOIN products p ON p.id = m.product_id
     -- A delisted product is no longer sold by us, so re-checking a
     -- competitor's price for it would only add noise.
     WHERE m.competitor_id = $1 AND m.status = 'confirmed' AND p.delisted_at IS NULL
       -- A match already flagged as pointing at the wrong product is skipped
       -- until someone resolves it, rather than failing identically every
       -- night and burying the real errors.
       AND m.flagged_at IS NULL
       AND ($2::bigint[] IS NULL OR m.product_id = ANY($2::bigint[]))
       -- Already priced by this run, from the catalogue page read moments ago.
       -- Fetching it again would be a second request for the same answer.
       AND NOT EXISTS (
         SELECT 1 FROM price_observations po
         WHERE po.match_id = m.id AND po.scrape_run_id = $3
       )
     ORDER BY m.id
     ${limit ? 'LIMIT ' + Number(limit) : ''}`,
    [competitor.id, productIds, runId],
  );

  let ok = 0;
  let errored = 0;

  // As many at once as the competitor allows, like the catalogue reading.
  let done = 0;
  let nextMatch = 0;
  const priceOne = async (match: MatchRow): Promise<void> => {
    const startedAt = Date.now();
    try {
      const { page, listing } = await fetchAndExtract(competitor, match.competitor_url, {
        unblockerBudget,
      });

      // Is this still the product we matched? Checked here rather than only at
      // discovery, because a stored URL outlives the page it pointed at: a
      // redirect to a replacement model, or a slug reused next season, would
      // otherwise have us recording a plausible price for the wrong watch
      // indefinitely.
      const identity = identityMismatch(
        { gtin: match.gtin, mpn: match.mpn, eanMpn: match.ean_mpn },
        { gtin: listing.gtin, mpn: listing.mpn, sku: listing.sku, ean: listing.ean },
      );
      if (identity.mismatched) {
        await query(
          `UPDATE product_matches SET flagged_at = now(), flag_reason = $2, status = 'rejected' WHERE id = $1`,
          [
            match.match_id,
            `Page now publishes ${identity.theirs}, but this product is ${identity.ours}. ` +
              'The URL may have been reused or redirected.',
          ],
        );

        await recordRunItem(runId, {
          matchId: match.match_id,
          productId: match.product_id,
          competitorId: competitor.id,
          url: match.competitor_url,
          status: 'error',
          errorKind: 'identity_mismatch',
          error:
            `${match.internal_sku}: the page now identifies as ${identity.theirs}, not ` +
            `${identity.ours}. No price recorded; the match is set aside and the next check looks for the right page.`,
          durationMs: Date.now() - startedAt,
        });
        errored += 1;
        logger.warn(
          'runner',
          `[${competitor.slug}] ${match.internal_sku} identity mismatch: ours ${identity.ours}, page ${identity.theirs}`,
        );
        return;
      }

      await recordPriceObservation(
        {
          matchId: match.match_id,
          productId: match.product_id,
          competitorId: match.competitor_id,
          internalSku: match.internal_sku,
        },
        listing,
        { runId, sourceUrl: page.finalUrl, renderedWith: page.renderedWith },
      );

      // Keep the stored catalogue page in step with what was just read, so the
      // catalogue never lags the prices taken from the same pages.
      await recordCatalogueListing(competitor.id, match.competitor_url, page, listing).catch((err) => {
        logger.warn('runner', `catalogue update failed for ${match.internal_sku}: ${(err as Error).message}`);
      });

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
        blockCause: err instanceof ScrapeError ? (err.diagnosis?.cause ?? null) : null,
        error: (err as Error).message,
        durationMs: Date.now() - startedAt,
      });
      errored += 1;
    }
  };
  const priceWorker = async (): Promise<void> => {
    for (;;) {
      const index = nextMatch;
      nextMatch += 1;
      if (index >= matches.length) return;
      onProgress?.(done, matches.length);
      await priceOne(matches[index]!);
      done += 1;
    }
  };
  await Promise.all(Array.from({ length: Math.min(pagesAtOnce(competitor), matches.length) }, priceWorker));
  onProgress?.(matches.length, matches.length);

  return { ok, errored };
}

/** Search for products that have no confirmed match yet and propose candidates. */
async function discoverUnmatchedProducts(
  runId: number,
  competitor: Competitor,
  limit: number | null,
  productIds: number[] | null,
  /** Told after each product has been searched for, and whether it was found. */
  onProduct?: (found: boolean) => void,
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
     -- Products nobody has ever priced come first. Discovery works through the
     -- catalogue, so without this a line that went live this morning sits
     -- behind everything added before it — and new lines are exactly where
     -- pricing decisions get made. Within each group the order is by id, so a
     -- backlog still drains in the order it formed rather than reshuffling
     -- every run.
     ORDER BY (EXISTS (
                SELECT 1 FROM price_observations po
                WHERE po.product_id = p.id AND po.price IS NOT NULL
              )), p.id
     ${limit ? 'LIMIT ' + Number(limit) : ''}`,
    [competitor.id, productIds],
  );

  let ok = 0;
  let errored = 0;
  let skipped = 0;
  let confirmed = 0;

  for (const product of products) {
    const confirmedBefore = confirmed;
    await searchOne(product);
    onProduct?.(confirmed > confirmedBefore);
  }

  return { ok, errored, skipped };

  async function searchOne(product: Product): Promise<void> {
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
      return;
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
        return;
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
        blockCause: outcome.error.blockCause ?? null,
        error: outcome.error.message,
        durationMs: Date.now() - startedAt,
      });
      errored += 1;
      return;
    }

    if (outcome.autoConfirmed > 0) confirmed += 1;

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
}

interface RunItemInput {
  matchId?: number | null;
  productId?: number | null;
  competitorId?: number | null;
  url?: string | null;
  status: 'ok' | 'error' | 'skipped';
  errorKind?: string | null;
  /** Set only on a block: which kind of wall, so the remedy is knowable. */
  blockCause?: string | null;
  error?: string | null;
  durationMs?: number | null;
}

async function recordRunItem(runId: number, item: RunItemInput): Promise<void> {
  await query(
    `INSERT INTO scrape_run_items
       (run_id, match_id, product_id, competitor_id, url, status, error_kind, error,
        duration_ms, block_cause)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
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
      item.blockCause ?? null,
    ],
  );

  // Keep the counters live so the UI can show progress mid-run.
  const column =
    item.status === 'ok' ? 'ok_count' : item.status === 'error' ? 'error_count' : 'skipped_count';
  await query(`UPDATE scrape_runs SET ${column} = ${column} + 1 WHERE id = $1`, [runId]);
}
