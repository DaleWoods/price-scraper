import { withTransaction } from '../db/pool.js';

export interface StartAfreshResult {
  pricesRemoved: number;
  matchesRemoved: number;
  alertsRemoved: number;
  runsRemoved: number;
  listsRemoved: number;
  productsReset: number;
}

/**
 * Clear every result of every check, so the next one starts from nothing.
 *
 * Removed: every competitor price recorded, every match between our products
 * and theirs, every alert, every run and its log, every list checked, and the
 * "checked" and "recently checked" marks on our products.
 *
 * Kept, because none of it is a result: our products and our own prices (they
 * come from the feeds), the competitors and their logos, the settings, and
 * each competitor's catalogue as read so far. The catalogue is the list of
 * their product pages; keeping it means the next full check does not spend
 * hours re-reading pages it already has, and no price is ever taken from it
 * unless the page was read again during that check.
 *
 * One transaction: all of it goes, or none of it.
 */
export async function startAfresh(): Promise<StartAfreshResult> {
  return withTransaction(async (client) => {
    const prices = await client.query('DELETE FROM price_observations');
    const alerts = await client.query('DELETE FROM alerts');
    const matches = await client.query('DELETE FROM product_matches');
    // Run items first: a run's log is removed with it either way, but naming
    // them keeps this correct if that link ever changes.
    await client.query('DELETE FROM scrape_run_items');
    const runs = await client.query(`DELETE FROM scrape_runs WHERE status <> 'running'`);
    const lists = await client.query('DELETE FROM lookup_batches');
    const products = await client.query(
      `UPDATE products SET looked_up_at = NULL, compared_at = NULL
       WHERE looked_up_at IS NOT NULL OR compared_at IS NOT NULL`,
    );
    return {
      pricesRemoved: prices.rowCount ?? 0,
      matchesRemoved: matches.rowCount ?? 0,
      alertsRemoved: alerts.rowCount ?? 0,
      runsRemoved: runs.rowCount ?? 0,
      listsRemoved: lists.rowCount ?? 0,
      productsReset: products.rowCount ?? 0,
    };
  });
}
