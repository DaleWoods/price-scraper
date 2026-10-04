import { query } from '../db/pool.js';

/**
 * What every figure in this app is actually based on.
 *
 * The first thing anyone asks of a percentage is how much it is drawn from,
 * and an unqualified "63% of the range is beaten" invites exactly that
 * challenge. It is also the number most likely to be embarrassing: 63% of a
 * tenth of the catalogue, read a fortnight ago, is a very different claim from
 * 63% of all of it read last night.
 *
 * Reported at the level someone would challenge it in a meeting — how much of
 * what we sell is covered, how fresh those prices are, how many competitors
 * contributed — rather than per filter, because the question is about the
 * evidence behind the tool, not behind one screen.
 */

export interface EvidenceBasis {
  fascia: { id: number; code: string; name: string } | null;
  /** Live products we hold a price for at this site. */
  productsPriced: number;
  /** Of those, how many have at least one competitor price. */
  productsCompared: number;
  coveragePct: number;
  /** Competitors that produced at least one price in the window. */
  competitorsContributing: number;
  competitorsEnabled: number;
  /** Median age in days of the latest price per product/competitor pair. */
  medianPriceAgeDays: number | null;
  /** Age of the oldest price still being shown as current. */
  oldestPriceAgeDays: number | null;
  newestObservationAt: string | null;
  lastRunFinishedAt: string | null;
  lastRunStatus: string | null;
  windowDays: number;
}

export async function getEvidenceBasis(
  fasciaId: number,
  windowDays = 30,
): Promise<EvidenceBasis> {
  const { rows: fasciaRows } = await query<{ id: number; code: string; name: string }>(
    'SELECT id, code, name FROM fascias WHERE id = $1',
    [fasciaId],
  );

  const { rows } = await query<{
    products_priced: string;
    products_compared: string;
    competitors_contributing: string;
    median_age_days: string | null;
    oldest_age_days: string | null;
    newest_observation_at: string | null;
  }>(
    // The latest observation per product/competitor pair is what every figure
    // in the app reads, so its age is the age that matters — not the age of
    // the whole table, which includes every superseded price ever recorded.
    `WITH latest AS (
       SELECT DISTINCT ON (po.product_id, po.competitor_id)
              po.product_id, po.competitor_id, po.observed_at
       FROM price_observations po
       WHERE po.price IS NOT NULL
       ORDER BY po.product_id, po.competitor_id, po.observed_at DESC
     ),
     priced AS (
       SELECT p.id
       FROM products p
       JOIN fascia_prices fp ON fp.product_id = p.id AND fp.fascia_id = $1
       WHERE p.delisted_at IS NULL AND fp.price IS NOT NULL
     )
     SELECT (SELECT count(*)::text FROM priced) AS products_priced,
            (SELECT count(DISTINCT l.product_id)::text
               FROM latest l JOIN priced pr ON pr.id = l.product_id) AS products_compared,
            (SELECT count(DISTINCT l.competitor_id)::text
               FROM latest l
               WHERE l.observed_at >= now() - ($2::int * interval '1 day')) AS competitors_contributing,
            (SELECT percentile_cont(0.5) WITHIN GROUP (
                      ORDER BY EXTRACT(EPOCH FROM (now() - l.observed_at)) / 86400)::text
               FROM latest l JOIN priced pr ON pr.id = l.product_id) AS median_age_days,
            (SELECT (EXTRACT(EPOCH FROM (now() - min(l.observed_at))) / 86400)::text
               FROM latest l JOIN priced pr ON pr.id = l.product_id) AS oldest_age_days,
            (SELECT max(l.observed_at)::text FROM latest l) AS newest_observation_at`,
    [fasciaId, windowDays],
  );

  const { rows: competitorRows } = await query<{ enabled: string }>(
    'SELECT count(*)::text AS enabled FROM competitors WHERE enabled',
  );

  const { rows: runRows } = await query<{ finished_at: string | null; status: string | null }>(
    `SELECT finished_at, status FROM scrape_runs
      WHERE status <> 'running'
      ORDER BY finished_at DESC NULLS LAST
      LIMIT 1`,
  );

  const row = rows[0];
  const productsPriced = Number(row?.products_priced ?? 0);
  const productsCompared = Number(row?.products_compared ?? 0);
  const round = (value: string | null | undefined): number | null =>
    value == null ? null : Math.round(Number(value) * 10) / 10;

  return {
    fascia: fasciaRows[0] ?? null,
    productsPriced,
    productsCompared,
    // 0 rather than null when nothing is priced: "we sell nothing here" and
    // "we cover none of what we sell" both read as zero coverage, and the
    // counts beside it say which.
    coveragePct:
      productsPriced === 0 ? 0 : Math.round((productsCompared / productsPriced) * 1000) / 10,
    competitorsContributing: Number(row?.competitors_contributing ?? 0),
    competitorsEnabled: Number(competitorRows[0]?.enabled ?? 0),
    medianPriceAgeDays: round(row?.median_age_days),
    oldestPriceAgeDays: round(row?.oldest_age_days),
    newestObservationAt: row?.newest_observation_at
      ? new Date(row.newest_observation_at).toISOString()
      : null,
    lastRunFinishedAt: runRows[0]?.finished_at
      ? new Date(runRows[0].finished_at).toISOString()
      : null,
    lastRunStatus: runRows[0]?.status ?? null,
    windowDays,
  };
}

