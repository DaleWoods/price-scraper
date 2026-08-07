import { query } from '../db/pool.js';
import type { Competitor, Product, ScrapeRun } from '../domain/types.js';
import { logger } from '../lib/logger.js';
import { discoverMatchesForProduct } from '../matching/discovery.js';
import { closeBrowser } from './browser.js';
import { listCompetitors } from './competitorRegistry.js';
import { ScrapeError } from './errors.js';
import { extractListing } from './extract.js';
import { fetchPage } from './fetcher.js';

export type RunMode = 'prices' | 'discover' | 'both';

export interface StartRunOptions {
  mode?: RunMode;
  competitorId?: number | null;
  trigger?: string;
  /** Cap on products processed, mainly to keep the first manual runs short. */
  limit?: number | null;
}

let activeRunId: number | null = null;

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
  if (activeRunId !== null) {
    throw new Error(`A scrape run is already in progress (run #${activeRunId}). Wait for it to finish.`);
  }

  const mode = options.mode ?? 'both';
  const { rows } = await query<ScrapeRun>(
    `INSERT INTO scrape_runs (trigger, status, competitor_id)
     VALUES ($1, 'running', $2)
     RETURNING *`,
    [options.trigger ?? 'manual', options.competitorId ?? null],
  );

  const run = rows[0];
  if (!run) throw new Error('Failed to create scrape run');
  activeRunId = run.id;

  // Deliberately not awaited: the HTTP caller gets the run id immediately.
  void executeRun(run.id, mode, options)
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
}

async function executeRun(runId: number, mode: RunMode, options: StartRunOptions): Promise<void> {
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

  let ok = 0;
  let errored = 0;
  let skipped = 0;

  try {
    for (const competitor of competitors) {
      if (mode === 'prices' || mode === 'both') {
        const result = await scrapeConfirmedMatches(runId, competitor, options.limit ?? null);
        ok += result.ok;
        errored += result.errored;
      }
      if (mode === 'discover' || mode === 'both') {
        const result = await discoverUnmatchedProducts(runId, competitor, options.limit ?? null);
        ok += result.ok;
        errored += result.errored;
        skipped += result.skipped;
      }
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

/** Scrape the stored URL of every confirmed match (Spec §5.4 — direct-URL path). */
async function scrapeConfirmedMatches(
  runId: number,
  competitor: Competitor,
  limit: number | null,
): Promise<{ ok: number; errored: number }> {
  const { rows: matches } = await query<MatchRow>(
    `SELECT m.id AS match_id, m.product_id, m.competitor_id, m.competitor_url, p.internal_sku
     FROM product_matches m
     JOIN products p ON p.id = m.product_id
     WHERE m.competitor_id = $1 AND m.status = 'confirmed'
     ORDER BY m.id
     ${limit ? 'LIMIT ' + Number(limit) : ''}`,
    [competitor.id],
  );

  let ok = 0;
  let errored = 0;

  for (const match of matches) {
    const startedAt = Date.now();
    try {
      const page = await fetchPage(competitor, match.competitor_url);
      const listing = extractListing(competitor, page);

      await query(
        `INSERT INTO price_observations
           (product_id, competitor_id, match_id, scrape_run_id, price, was_price, currency,
            promo, in_stock, availability_text, source_url)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
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
        ],
      );

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
): Promise<{ ok: number; errored: number; skipped: number }> {
  const { rows: products } = await query<Product>(
    `SELECT p.* FROM products p
     WHERE NOT EXISTS (
       SELECT 1 FROM product_matches m
       WHERE m.product_id = p.id
         AND m.competitor_id = $1
         AND m.status IN ('confirmed', 'pending')
     )
     ORDER BY p.id
     ${limit ? 'LIMIT ' + Number(limit) : ''}`,
    [competitor.id],
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

    await recordRunItem(runId, {
      productId: product.id,
      competitorId: competitor.id,
      status: 'ok',
      error: `${outcome.candidatesStored} candidate(s) stored, ${outcome.autoConfirmed} auto-confirmed`,
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
