import { query } from '../db/pool.js';
import { logger } from '../lib/logger.js';
import { getAlertSettings } from './alertSettings.js';
import { classifyPosition, priceDelta } from './comparison.js';

/**
 * Undercut alerts (the `alerts` table has existed since the first migration;
 * nothing has ever written to it until now).
 *
 * Called once per price observation, right after it is written. A price is
 * only ever "cheaper" or "dearer" relative to one of our fascias — the same
 * product costs different amounts at Goldsmiths, Mappin & Webb and Watches of
 * Switzerland — so one competitor observation is checked against every fascia
 * that prices the product, and can raise an alert for some and not others.
 *
 * Thresholds (Spec §5.5) gate whether an undercut is worth telling anyone
 * about. Both default to zero, so out of the box every undercut still alerts.
 */
export async function syncUndercutAlerts(
  productId: number,
  competitorId: number,
  competitorPrice: number | null,
): Promise<void> {
  const { rows: fasciaPrices } = await query<{ fascia_id: number; price: number }>(
    'SELECT fascia_id, price FROM fascia_prices WHERE product_id = $1',
    [productId],
  );
  if (fasciaPrices.length === 0) return;

  const settings = await getAlertSettings();

  for (const fp of fasciaPrices) {
    const cheaper =
      competitorPrice != null && classifyPosition(fp.price, competitorPrice) === 'higher';

    // Both thresholds must be met, and both default to 0 so the default is
    // "alert on anything". Setting only one therefore applies only that one.
    let worthRaising = false;
    if (cheaper) {
      const { deltaAbs, deltaPct } = priceDelta(fp.price, competitorPrice!);
      worthRaising = deltaPct >= settings.undercutMinPct && deltaAbs >= settings.undercutMinAbs;
    }

    if (worthRaising) {
      await raiseAlert(productId, competitorId, fp.fascia_id, fp.price, competitorPrice!);
    } else {
      // Also covers "still cheaper, but no longer past the threshold": raising
      // the bar should quietly resolve alerts that no longer qualify rather
      // than strand them open with nothing to act on.
      await resolveAlert(productId, competitorId, fp.fascia_id);
    }
  }
}

async function raiseAlert(
  productId: number,
  competitorId: number,
  fasciaId: number,
  ourPrice: number,
  competitorPrice: number,
): Promise<void> {
  const { deltaAbs, deltaPct } = priceDelta(ourPrice, competitorPrice);

  const { rows } = await query<{ internal_sku: string; product_name: string }>(
    'SELECT internal_sku, product_name FROM products WHERE id = $1',
    [productId],
  );
  const product = rows[0];
  if (!product) return;

  const { rows: competitorRows } = await query<{ display_name: string }>(
    'SELECT display_name FROM competitors WHERE id = $1',
    [competitorId],
  );
  const { rows: fasciaRows } = await query<{ name: string }>(
    'SELECT name FROM fascias WHERE id = $1',
    [fasciaId],
  );
  const competitorName = competitorRows[0]?.display_name ?? 'A competitor';
  const fasciaName = fasciaRows[0]?.name ?? 'our site';

  const message =
    `${competitorName} is £${deltaAbs.toFixed(2)} (${deltaPct.toFixed(1)}%) cheaper than our ` +
    `${fasciaName} price for ${product.product_name} (${product.internal_sku}).`;

  // ON CONFLICT targets the partial unique index on open rows: a still-cheaper
  // price observed again is not a new event, so this is silently a no-op when
  // an open alert for this exact combination already exists.
  await query(
    `INSERT INTO alerts (type, product_id, competitor_id, fascia_id, delta_abs, delta_pct, message, state)
     VALUES ('undercut', $1, $2, $3, $4, $5, $6, 'open')
     ON CONFLICT (type, product_id, competitor_id, fascia_id) WHERE state = 'open' DO NOTHING`,
    [productId, competitorId, fasciaId, deltaAbs, deltaPct, message],
  );
}

async function resolveAlert(productId: number, competitorId: number, fasciaId: number): Promise<void> {
  await query(
    `UPDATE alerts
     SET state = 'resolved', resolved_at = now()
     WHERE type = 'undercut' AND product_id = $1 AND competitor_id = $2 AND fascia_id = $3
       AND state = 'open'`,
    [productId, competitorId, fasciaId],
  );
}

/**
 * Resolve every open alert for one product/competitor pair.
 *
 * Called when a person deletes that pair's price and match by hand — an open
 * alert claiming "still cheaper" with nothing behind it any more is worse than
 * no alert, since it can no longer be checked against anything on the page.
 */
export async function resolveAlertsForPair(productId: number, competitorId: number): Promise<void> {
  await query(
    `UPDATE alerts SET state = 'resolved', resolved_at = now()
     WHERE type = 'undercut' AND product_id = $1 AND competitor_id = $2 AND state = 'open'`,
    [productId, competitorId],
  );
}

/** Resolve every open alert for one product, regardless of competitor. */
export async function resolveAlertsForProduct(productId: number): Promise<void> {
  await query(
    `UPDATE alerts SET state = 'resolved', resolved_at = now()
     WHERE product_id = $1 AND state = 'open'`,
    [productId],
  );
}

