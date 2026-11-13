import { query } from '../db/pool.js';
import { logger } from '../lib/logger.js';
import {
  raiseListingGoneAlert,
  resolveListingGone,
  syncPriceDropAlert,
  syncUndercutAlerts,
} from '../services/alerts.js';

/** The parts of a competitor listing that make up one price observation. */
export interface ObservedPrice {
  price: number | null;
  wasPrice: number | null;
  currency: string;
  promo: boolean;
  inStock: boolean | null;
  availabilityText: string | null;
}

export interface ObservationTarget {
  matchId: number;
  productId: number;
  competitorId: number;
  /** Ours, for log lines only. */
  internalSku: string;
}

/**
 * Record one competitor price against one of our products, and bring the
 * alerts that depend on it up to date.
 *
 * One function because a price can now arrive two ways — from re-reading a
 * confirmed match's page, or straight from the catalogue the moment a barcode
 * match is made — and both must leave exactly the same trail behind them.
 */
export async function recordPriceObservation(
  target: ObservationTarget,
  observed: ObservedPrice,
  context: { runId: number | null; sourceUrl: string; renderedWith: string | null },
): Promise<void> {
  await query(
    `INSERT INTO price_observations
       (product_id, competitor_id, match_id, scrape_run_id, price, was_price, currency,
        promo, in_stock, availability_text, source_url, rendered_with)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [
      target.productId,
      target.competitorId,
      target.matchId,
      context.runId,
      observed.price,
      observed.wasPrice,
      observed.currency,
      observed.promo,
      observed.inStock,
      observed.availabilityText,
      context.sourceUrl,
      // What actually produced this price, after any escalation — not what
      // the competitor is configured to prefer.
      context.renderedWith,
    ],
  );

  // A price outlives its own scrape: alert state is checked against every
  // fascia this product prices, not just recorded and left for someone to
  // notice on the comparison page.
  //
  // Every alert call is caught and logged rather than awaited bare: a failed
  // alert write must never lose a price that was read successfully. The price
  // is the valuable part.
  await syncUndercutAlerts(target.productId, target.competitorId, observed.price).catch((err) => {
    logger.warn('runner', `alert sync failed for ${target.internalSku}: ${(err as Error).message}`);
  });

  // The competitor's own price falling sharply is its own signal (Spec §5.5),
  // separate from whether it undercuts us.
  await syncPriceDropAlert(target.productId, target.competitorId, observed.price).catch((err) => {
    logger.warn('runner', `price-drop alert failed for ${target.internalSku}: ${(err as Error).message}`);
  });

  // inStock is boolean | null, and null means the page did not say — alerting
  // on unknown would fire constantly on sites that never publish availability,
  // so only an explicit false counts.
  if (observed.inStock === false) {
    await raiseListingGoneAlert(
      target.productId,
      target.competitorId,
      'it is showing as out of stock',
    ).catch((err) => {
      logger.warn('runner', `listing-gone alert failed for ${target.internalSku}: ${(err as Error).message}`);
    });
  } else {
    // Back in stock and readable again — clear any standing alert rather than
    // leaving it open with nothing behind it.
    await resolveListingGone(target.productId, target.competitorId).catch((err) => {
      logger.warn('runner', `listing-gone resolve failed for ${target.internalSku}: ${(err as Error).message}`);
    });
  }
}
