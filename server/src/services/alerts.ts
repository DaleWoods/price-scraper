import { query } from '../db/pool.js';
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

  for (const fp of fasciaPrices) {
    const undercut = competitorPrice != null && classifyPosition(fp.price, competitorPrice) === 'higher';

    if (undercut) {
      await raiseAlert(productId, competitorId, fp.fascia_id, fp.price, competitorPrice!);
    } else {
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
     WHERE type = 'undercut' AND product_id = $1 AND state = 'open'`,
    [productId],
  );
}

/** Resolve every open alert — the counterpart to clearing every comparison. */
export async function resolveAllOpenAlerts(): Promise<number> {
  const { rowCount } = await query(
    `UPDATE alerts SET state = 'resolved', resolved_at = now() WHERE type = 'undercut' AND state = 'open'`,
  );
  return rowCount ?? 0;
}
