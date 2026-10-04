import { query } from '../db/pool.js';

/**
 * Where we sit in the market, in aggregate.
 *
 * The comparison and movement pages are per product, which is the right unit
 * for someone about to change a price. This is the unit for someone deciding
 * a range or negotiating with a supplier: not "this watch is £40 dearer" but
 * "we are above the market on three quarters of TAG Heuer, and the gap is
 * widening".
 *
 * Two conventions carried over from comparison.ts so the numbers agree with
 * every other page: a sub-penny difference is level rather than a spurious
 * "higher", and a percentage gap is always relative to *our* price, because
 * "they are 20% cheaper" naturally means 20% of what we charge.
 */

export interface PositionBreakdown {
  /** The brand, category or competitor this row describes. */
  key: string;
  /** Products where we hold a price and at least one competitor does too. */
  compared: number;
  lower: number;
  equal: number;
  higher: number;
  /** Share of compared products where a competitor beats us, 0–100. */
  higherPct: number;
  /** Median gap in pounds. Negative means we are cheaper. */
  medianGapAbs: number | null;
  /** Median gap as a percentage of our price. Negative means we are cheaper. */
  medianGapPct: number | null;
  /** The single widest gap against us, for spotting an outlier worth a look. */
  worstGapAbs: number | null;
  worstGapSku: string | null;
}

export interface PositionTrendPoint {
  /** ISO date of the week beginning. */
  weekStart: string;
  compared: number;
  lower: number;
  equal: number;
  higher: number;
  higherPct: number;
}

/**
 * The position split by whether the comparison was like for like.
 *
 * This is the figure that decides whether the headline can be trusted. A range
 * that looks healthy because we are mid-sale against competitors at full price
 * is not in a healthy position — it is in a temporary one, and it reverts the
 * week the promotion ends. Equally, being beaten largely by rivals who are
 * themselves on promotion is a different problem from being beaten at their
 * regular price.
 */
export interface BasisSplit {
  basis: 'like_for_like' | 'ours_promotional' | 'theirs_promotional' | 'both_promotional';
  compared: number;
  lower: number;
  equal: number;
  higher: number;
  higherPct: number;
}

export interface PositionAnalysis {
  fascia: { id: number; code: string; name: string } | null;
  generatedAt: string;
  overall: PositionBreakdown;
  byBrand: PositionBreakdown[];
  byCategory: PositionBreakdown[];
  byCompetitor: PositionBreakdown[];
  trend: PositionTrendPoint[];
  /** The same position, split by whether anyone was on promotion. */
  byBasis: BasisSplit[];
  /** Products we sell at this site but have no competitor price for at all. */
  uncovered: number;
}

const num = (value: string | number | null | undefined): number | null =>
  value == null ? null : Number(value);

interface BreakdownRow {
  key: string | null;
  compared: string | number;
  lower: string | number;
  equal: string | number;
  higher: string | number;
  median_gap_abs: string | number | null;
  median_gap_pct: string | number | null;
  worst_gap_abs: string | number | null;
  worst_gap_sku: string | null;
}

function toBreakdown(row: BreakdownRow, fallbackKey = 'Unspecified'): PositionBreakdown {
  const compared = Number(row.compared);
  const higher = Number(row.higher);
  return {
    key: row.key ?? fallbackKey,
    compared,
    lower: Number(row.lower),
    equal: Number(row.equal),
    higher,
    // Null would be more honest than 0 for an empty group, but a group only
    // exists here because it has at least one compared product.
    higherPct: compared === 0 ? 0 : Math.round((higher / compared) * 1000) / 10,
    medianGapAbs: num(row.median_gap_abs),
    medianGapPct: num(row.median_gap_pct),
    worstGapAbs: num(row.worst_gap_abs),
    worstGapSku: row.worst_gap_sku,
  };
}

/**
 * The shared base: one row per product, against the cheapest competitor who
 * actually has it in stock.
 *
 * Cheapest rather than average, because that is the price a customer compares
 * us to. Out of stock is excluded for the same reason — an unbuyable price is
 * not a competitive position, it is a listing.
 */