/** Resolve every open alert — the counterpart to clearing every comparison. */
export async function resolveAllOpenAlerts(): Promise<number> {
  const { rowCount } = await query(
    `UPDATE alerts SET state = 'resolved', resolved_at = now() WHERE state = 'open'`,
  );
  return rowCount ?? 0;
}

/* ---------- price_drop ---------------------------------------------------
   Spec §5.5's second trigger: "competitor price drop / new promotion
   detected". This is about the competitor's price falling against *their own*
   previous price — nothing to do with ours.
   ------------------------------------------------------------------------ */

/**
 * Raise an alert when a competitor's price has fallen materially since we last
 * looked. Called right after the new observation is written.
 */
export async function syncPriceDropAlert(
  productId: number,
  competitorId: number,
  newPrice: number | null,
): Promise<void> {
  const settings = await getAlertSettings();
  if (!settings.priceDropEnabled || newPrice == null) return;

  // OFFSET 1 skips the observation this run has just inserted — without it we
  // would compare the new price against itself and never fire.
  const { rows } = await query<{ price: number | null }>(
    `SELECT price FROM price_observations
     WHERE product_id = $1 AND competitor_id = $2 AND price IS NOT NULL
     ORDER BY observed_at DESC
     OFFSET 1 LIMIT 1`,
    [productId, competitorId],
  );

  const previous = rows[0]?.price == null ? null : Number(rows[0].price);
  // No previous price is not a drop from zero — it is a first sighting.
  if (previous == null || previous <= 0) return;

  const dropAbs = previous - newPrice;
  if (dropAbs <= 0) return;
  const dropPct = (dropAbs / previous) * 100;
  if (dropPct < settings.priceDropMinPct) return;

  const context = await alertContext(productId, competitorId);
  if (!context) return;

  const message =
    `${context.competitorName} dropped ${context.productName} (${context.internalSku}) from ` +
    `£${previous.toFixed(2)} to £${newPrice.toFixed(2)} — down ${dropPct.toFixed(1)}%.`;

  await insertAlert({
    type: 'price_drop',
    productId,
    competitorId,
    deltaAbs: round2(dropAbs),
    deltaPct: round2(dropPct),
    message,
  });
}

/* ---------- listing_gone -------------------------------------------------
   Spec §5.5's third trigger: "a previously-matched product goes out of stock
   or the listing 404s".
   ------------------------------------------------------------------------ */

/** A confirmed match's page has 404'd, or the product is out of stock there. */
export async function raiseListingGoneAlert(
  productId: number,
  competitorId: number,
  reason: string,
): Promise<void> {
  const settings = await getAlertSettings();
  if (!settings.listingGoneEnabled) return;

  const context = await alertContext(productId, competitorId);
  if (!context) return;

  await insertAlert({
    type: 'listing_gone',
    productId,
    competitorId,
    deltaAbs: null,
    deltaPct: null,
    message:
      `${context.productName} (${context.internalSku}) is no longer buyable at ` +
      `${context.competitorName}: ${reason}.`,
  });
}

/**
 * Clear a listing_gone once the same listing scrapes successfully and is in
 * stock again. An alert that can be raised but never resolved is worse than no
 * alert at all.
 */
export async function resolveListingGone(productId: number, competitorId: number): Promise<void> {
  await query(
    `UPDATE alerts SET state = 'resolved', resolved_at = now()
     WHERE type = 'listing_gone' AND product_id = $1 AND competitor_id = $2 AND state = 'open'`,
    [productId, competitorId],
  );
}

/* ---------- shared helpers ---------------------------------------------- */

interface AlertContext {
  internalSku: string;
  productName: string;
  competitorName: string;
}

async function alertContext(
  productId: number,
  competitorId: number,
): Promise<AlertContext | null> {
  const { rows } = await query<AlertContext>(
    `SELECT p.internal_sku AS "internalSku", p.product_name AS "productName",
            c.display_name AS "competitorName"
     FROM products p, competitors c
     WHERE p.id = $1 AND c.id = $2`,
    [productId, competitorId],
  );
  return rows[0] ?? null;
}

/**
 * Insert an alert that is not tied to one of our fascias.
 *
 * The ON CONFLICT target is the *second* partial unique index
 * (alerts_open_no_fascia_idx), not the fascia one: Postgres treats NULLs as
 * distinct, so a fascia_id of NULL matches nothing in the original index and
 * every run would otherwise insert another copy of the same open alert.
 */
async function insertAlert(alert: {
  type: 'price_drop' | 'listing_gone';
  productId: number;
  competitorId: number;
  deltaAbs: number | null;
  deltaPct: number | null;
  message: string;
}): Promise<void> {
  await query(
    `INSERT INTO alerts (type, product_id, competitor_id, fascia_id, delta_abs, delta_pct, message, state)
     VALUES ($1, $2, $3, NULL, $4, $5, $6, 'open')
     ON CONFLICT (type, product_id, competitor_id)
       WHERE state = 'open' AND fascia_id IS NULL
       DO NOTHING`,
    [alert.type, alert.productId, alert.competitorId, alert.deltaAbs, alert.deltaPct, alert.message],
  );
  logger.debug('alerts', `${alert.type} considered for product ${alert.productId}`);
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
