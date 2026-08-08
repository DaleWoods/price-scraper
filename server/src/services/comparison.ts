import { query } from '../db/pool.js';
import type { ComparisonRow, PricePosition, Product } from '../domain/types.js';

/** Treat sub-penny differences as level rather than a spurious "higher". */
const EQUALITY_EPSILON = 0.005;

export function classifyPosition(ourPrice: number, competitorPrice: number): PricePosition {
  const delta = ourPrice - competitorPrice;
  if (Math.abs(delta) < EQUALITY_EPSILON) return 'equal';
  return delta < 0 ? 'lower' : 'higher';
}

export interface ComparisonFilters {
  brand?: string | null;
  category?: string | null;
  competitorId?: number | null;
  position?: PricePosition | 'unmatched' | 'awaiting_price' | null;
  search?: string | null;
  limit?: number;
  offset?: number;
}

interface LatestObservationRow {
  product_id: number;
  competitor_id: number;
  competitor_name: string;
  competitor_slug: string;
  competitor_has_logo: boolean;
  price: number | null;
  was_price: number | null;
  promo: boolean;
  in_stock: boolean | null;
  source_url: string;
  observed_at: string;
}

interface MatchCountRow {
  product_id: number;
  confirmed: number;
  pending: number;
}

export interface ComparisonPage {
  rows: ComparisonRow[];
  total: number;
  summary: {
    products: number;
    withCompetitorPrice: number;
    lower: number;
    equal: number;
    higher: number;
    unmatched: number;
    /** Products we cannot compare because no price file has supplied ours yet. */
    awaitingOurPrice: number;
    matchCoveragePct: number;
  };
}

/**
 * Comparison view (Spec §5.5): our price vs each competitor's latest price,
 * classified lower / equal / higher with £ and % delta, plus the cheapest
 * competitor per product.
 */
