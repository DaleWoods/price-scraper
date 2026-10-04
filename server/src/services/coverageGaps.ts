import { query } from '../db/pool.js';

/**
 * Products live on the site that nothing has compared yet.
 *
 * New lines are where pricing decisions actually get made, and they are
 * precisely the products a scan has never seen: discovery works through the
 * catalogue, so something added this morning sits behind everything added
 * before it. Until now the only way to notice was to spot a blank row in the
 * comparison among thousands of filled ones.
 *
 * "Uncovered" means we hold a price and nobody has produced one to compare it
 * to — either no match has been confirmed, or one has and no price has come
 * back from it yet. Both are gaps; they just need different fixing.
 */

export type GapReason = 'never_discovered' | 'awaiting_review' | 'matched_but_unpriced';

export interface CoverageGap {
  productId: number;
  internalSku: string;
  productName: string;
  brand: string;
  category: string | null;
  eanMpn: string | null;
  ourPrice: number | null;
  currency: string;
  /** When the product first appeared in our catalogue. */
  firstSeenAt: string;
  ageDays: number;
  reason: GapReason;
  pendingMatches: number;
}

export interface CoverageGapReport {
  fascia: { id: number; code: string; name: string } | null;
  generatedAt: string;
  /** Live, priced products with no competitor price at all. */
  total: number;
  /** Of those, the ones added within the window — the ones that matter most. */
  newlyAdded: number;
  windowDays: number;
  gaps: CoverageGap[];
}

const MAX_GAPS = 500;

interface GapRow {
  product_id: number;
  internal_sku: string;
  product_name: string;
  brand: string;
  category: string | null;
  ean_mpn: string | null;
  our_price: string | null;
  currency: string | null;
  first_seen_at: string;
  age_days: string | number;
  confirmed_matches: string | number;
  pending_matches: string | number;
}

function reasonFor(row: GapRow): GapReason {
  if (Number(row.confirmed_matches) > 0) return 'matched_but_unpriced';
  if (Number(row.pending_matches) > 0) return 'awaiting_review';
  return 'never_discovered';
}

export async function getCoverageGaps(options: {
  fasciaId: number;
  windowDays?: number;
}): Promise<CoverageGapReport> {
  const windowDays = options.windowDays ?? 14;

  const { rows: fasciaRows } = await query<{ id: number; code: string; name: string }>(
    'SELECT id, code, name FROM fascias WHERE id = $1',
    [options.fasciaId],
  );

  const { rows } = await query<GapRow>(
    `SELECT p.id AS product_id,
            p.internal_sku,
            p.product_name,
            p.brand,
            p.category,
            p.ean_mpn,
            fp.price AS our_price,
            COALESCE(fp.currency, p.currency) AS currency,
            p.created_at AS first_seen_at,
            EXTRACT(EPOCH FROM (now() - p.created_at)) / 86400 AS age_days,
            (SELECT count(*) FROM product_matches m
              WHERE m.product_id = p.id AND m.status = 'confirmed') AS confirmed_matches,
            (SELECT count(*) FROM product_matches m
              WHERE m.product_id = p.id AND m.status = 'pending') AS pending_matches
     FROM products p
     JOIN fascia_prices fp ON fp.product_id = p.id AND fp.fascia_id = $1
     WHERE p.delisted_at IS NULL
       AND fp.price IS NOT NULL
       -- No competitor price at all. A product with one is covered, however
       -- poorly; this is about the ones nothing has reached.
       AND NOT EXISTS (
         SELECT 1 FROM price_observations po
         WHERE po.product_id = p.id AND po.price IS NOT NULL
       )
     -- Newest first: a line that went live this morning is the one worth
     -- chasing, not the one that has been uncovered for a year.
     ORDER BY p.created_at DESC
     LIMIT ${MAX_GAPS + 1}`,
    [options.fasciaId],
  );

  const gaps = rows.slice(0, MAX_GAPS).map((row) => ({
    productId: row.product_id,
    internalSku: row.internal_sku,
    productName: row.product_name,
    brand: row.brand,
    category: row.category,
    eanMpn: row.ean_mpn,
    ourPrice: row.our_price == null ? null : Number(row.our_price),
    currency: row.currency ?? 'GBP',
    firstSeenAt: new Date(row.first_seen_at).toISOString(),
    ageDays: Math.floor(Number(row.age_days)),
    reason: reasonFor(row),
    pendingMatches: Number(row.pending_matches),
  }));

  return {
    fascia: fasciaRows[0] ?? null,
    generatedAt: new Date().toISOString(),
    total: rows.length,
    newlyAdded: gaps.filter((gap) => gap.ageDays <= windowDays).length,
    windowDays,
    gaps,
  };
}

/**
 * The newest uncovered products, for discovery to reach first.
 *
 * Returned oldest-created-first within the new set so a backlog drains in the
 * order it formed, rather than newest-first which would starve anything that
 * missed a run.
 */
export async function newestUncoveredProductIds(limit: number): Promise<number[]> {
  const { rows } = await query<{ id: number }>(
    `SELECT p.id
     FROM products p
     WHERE p.delisted_at IS NULL
       AND EXISTS (SELECT 1 FROM fascia_prices fp WHERE fp.product_id = p.id AND fp.price IS NOT NULL)
       AND NOT EXISTS (
         SELECT 1 FROM price_observations po WHERE po.product_id = p.id AND po.price IS NOT NULL
       )
       AND NOT EXISTS (
         SELECT 1 FROM product_matches m
         WHERE m.product_id = p.id AND m.status IN ('confirmed', 'pending')
       )
     ORDER BY p.created_at ASC
     LIMIT $1`,
    [limit],
  );
  return rows.map((row) => row.id);
}