const BEST_PER_PRODUCT = `
  WITH latest AS (
    SELECT DISTINCT ON (po.product_id, po.competitor_id)
           po.product_id, po.competitor_id, po.price, po.in_stock, po.promo
    FROM price_observations po
    ORDER BY po.product_id, po.competitor_id, po.observed_at DESC
  ),
  pairs AS (
    SELECT p.id AS product_id,
           p.internal_sku,
           nullif(btrim(p.brand), '')    AS brand,
           nullif(btrim(p.category), '') AS category,
           fp.price AS our_price,
           fp.on_sale IS TRUE AS ours_promotional,
           l.competitor_id,
           l.price  AS their_price,
           l.promo IS TRUE AS theirs_promotional
    FROM products p
    JOIN fascia_prices fp ON fp.product_id = p.id AND fp.fascia_id = $1
    JOIN latest l ON l.product_id = p.id
    WHERE p.delisted_at IS NULL
      AND fp.price IS NOT NULL
      AND l.price IS NOT NULL
      AND l.in_stock IS DISTINCT FROM FALSE
  ),
  best AS (
    SELECT DISTINCT ON (product_id) *
    FROM pairs
    ORDER BY product_id, their_price ASC
  )
`;

/** The aggregate columns, shared by every breakdown so they cannot drift. */
const AGGREGATES = `
  count(*)                                              AS compared,
  count(*) FILTER (WHERE our_price < their_price - 0.005) AS lower,
  count(*) FILTER (WHERE abs(our_price - their_price) <= 0.005) AS equal,
  count(*) FILTER (WHERE our_price > their_price + 0.005) AS higher,
  percentile_cont(0.5) WITHIN GROUP (ORDER BY our_price - their_price) AS median_gap_abs,
  percentile_cont(0.5) WITHIN GROUP (
    ORDER BY ((our_price - their_price) / nullif(our_price, 0)) * 100
  )                                                     AS median_gap_pct,
  max(our_price - their_price)                          AS worst_gap_abs,
  (array_agg(internal_sku ORDER BY our_price - their_price DESC))[1] AS worst_gap_sku
`;

export async function getPositionAnalysis(fasciaId: number): Promise<PositionAnalysis> {
  const { rows: fasciaRows } = await query<{ id: number; code: string; name: string }>(
    'SELECT id, code, name FROM fascias WHERE id = $1',
    [fasciaId],
  );

  const { rows: overallRows } = await query<BreakdownRow>(
    `${BEST_PER_PRODUCT} SELECT 'All products' AS key, ${AGGREGATES} FROM best`,
    [fasciaId],
  );

  const { rows: brandRows } = await query<BreakdownRow>(
    `${BEST_PER_PRODUCT}
     SELECT brand AS key, ${AGGREGATES} FROM best GROUP BY brand ORDER BY count(*) DESC`,
    [fasciaId],
  );

  const { rows: categoryRows } = await query<BreakdownRow>(
    `${BEST_PER_PRODUCT}
     SELECT category AS key, ${AGGREGATES} FROM best GROUP BY category ORDER BY count(*) DESC`,
    [fasciaId],
  );

  // Per competitor uses every pair, not the cheapest-only set: the question
  // here is "how does this retailer price against us across their range",
  // which the cheapest-wins filter would answer only for the ones they win.
  const { rows: competitorRows } = await query<BreakdownRow>(
    `${BEST_PER_PRODUCT}
     SELECT c.display_name AS key, ${AGGREGATES}
     FROM pairs
     JOIN competitors c ON c.id = pairs.competitor_id
     GROUP BY c.display_name
     ORDER BY count(*) DESC`,
    [fasciaId],
  );

  // Products we price but nobody has a price for — the blind spot behind every
  // percentage above, and the reason coverage is reported alongside position.
  const { rows: uncoveredRows } = await query<{ uncovered: string }>(
    `SELECT count(*)::text AS uncovered
     FROM products p
     JOIN fascia_prices fp ON fp.product_id = p.id AND fp.fascia_id = $1
     WHERE p.delisted_at IS NULL
       AND fp.price IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM price_observations po
         WHERE po.product_id = p.id AND po.price IS NOT NULL
       )`,
    [fasciaId],
  );

  return {
    fascia: fasciaRows[0] ?? null,
    generatedAt: new Date().toISOString(),
    overall: toBreakdown(overallRows[0] ?? ({ key: 'All products', compared: 0, lower: 0, equal: 0, higher: 0, median_gap_abs: null, median_gap_pct: null, worst_gap_abs: null, worst_gap_sku: null } as BreakdownRow)),
    byBrand: brandRows.map((row) => toBreakdown(row, 'Unspecified brand')),
    byCategory: categoryRows.map((row) => toBreakdown(row, 'Uncategorised')),
    byCompetitor: competitorRows.map((row) => toBreakdown(row)),
    trend: await getPositionTrend(fasciaId),
    byBasis: await getBasisSplit(fasciaId),
    uncovered: Number(uncoveredRows[0]?.uncovered ?? 0),
  };
}

/**
 * The position split four ways by who was on promotion.
 *
 * Uses the same cheapest-in-stock base as everything else, so the four rows
 * sum to the overall figure rather than describing a different population.
 */
