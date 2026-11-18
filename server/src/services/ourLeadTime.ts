import { query } from '../db/pool.js';
import { logger } from '../lib/logger.js';
import { readOwnProductBySku } from '../ownSite/readOwnProduct.js';

/**
 * Our own lead times, read from our own product pages.
 *
 * The Google feeds say whether a product is in stock but not how soon it
 * arrives; the product page does ("Next Day Delivery", "1-2 Business Days").
 * Reading the page of everything we sell every night would be tens of
 * thousands of requests for a figure that only matters where there is a
 * competitor to compare with, so it is read for the products on a list, and
 * for products a competitor also sells — two pages at a time, each product at
 * most once a day.
 */
const FRESH_HOURS = 20;
const AT_ONCE = 2;

let running = false;

export interface OurLeadRefresh {
  read: number;
  failed: number;
}

/**
 * Bring our lead times up to date for these products, or — given null — for
 * every product with a confirmed competitor match. Never throws: a lead time
 * we could not read is simply left as it was.
 */
export async function refreshOurLeadTimes(
  productIds: number[] | null,
  budgetMs = 60 * 60_000,
): Promise<OurLeadRefresh> {
  const result: OurLeadRefresh = { read: 0, failed: 0 };
  // Never from the test suite: this reads our live websites.
  if (process.env.NODE_TEST_CONTEXT) return result;
  // One refresh at a time: two would only read the same pages twice.
  if (running) return result;
  running = true;
  try {
    const { rows } = await query<{ id: number; internal_sku: string }>(
      `SELECT p.id, p.internal_sku FROM products p
       WHERE (p.our_lead_at IS NULL OR p.our_lead_at < now() - make_interval(hours => $2))
         AND CASE WHEN $1::bigint[] IS NULL
               THEN p.delisted_at IS NULL AND EXISTS (
                 SELECT 1 FROM product_matches m WHERE m.product_id = p.id AND m.status = 'confirmed')
               ELSE p.id = ANY($1::bigint[]) END
       ORDER BY p.our_lead_at NULLS FIRST
       LIMIT 20000`,
      [productIds, FRESH_HOURS],
    );
    const deadline = Date.now() + budgetMs;
    let next = 0;
    const worker = async () => {
      while (next < rows.length && Date.now() < deadline) {
        const row = rows[next];
        next += 1;
        if (!row) break;
        try {
          const own = await readOwnProductBySku(row.internal_sku, '197');
          await query(
            `UPDATE products SET our_lead_text = $2, our_lead_days = $3, our_lead_at = now() WHERE id = $1`,
            [row.id, own?.leadText ?? null, own?.leadDays ?? null],
          );
          result.read += 1;
        } catch (error) {
          result.failed += 1;
          // Our own site refusing or timing out: stop asking rather than press on.
          if (result.failed >= 25 && result.failed > result.read) break;
          logger.warn('lead-time', `could not read our page for ${row.internal_sku}: ${(error as Error).message}`);
        }
      }
    };
    await Promise.all(Array.from({ length: AT_ONCE }, worker));
    if (rows.length > 0) {
      logger.info('lead-time', `our lead times: ${result.read} read, ${result.failed} failed, of ${rows.length}`);
    }
  } catch (error) {
    logger.warn('lead-time', `our lead times were not refreshed: ${(error as Error).message}`);
  } finally {
    running = false;
  }
  return result;
}
