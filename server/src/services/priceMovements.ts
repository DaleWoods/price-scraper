import { query } from '../db/pool.js';

/**
 * What moved, and what it did to our position.
 *
 * A comparison tells you where you stand today. This tells you what changed
 * to put you there, which is the question someone actually acts on: a
 * competitor cutting a price, or us raising one, are the same gap arrived at
 * from opposite directions and they call for different responses.
 *
 * Both sides are reported. Competitor prices come from `price_observations`;
 * ours come from `fascia_price_history`, which exists for exactly this reason
 * — without it the report could only ever say "they changed", never "we did".
 */

export type MovementSide = 'competitor' | 'ours';

export interface PriceMovement {
  side: MovementSide;
  productId: number;
  internalSku: string;
  productName: string;
  brand: string;
  /** Null for one of ours. */
  competitorId: number | null;
  competitorName: string | null;
  competitorSlug: string | null;
  competitorHasLogo: boolean;
  previousPrice: number | null;
  price: number | null;
  /** price − previousPrice. Negative is a cut. */
  deltaAbs: number | null;
  deltaPct: number | null;
  changedAt: string;
  /** Our price at the selected site, as it stands now. */
  ourPrice: number | null;
  /** Where we sit against this competitor now: lower / equal / higher. */
  position: 'lower' | 'equal' | 'higher' | null;
  currency: string;
}

export interface MovementSummary {
  competitorChanges: number;
  competitorCuts: number;
  competitorRises: number;
  ourChanges: number;
  /** Movements that left a competitor cheaper than us where they were not. */
  newlyUndercut: number;
  /** Movements that ended an undercut. */
  undercutResolved: number;
  productsAffected: number;
}

export interface MovementReport {
  windowDays: number;
  fascia: { id: number; code: string; name: string } | null;
  generatedAt: string;
  summary: MovementSummary;
  movements: PriceMovement[];
  /** True when more exist than were returned. */
  truncated: boolean;
}

const num = (value: string | number | null | undefined): number | null =>
  value == null ? null : Number(value);

/** Keeps one enormous overnight move from returning the whole catalogue. */
const MAX_MOVEMENTS = 2000;

function position(ourPrice: number | null, theirPrice: number | null): PriceMovement['position'] {
  if (ourPrice == null || theirPrice == null) return null;
  if (Math.abs(ourPrice - theirPrice) < 0.005) return 'equal';
  return ourPrice < theirPrice ? 'lower' : 'higher';
}

interface MovementRow {
  product_id: number;
  internal_sku: string;
  product_name: string;
  brand: string;
  competitor_id: number | null;
  competitor_name: string | null;
  competitor_slug: string | null;
  competitor_has_logo: boolean | null;
  previous_price: string | null;
  price: string | null;
  changed_at: string;
  our_price: string | null;
  currency: string | null;
}

/**
 * Movements within a window, newest first.
 *
 * `fasciaId` decides which of our prices every comparison is measured against.
 * It is required rather than optional because "our price" is meaningless
 * without naming a site — the same watch is a different price at Goldsmiths
 * and at Mappin & Webb.
 */