export interface StockOpportunity {
  productId: number;
  internalSku: string;
  productName: string;
  brand: string;
  ourPrice: number;
  /** The cheapest price below ours that nobody can currently buy. */
  theirPrice: number;
  competitorName: string;
  gapAbs: number;
  gapPct: number;
  observedAt: string;
  currency: string;
}

/**
 * Products where the only thing beating us is out of stock.
 *
 * A rival who normally undercuts us but cannot fulfil is a window: for as long
 * as it lasts there is no cheaper buyable alternative, which is an argument
 * for holding a price rather than following one down.
 *
 * Deliberately narrow. If any *in-stock* competitor already beats us the
 * window does not exist, however many others are out of stock — a customer can
 * still buy it cheaper elsewhere, so nothing has changed in our favour.
 */
export async function getStockOpportunities(
  fasciaId: number,
  limit = 100,
): Promise<StockOpportunity[]> {
  const { rows } = await query<{
    product_id: number;
    internal_sku: string;
    product_name: string;
    brand: string;
    our_price: string;
    their_price: string;
    competitor_name: string;
    observed_at: string;
    currency: string | null;
  }>(
    `WITH latest AS (
       SELECT DISTINCT ON (po.product_id, po.competitor_id)
              po.product_id, po.competitor_id, po.price, po.in_stock, po.observed_at
       FROM price_observations po
       WHERE po.price IS NOT NULL
       ORDER BY po.product_id, po.competitor_id, po.observed_at DESC
     ),
     ours AS (
       SELECT p.id AS product_id, p.internal_sku, p.product_name, p.brand,
              fp.price AS our_price, COALESCE(fp.currency, p.currency) AS currency
       FROM products p
       JOIN fascia_prices fp ON fp.product_id = p.id AND fp.fascia_id = $1
       WHERE p.delisted_at IS NULL AND fp.price IS NOT NULL
     )
     SELECT DISTINCT ON (o.product_id)
            o.product_id, o.internal_sku, o.product_name, o.brand,
            o.our_price, l.price AS their_price, c.display_name AS competitor_name,
            l.observed_at, o.currency
     FROM ours o
     JOIN latest l ON l.product_id = o.product_id
     JOIN competitors c ON c.id = l.competitor_id
     WHERE l.in_stock IS FALSE
       AND l.price < o.our_price
       -- Nobody buyable is beating us. Without this the "window" is imaginary:
       -- a customer could still get it cheaper from someone who has stock.
       AND NOT EXISTS (
         SELECT 1 FROM latest l2
         WHERE l2.product_id = o.product_id
           AND l2.in_stock IS DISTINCT FROM FALSE
           AND l2.price < o.our_price
       )
     ORDER BY o.product_id, l.price ASC
     LIMIT $2`,
    [fasciaId, limit],
  );

  return rows.map((row) => {
    const ourPrice = Number(row.our_price);
    const theirPrice = Number(row.their_price);
    const gapAbs = Math.round((ourPrice - theirPrice) * 100) / 100;
    return {
      productId: row.product_id,
      internalSku: row.internal_sku,
      productName: row.product_name,
      brand: row.brand,
      ourPrice,
      theirPrice,
      competitorName: row.competitor_name,
      gapAbs,
      gapPct: ourPrice === 0 ? 0 : Math.round((gapAbs / ourPrice) * 1000) / 10,
      observedAt: new Date(row.observed_at).toISOString(),
      currency: row.currency ?? 'GBP',
    };
  });
}