async function getBasisSplit(fasciaId: number): Promise<BasisSplit[]> {
  const { rows } = await query<{
    basis: BasisSplit['basis'];
    compared: string;
    lower: string;
    equal: string;
    higher: string;
  }>(
    `${BEST_PER_PRODUCT}
     SELECT CASE
              WHEN ours_promotional AND theirs_promotional THEN 'both_promotional'
              WHEN ours_promotional                        THEN 'ours_promotional'
              WHEN theirs_promotional                      THEN 'theirs_promotional'
              ELSE 'like_for_like'
            END AS basis,
            count(*)::text AS compared,
            count(*) FILTER (WHERE our_price < their_price - 0.005)::text AS lower,
            count(*) FILTER (WHERE abs(our_price - their_price) <= 0.005)::text AS equal,
            count(*) FILTER (WHERE our_price > their_price + 0.005)::text AS higher
     FROM best
     GROUP BY 1`,
    [fasciaId],
  );

  return rows.map((row) => {
    const compared = Number(row.compared);
    const higher = Number(row.higher);
    return {
      basis: row.basis,
      compared,
      lower: Number(row.lower),
      equal: Number(row.equal),
      higher,
      higherPct: compared === 0 ? 0 : Math.round((higher / compared) * 1000) / 10,
    };
  });
}

/**
 * How our position has moved, week by week.
 *
 * Reconstructed rather than stored: for each week, each competitor's price is
 * the last one observed on or before that week, and our price is the last one
 * recorded in `fascia_price_history` on or before it, falling back to what we
 * charge now for products whose price has not changed since history began.
 *
 * That fallback is the honest weak point. Our own price history only starts
 * from when the trigger was added, so early weeks assume our current price
 * applied then. It is right for the great majority of products — most prices
 * do not move week to week — but it means the earliest points understate how
 * much *our* side of the gap was moving. The UI says so rather than drawing a
 * confident line over it.
 */
async function getPositionTrend(fasciaId: number, weeks = 12): Promise<PositionTrendPoint[]> {
  const { rows } = await query<{
    week_start: string;
    compared: string;
    lower: string;
    equal: string;
    higher: string;
  }>(
    `WITH weeks AS (
       SELECT generate_series(
         date_trunc('week', now()) - ($2::int - 1) * interval '1 week',
         date_trunc('week', now()),
         interval '1 week'
       ) AS week_start
     ),
     priced AS (
       SELECT p.id AS product_id, fp.price AS current_price
       FROM products p
       JOIN fascia_prices fp ON fp.product_id = p.id AND fp.fascia_id = $1
       WHERE p.delisted_at IS NULL AND fp.price IS NOT NULL
     ),
     snapshots AS (
       SELECT w.week_start,
              pr.product_id,
              COALESCE(
                (SELECT h.price FROM fascia_price_history h
                  WHERE h.product_id = pr.product_id AND h.fascia_id = $1
                    AND h.recorded_at <= w.week_start + interval '1 week'
                  ORDER BY h.recorded_at DESC LIMIT 1),
                pr.current_price
              ) AS our_price,
              (SELECT min(x.price) FROM (
                 SELECT DISTINCT ON (po.competitor_id) po.price
                 FROM price_observations po
                 WHERE po.product_id = pr.product_id
                   AND po.observed_at <= w.week_start + interval '1 week'
                   AND po.price IS NOT NULL
                   AND po.in_stock IS DISTINCT FROM FALSE
                 ORDER BY po.competitor_id, po.observed_at DESC
               ) x) AS their_price
       FROM weeks w
       CROSS JOIN priced pr
     )
     SELECT to_char(week_start, 'YYYY-MM-DD') AS week_start,
            count(*)::text AS compared,
            count(*) FILTER (WHERE our_price < their_price - 0.005)::text AS lower,
            count(*) FILTER (WHERE abs(our_price - their_price) <= 0.005)::text AS equal,
            count(*) FILTER (WHERE our_price > their_price + 0.005)::text AS higher
     FROM snapshots
     WHERE their_price IS NOT NULL AND our_price IS NOT NULL
     GROUP BY week_start
     ORDER BY week_start`,
    [fasciaId, weeks],
  );

  return rows.map((row) => {
    const compared = Number(row.compared);
    const higher = Number(row.higher);
    return {
      weekStart: row.week_start,
      compared,
      lower: Number(row.lower),
      equal: Number(row.equal),
      higher,
      higherPct: compared === 0 ? 0 : Math.round((higher / compared) * 1000) / 10,
    };
  });
}
