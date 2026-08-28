import { query } from '../db/pool.js';
import type { ComparisonRow, PricePosition, Product } from '../domain/types.js';

/** Treat sub-penny differences as level rather than a spurious "higher". */
const EQUALITY_EPSILON = 0.005;

export function classifyPosition(ourPrice: number, competitorPrice: number): PricePosition {
  const delta = ourPrice - competitorPrice;
  if (Math.abs(delta) < EQUALITY_EPSILON) return 'equal';
  return delta < 0 ? 'lower' : 'higher';
}

/**
 * The one place "how much cheaper/dearer" gets computed, so the Comparison
 * page and an undercut alert for the identical pair of prices always agree.
 * They used to compute this separately with different denominators —
 * comparison.ts against the competitor's price, alerts.ts against ours — so
 * the same £20-cheaper gap read as two different percentages depending on
 * which page you were looking at. Percentage is always relative to *our*
 * price: "they are 20% cheaper than us" naturally means 20% of what we
 * charge, and that is the number an undercut alert already promised.
 */
export function priceDelta(
  ourPrice: number,
  competitorPrice: number,
): { deltaAbs: number; deltaPct: number } {
  const deltaAbs = round2(ourPrice - competitorPrice);
  const deltaPct = ourPrice !== 0 ? round2((deltaAbs / ourPrice) * 100) : 0;
  return { deltaAbs, deltaPct };
}