export async function getComparison(filters: ComparisonFilters = {}): Promise<ComparisonPage> {
  const limit = Math.min(Math.max(filters.limit ?? 100, 1), 500);
  const offset = Math.max(filters.offset ?? 0, 0);

  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filters.brand) {
    params.push(filters.brand);
    conditions.push(`lower(p.brand) = lower($${params.length})`);
  }
  if (filters.category) {
    params.push(filters.category);
    conditions.push(`lower(coalesce(p.category, '')) = lower($${params.length})`);
  }
  if (filters.search) {
    params.push(`%${filters.search}%`);
    const index = params.length;
    conditions.push(
      `(p.product_name ILIKE $${index} OR p.internal_sku ILIKE $${index} OR p.brand ILIKE $${index} OR coalesce(p.ean_mpn, '') ILIKE $${index})`,
    );
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const { rows: products } = await query<Product & { total_count: number }>(
    `SELECT p.*, count(*) OVER () AS total_count
     FROM products p
     ${where}
     ORDER BY p.brand, p.product_name
     LIMIT ${limit} OFFSET ${offset}`,
    params,
  );

  const total = products[0]?.total_count ?? 0;
  if (products.length === 0) {
    return { rows: [], total: 0, summary: emptySummary() };
  }

  const productIds = products.map((product) => product.id);

  // Latest observation per (product, competitor).
  const { rows: observations } = await query<LatestObservationRow>(
    `SELECT DISTINCT ON (o.product_id, o.competitor_id)
            o.product_id, o.competitor_id, c.display_name AS competitor_name,
            c.slug AS competitor_slug, (c.logo_data IS NOT NULL) AS competitor_has_logo,
            o.price, o.was_price, o.promo, o.in_stock, o.source_url, o.observed_at
     FROM price_observations o
     JOIN competitors c ON c.id = o.competitor_id
     WHERE o.product_id = ANY($1::bigint[])
       AND ($2::bigint IS NULL OR o.competitor_id = $2::bigint)
     ORDER BY o.product_id, o.competitor_id, o.observed_at DESC`,
    [productIds, filters.competitorId ?? null],
  );

  const { rows: matchCounts } = await query<MatchCountRow>(
    `SELECT product_id,
            count(*) FILTER (WHERE status = 'confirmed') AS confirmed,
            count(*) FILTER (WHERE status = 'pending')   AS pending
     FROM product_matches
     WHERE product_id = ANY($1::bigint[])
     GROUP BY product_id`,
    [productIds],
  );

  const observationsByProduct = new Map<number, LatestObservationRow[]>();
  for (const observation of observations) {
    const list = observationsByProduct.get(observation.product_id) ?? [];
    list.push(observation);
    observationsByProduct.set(observation.product_id, list);
  }

  const countsByProduct = new Map(matchCounts.map((row) => [row.product_id, row]));

  const rows: ComparisonRow[] = products.map((product) => {
    const { total_count: _ignored, ...productFields } = product;
    const productObservations = observationsByProduct.get(product.id) ?? [];

    // Without a price of our own there is nothing to compare against. The
    // competitor's price is still recorded and shown; no position or delta is
    // invented for it.
    const ourPrice = product.our_price;

    const competitorPrices = productObservations.map((observation) => {
      const canCompare = ourPrice != null && observation.price != null;
      const position = canCompare ? classifyPosition(ourPrice, observation.price!) : null;
      const deltaAbs = canCompare ? round2(ourPrice - observation.price!) : null;
      const deltaPct =
        canCompare && observation.price !== 0
          ? round2(((ourPrice - observation.price!) / observation.price!) * 100)
          : null;

      return {
        competitorId: observation.competitor_id,
        competitorName: observation.competitor_name,
        competitorSlug: observation.competitor_slug,
        competitorHasLogo: observation.competitor_has_logo,
        price: observation.price,
        wasPrice: observation.was_price,
        promo: observation.promo,
        inStock: observation.in_stock,
        position,
        deltaAbs,
        deltaPct,
        sourceUrl: observation.source_url,
        observedAt: observation.observed_at,
      };
    });

    // Cheapest competitor drives the headline position. Out-of-stock listings are
    // excluded — an unbuyable price is not a competitive threat.
    const purchasable = competitorPrices.filter(
      (entry) => entry.price != null && entry.inStock !== false,
    );
    const cheapest = purchasable.reduce<(typeof purchasable)[number] | null>(
      (best, entry) => (best == null || entry.price! < best.price! ? entry : best),
      null,
    );

    const counts = countsByProduct.get(product.id);

    return {
      product: productFields as Product,
      bestCompetitorPrice: cheapest?.price ?? null,
      bestCompetitorId: cheapest?.competitorId ?? null,
      bestCompetitorName: cheapest?.competitorName ?? null,
      position: cheapest?.position ?? null,
      deltaAbs: cheapest?.deltaAbs ?? null,
      deltaPct: cheapest?.deltaPct ?? null,
      observedAt: cheapest?.observedAt ?? null,
      ourPriceMissing: ourPrice == null,
      competitorPrices,
      matchStatus: {
        confirmed: counts?.confirmed ?? 0,
        pending: counts?.pending ?? 0,
      },
    };
  });

  const filtered = filters.position
    ? rows.filter((row) => {
        if (filters.position === 'unmatched') return row.bestCompetitorPrice == null;
        if (filters.position === 'awaiting_price') return row.ourPriceMissing;
        return row.position === filters.position;
      })
    : rows;

  return { rows: filtered, total, summary: summarise(rows) };
}

function summarise(rows: ComparisonRow[]): ComparisonPage['summary'] {
  const summary = { ...emptySummary(), products: rows.length };
  for (const row of rows) {
    // A competitor price we found but cannot compare still counts as matched —
    // it is the price file that is missing, not the match.
    if (row.bestCompetitorPrice != null) summary.withCompetitorPrice += 1;
    else summary.unmatched += 1;

    if (row.ourPriceMissing) summary.awaitingOurPrice += 1;
    else if (row.position !== null) summary[row.position] += 1;
  }
  summary.matchCoveragePct =
    rows.length === 0 ? 0 : round2((summary.withCompetitorPrice / rows.length) * 100);
  return summary;
}

function emptySummary(): ComparisonPage['summary'] {
  return {
    products: 0,
    withCompetitorPrice: 0,
    lower: 0,
    equal: 0,
    higher: 0,
    unmatched: 0,
    awaitingOurPrice: 0,
    matchCoveragePct: 0,
  };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Observation history for one product, for the drill-in panel. */
export async function getProductHistory(productId: number, limit = 200) {
  const { rows } = await query(
    `SELECT o.id, o.competitor_id, c.display_name AS competitor_name, c.slug AS competitor_slug,
            (c.logo_data IS NOT NULL) AS competitor_has_logo,
            o.price, o.was_price, o.promo, o.in_stock, o.source_url, o.observed_at
     FROM price_observations o
     JOIN competitors c ON c.id = o.competitor_id
     WHERE o.product_id = $1
     ORDER BY o.observed_at DESC
     LIMIT $2`,
    [productId, Math.min(limit, 1000)],
  );
  return rows;
}