export async function getPriceMovements(options: {
  fasciaId: number;
  days?: number;
  side?: MovementSide | 'all';
  /** Only movements that left a competitor cheaper than us. */
  undercutsOnly?: boolean;
}): Promise<MovementReport> {
  const days = options.days ?? 1;
  const side = options.side ?? 'all';

  const { rows: fasciaRows } = await query<{ id: number; code: string; name: string }>(
    'SELECT id, code, name FROM fascias WHERE id = $1',
    [options.fasciaId],
  );
  const fascia = fasciaRows[0] ?? null;

  const competitorRows =
    side === 'ours'
      ? []
      : (
          await query<MovementRow>(
            // lag() runs over the whole series, not just the window, so a
            // change whose previous observation falls just outside the window
            // is still reported rather than silently read as a first sighting.
            // The (product, competitor, observed_at) index covers this.
            `WITH ranked AS (
               SELECT po.product_id,
                      po.competitor_id,
                      po.price,
                      po.observed_at,
                      lag(po.price)      OVER w AS previous_price,
                      lag(po.observed_at) OVER w AS previous_observed_at
               FROM price_observations po
               WINDOW w AS (PARTITION BY po.product_id, po.competitor_id ORDER BY po.observed_at)
             )
             SELECT r.product_id,
                    p.internal_sku,
                    p.product_name,
                    p.brand,
                    r.competitor_id,
                    c.display_name AS competitor_name,
                    c.slug         AS competitor_slug,
                    (c.logo_data IS NOT NULL) AS competitor_has_logo,
                    r.previous_price,
                    r.price,
                    r.observed_at  AS changed_at,
                    fp.price       AS our_price,
                    fp.currency
             FROM ranked r
             JOIN products p ON p.id = r.product_id
             JOIN competitors c ON c.id = r.competitor_id
             LEFT JOIN fascia_prices fp
               ON fp.product_id = r.product_id AND fp.fascia_id = $2
             WHERE r.observed_at >= now() - ($1::int * interval '1 day')
               AND r.previous_price IS NOT NULL
               AND r.price IS DISTINCT FROM r.previous_price
               -- A delisted product is no longer ours to compare.
               AND p.delisted_at IS NULL
             ORDER BY r.observed_at DESC
             LIMIT ${MAX_MOVEMENTS + 1}`,
            [days, options.fasciaId],
          )
        ).rows;

  const ourRows =
    side === 'competitor'
      ? []
      : (
          await query<MovementRow>(
            `SELECT h.product_id,
                    p.internal_sku,
                    p.product_name,
                    p.brand,
                    NULL::bigint AS competitor_id,
                    NULL::text   AS competitor_name,
                    NULL::text   AS competitor_slug,
                    FALSE        AS competitor_has_logo,
                    h.previous_price,
                    h.price,
                    h.recorded_at AS changed_at,
                    h.price       AS our_price,
                    fp.currency
             FROM fascia_price_history h
             JOIN products p ON p.id = h.product_id
             LEFT JOIN fascia_prices fp
               ON fp.product_id = h.product_id AND fp.fascia_id = h.fascia_id
             WHERE h.fascia_id = $2
               AND h.recorded_at >= now() - ($1::int * interval '1 day')
               -- previous_price NULL is the baseline row written when we first
               -- held a price, not a change worth reporting.
               AND h.previous_price IS NOT NULL
               AND p.delisted_at IS NULL
             ORDER BY h.recorded_at DESC
             LIMIT ${MAX_MOVEMENTS + 1}`,
            [days, options.fasciaId],
          )
        ).rows;

  const toMovement = (row: MovementRow, movementSide: MovementSide): PriceMovement => {
    const price = num(row.price);
    const previousPrice = num(row.previous_price);
    const ourPrice = num(row.our_price);
    const deltaAbs = price != null && previousPrice != null ? price - previousPrice : null;

    return {
      side: movementSide,
      productId: row.product_id,
      internalSku: row.internal_sku,
      productName: row.product_name,
      brand: row.brand,
      competitorId: row.competitor_id,
      competitorName: row.competitor_name,
      competitorSlug: row.competitor_slug,
      competitorHasLogo: row.competitor_has_logo ?? false,
      previousPrice,
      price,
      deltaAbs,
      deltaPct:
        deltaAbs != null && previousPrice != null && previousPrice !== 0
          ? Math.round((deltaAbs / previousPrice) * 1000) / 10
          : null,
      changedAt: new Date(row.changed_at).toISOString(),
      ourPrice,
      // Only a competitor movement has a position: it is where we sit against
      // *them*. One of our own price changes moves us against every competitor
      // at once, so there is no single comparison to report here.
      position: movementSide === 'competitor' ? position(ourPrice, price) : null,
      currency: row.currency ?? 'GBP',
    };
  };

  let movements = [
    ...competitorRows.map((row) => toMovement(row, 'competitor')),
    ...ourRows.map((row) => toMovement(row, 'ours')),
  ].sort((a, b) => b.changedAt.localeCompare(a.changedAt));

  // Summarised before paging, so the headline counts describe everything that
  // happened rather than the first screenful of it.
  const summary = summarise(movements);

  if (options.undercutsOnly) {
    movements = movements.filter((movement) => movement.position === 'higher');
  }

  const truncated = movements.length > MAX_MOVEMENTS;

  return {
    windowDays: days,
    fascia,
    generatedAt: new Date().toISOString(),
    summary,
    movements: movements.slice(0, MAX_MOVEMENTS),
    truncated,
  };
}

function summarise(movements: PriceMovement[]): MovementSummary {
  const competitor = movements.filter((movement) => movement.side === 'competitor');

  return {
    competitorChanges: competitor.length,
    competitorCuts: competitor.filter((movement) => (movement.deltaAbs ?? 0) < 0).length,
    competitorRises: competitor.filter((movement) => (movement.deltaAbs ?? 0) > 0).length,
    ourChanges: movements.filter((movement) => movement.side === 'ours').length,
    // Where they are cheaper than us now and their previous price was not.
    newlyUndercut: competitor.filter(
      (movement) =>
        movement.ourPrice != null &&
        movement.price != null &&
        movement.price < movement.ourPrice &&
        (movement.previousPrice == null || movement.previousPrice >= movement.ourPrice),
    ).length,
    undercutResolved: competitor.filter(
      (movement) =>
        movement.ourPrice != null &&
        movement.price != null &&
        movement.previousPrice != null &&
        movement.previousPrice < movement.ourPrice &&
        movement.price >= movement.ourPrice,
    ).length,
    productsAffected: new Set(movements.map((movement) => movement.productId)).size,
  };
}