export interface ComparisonFilters {
  /** Which of our fascias to price against. Defaults to the first enabled one. */
  fasciaCode?: string | null;
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
 * Not a page size — a hard ceiling on how many products one comparison
 * request will ever process, so a filter that happens to match everything
 * can't run away with memory. Well above any catalogue this app has ever
 * seen (three UK sites' worth of watches and jewellery); bump it if that
 * changes.
 */
const PRODUCT_SAFETY_CAP = 5000;

/**
 * Comparison view (Spec §5.5): our price vs each competitor's latest price,
 * classified lower / equal / higher with £ and % delta, plus the cheapest
 * competitor per product.
 */
export async function getComparison(filters: ComparisonFilters = {}): Promise<ComparisonPage> {
  // `limit`/`offset` page the *returned* rows only. The summary tiles and the
  // position filter both need to see every product matching brand/category/
  // search — not just whichever page happened to be requested — so the query
  // below fetches the whole filtered set (up to the safety cap) regardless,
  // and paging is applied as the very last step.
  //
  // This used to run entirely inside SQL's LIMIT/OFFSET: a catalogue larger
  // than one page had the "they are cheaper" stat tile and the position
  // filter both silently undercounting past the first page, with nothing on
  // screen to say so — exactly backwards for a comparison meant to cover the
  // whole catalogue at once.
  const pageLimit = filters.limit != null ? Math.max(filters.limit, 1) : null;
  const offset = Math.max(filters.offset ?? 0, 0);

  // Delisted products are not sold by any of our sites any more, so they are
  // excluded rather than shown permanently awaiting a price.
  const conditions: string[] = ['p.delisted_at IS NULL'];
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

  // Prices are per fascia, so which one we are comparing against decides
  // "our price" for every row on the page.
  const { rows: fasciaRows } = await query<{ id: number; code: string; name: string }>(
    `SELECT id, code, name FROM fascias
     WHERE enabled AND ($1::text IS NULL OR code = $1)
     ORDER BY code LIMIT 1`,
    [filters.fasciaCode ?? null],
  );
  const fascia = fasciaRows[0] ?? null;

  const fasciaParam = params.length + 1;
  params.push(fascia?.id ?? null);

  const { rows: products } = await query<Product & { total_count: number }>(
    `SELECT p.id, p.internal_sku, p.brand, p.product_name, p.ean_mpn, p.category,
            -- Per-fascia when we have it — the same SKU can have a different
            -- page at each of our sites — falling back to the single shared
            -- column for a product with no fascia_prices row at all.
            COALESCE(fp.product_url, p.our_product_url) AS our_product_url,
            p.specs, p.created_at, p.updated_at,
            fp.price          AS our_price,
            fp.regular_price  AS our_was_price,
            fp.on_sale        AS our_on_sale,
            COALESCE(fp.currency, p.currency) AS currency,
            count(*) OVER () AS total_count
     FROM products p
     LEFT JOIN fascia_prices fp
       ON fp.product_id = p.id AND fp.fascia_id = $${fasciaParam}
     ${where}
     ORDER BY p.brand, p.product_name
     LIMIT ${PRODUCT_SAFETY_CAP}`,
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

    // Not returned on the row — only ever used here to pick the cheapest
    // purchasable competitor. Building the full per-competitor breakdown was
    // previously serialised on every row for every product/competitor pair
    // and sent to the client, which stopped reading it once the drawer's
    // coverage table (services/comparison.ts's getProductCoverage) took over
    // showing every competitor's outcome — this is the one place it is still
    // needed, to compute a single "best" figure per row.
    const competitorPrices = productObservations.map((observation) => {
      const canCompare = ourPrice != null && observation.price != null;
      const { deltaAbs, deltaPct } = canCompare
        ? priceDelta(ourPrice, observation.price!)
        : { deltaAbs: null, deltaPct: null };
      const position = canCompare ? classifyPosition(ourPrice, observation.price!) : null;

      return {
        competitorId: observation.competitor_id,
        competitorName: observation.competitor_name,
        price: observation.price,
        inStock: observation.in_stock,
        position,
        deltaAbs,
        deltaPct,
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

  // Summary and the position filter above both already saw every matching
  // product; only the rows actually handed back are paged, right at the end.
  const paged = pageLimit != null ? filtered.slice(offset, offset + pageLimit) : filtered;

  return { rows: paged, total, summary: summarise(rows) };
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

export type CoverageStatus =
  | 'priced'
  | 'matched_awaiting_price'
  | 'pending_review'
  | 'not_listed'
  | 'not_stocked'
  | 'rejected'
  | 'error'
  | 'not_scanned';

export interface CoverageEntry {
  competitorId: number;
  competitorName: string;
  competitorSlug: string;
  competitorHasLogo: boolean;
  status: CoverageStatus;
  price: number | null;
  wasPrice: number | null;
  inStock: boolean | null;
  position: PricePosition | null;
  sourceUrl: string | null;
  observedAt: string | null;
  /** Plain-English explanation, set on every non-priced status. */
  reason: string | null;
  /** When this competitor was last actually scanned for this product, regardless of outcome. */
  lastScannedAt: string | null;
}

export interface ProductCoverage {
  competitors: CoverageEntry[];
  /** Every enabled competitor has been checked and none of them stock it. */
  notSoldAnywhere: boolean;
}

interface CoverageQueryRow {
  competitor_id: number;
  competitor_name: string;
  competitor_slug: string;
  competitor_has_logo: boolean;
  competitor_brands: string[];
  match_status: 'pending' | 'confirmed' | 'rejected' | null;
  match_url: string | null;
  obs_price: number | null;
  obs_was_price: number | null;
  obs_in_stock: boolean | null;
  obs_source_url: string | null;
  obs_observed_at: string | null;
  item_status: 'ok' | 'error' | 'skipped' | null;
  item_error_kind: string | null;
  item_error: string | null;
  item_created_at: string | null;
}

/**
 * Every enabled competitor's outcome for one product — priced, or a
 * plain-English reason it isn't. Unlike `competitorPrices` on a comparison
 * row (which only ever lists competitors a price was actually recorded for),
 * this always lists every enabled competitor, so a product genuinely absent
 * everywhere reads as that rather than an empty table.
 */
export async function getProductCoverage(
  productId: number,
  ourPrice: number | null = null,
): Promise<ProductCoverage> {
  const { rows: productRows } = await query<{ brand: string }>(
    'SELECT brand FROM products WHERE id = $1',
    [productId],
  );
  const product = productRows[0];
  if (!product) return { competitors: [], notSoldAnywhere: false };

  const { rows } = await query<CoverageQueryRow>(
    `SELECT c.id AS competitor_id, c.display_name AS competitor_name, c.slug AS competitor_slug,
            (c.logo_data IS NOT NULL) AS competitor_has_logo, c.brands AS competitor_brands,
            m.status AS match_status, m.competitor_url AS match_url,
            o.price AS obs_price, o.was_price AS obs_was_price, o.in_stock AS obs_in_stock,
            o.source_url AS obs_source_url, o.observed_at AS obs_observed_at,
            i.status AS item_status, i.error_kind AS item_error_kind, i.error AS item_error,
            i.created_at AS item_created_at
     FROM competitors c
     -- Prefer a confirmed match over a pending/rejected one if more than one exists.
     LEFT JOIN LATERAL (
       SELECT * FROM product_matches
       WHERE product_id = $1 AND competitor_id = c.id
       ORDER BY (status = 'confirmed') DESC, updated_at DESC
       LIMIT 1
     ) m ON TRUE
     LEFT JOIN LATERAL (
       SELECT * FROM price_observations
       WHERE product_id = $1 AND competitor_id = c.id
       ORDER BY observed_at DESC
       LIMIT 1
     ) o ON TRUE
     LEFT JOIN LATERAL (
       SELECT * FROM scrape_run_items
       WHERE product_id = $1 AND competitor_id = c.id
       ORDER BY created_at DESC
       LIMIT 1
     ) i ON TRUE
     WHERE c.enabled = TRUE
     ORDER BY c.display_name`,
    [productId],
  );

  const competitors: CoverageEntry[] = rows.map((row) => {
    const base = {
      competitorId: row.competitor_id,
      competitorName: row.competitor_name,
      competitorSlug: row.competitor_slug,
      competitorHasLogo: row.competitor_has_logo,
      lastScannedAt: row.item_created_at,
    };
    const notPriced = {
      price: null,
      wasPrice: null,
      inStock: null,
      position: null,
      sourceUrl: null,
      observedAt: null,
    };

    if (row.obs_price != null) {
      const canCompare = ourPrice != null;
      return {
        ...base,
        status: 'priced' as const,
        price: row.obs_price,
        wasPrice: row.obs_was_price,
        inStock: row.obs_in_stock,
        position: canCompare ? classifyPosition(ourPrice!, row.obs_price) : null,
        sourceUrl: row.obs_source_url,
        observedAt: row.obs_observed_at,
        reason: null,
      };
    }

    if (row.match_status === 'confirmed') {
      return {
        ...base,
        ...notPriced,
        sourceUrl: row.match_url,
        status: 'matched_awaiting_price' as const,
        reason: `Matched to ${row.match_url}, but not scraped for a price yet.`,
      };
    }
    if (row.match_status === 'pending') {
      return {
        ...base,
        ...notPriced,
        status: 'pending_review' as const,
        reason: 'A candidate listing was found and is waiting for review in Match review.',
      };
    }
    if (row.match_status === 'rejected') {
      return {
        ...base,
        ...notPriced,
        status: 'rejected' as const,
        reason: row.item_error ?? 'A candidate listing was found here but rejected in Match review.',
      };
    }

    // No match row of any kind — check why, most specific reason first.
    const brands = row.competitor_brands ?? [];
    if (brands.length > 0 && !brands.some((brand) => brand.toLowerCase() === product.brand.toLowerCase())) {
      return {
        ...base,
        ...notPriced,
        status: 'not_stocked' as const,
        reason: `${row.competitor_name} is not configured as stocking ${product.brand}.`,
      };
    }
    if (row.item_status === 'skipped' && row.item_error_kind === 'not_listed') {
      return {
        ...base,
        ...notPriced,
        status: 'not_listed' as const,
        reason: row.item_error ?? `${row.competitor_name} does not list this product.`,
      };
    }
    if (row.item_status === 'skipped') {
      return {
        ...base,
        ...notPriced,
        status: 'not_stocked' as const,
        reason: row.item_error,
      };
    }
    if (row.item_status === 'error') {
      return {
        ...base,
        ...notPriced,
        status: 'error' as const,
        reason: row.item_error ?? 'The last scan failed.',
      };
    }
    if (row.item_status === 'ok') {
      // Discovery ran and opened at least one candidate, but nothing cleared
      // the match confidence bar, so no product_matches row was ever stored.
      return {
        ...base,
        ...notPriced,
        status: 'rejected' as const,
        reason: row.item_error ?? 'A candidate was found but did not clear the match confidence bar.',
      };
    }

    return {
      ...base,
      ...notPriced,
      status: 'not_scanned' as const,
      reason: 'Not scanned yet — run a scan to check.',
    };
  });

  const notSoldAnywhere =
    competitors.length > 0 &&
    competitors.every(
      (entry) =>
        entry.status === 'not_listed' || entry.status === 'not_stocked' || entry.status === 'rejected',
    );

  return { competitors, notSoldAnywhere };
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
