import { query } from '../db/pool.js';
import { logger } from '../lib/logger.js';
import { skusForReference } from '../ownSite/ownIndex.js';
import { readOwnProductBySku } from '../ownSite/readOwnProduct.js';
import { startRun } from '../scraping/runner.js';
import { getLookup, LookupError, saveOwnProduct, type LookupResult } from './lookup.js';
import { resolveProducts } from './productLookup.js';
import { looksLikeBinary } from './listFile.js';

/**
 * Checking a list of products at once: an uploaded file of SKUs, references
 * or barcodes, in any mix.
 *
 * Each value is matched to one of our products. Products we already hold
 * (from a feed, or checked before) are found in the database at once; any
 * others are read from our own website, which is a request each, so the whole
 * thing runs in the background and the page follows it. Then one competitor
 * check runs for the lot.
 */

/** Most values one upload may hold. A whole site's range belongs in the feed. */
export const MAX_BATCH = 5000;

/** Most products read from our own website for one upload. */
const MAX_OWN_READS = 1000;

export async function startBatch(values: string[], fileName: string | null): Promise<{ batchId: number }> {
  if (looksLikeBinary(values)) {
    throw new LookupError(
      "That file couldn't be read as a list. If it's a spreadsheet, save it as .xlsx or .csv and choose it again.",
    );
  }
  // A SKU, reference or barcode is short; anything long is a sentence or a
  // stray cell, not something to look up.
  const cleaned = [...new Set(values.map((value) => value.trim()).filter((value) => value && value.length <= 64))];
  if (cleaned.length === 0) throw new LookupError('That file has no SKUs, references or barcodes in it.');
  if (cleaned.length > MAX_BATCH) {
    throw new LookupError(
      `That file has ${cleaned.length.toLocaleString('en-GB')} values; the most one upload can check is ` +
        `${MAX_BATCH.toLocaleString('en-GB')}. Everything we sell is already checked every night from the Google feeds.`,
    );
  }

  const { rows } = await query<{ id: number }>(
    `INSERT INTO lookup_batches (file_name, input_values) VALUES ($1, $2) RETURNING id`,
    [fileName, cleaned],
  );
  const batchId = Number(rows[0]!.id);

  void processBatch(batchId, cleaned).catch(async (err) => {
    logger.error('lookup', `batch ${batchId} failed: ${(err as Error).message}`, err);
    await query(`UPDATE lookup_batches SET status = 'failed', message = $2 WHERE id = $1`, [
      batchId,
      (err as Error).message,
    ]).catch(() => undefined);
  });
  return { batchId };
}

async function processBatch(batchId: number, values: string[]): Promise<void> {
  // Everything we already hold, in one query for the whole list.
  const productIds = new Set<number>();
  const { productIds: held, unresolved: notHeld } = await resolveProducts(values);
  held.forEach((id) => productIds.add(id));
  await query(`UPDATE lookup_batches SET processed = $2 WHERE id = $1`, [batchId, values.length - notHeld.length]);

  // The rest from our own website: a SKU directly, a reference through the
  // index of our product addresses. A barcode cannot be found that way — our
  // site does not show barcodes — so it is reported as not found.
  const unresolved: string[] = [];
  let reads = 0;
  for (const [index, value] of notHeld.entries()) {
    let found = false;
    const isBarcode = /^[0-9]{12,14}$/.test(value.replace(/[\s-]/g, ''));
    if (!isBarcode && reads < MAX_OWN_READS) {
      try {
        const skus = /^[0-9]{6,10}$/.test(value)
          ? [{ sku: value, fasciaCode: null as string | null }]
          : await skusForReference(value);
        for (const hit of skus) {
          reads += 1;
          const own = await readOwnProductBySku(hit.sku, hit.fasciaCode);
          if (own) {
            productIds.add(await saveOwnProduct(own, null));
            found = true;
            break;
          }
        }
      } catch (err) {
        logger.warn('lookup', `batch ${batchId}: could not read ${value} from our site: ${(err as Error).message}`);
      }
    }
    if (!found) unresolved.push(value);
    // After every value: each one here is a page read from our own site, a
    // second or two apiece, so the progress bar moves with each.
    await query(`UPDATE lookup_batches SET processed = $2 WHERE id = $1`, [
      batchId,
      values.length - notHeld.length + index + 1,
    ]);
  }

  const ids = [...productIds];
  await query(
    `UPDATE lookup_batches SET processed = $2, product_ids = $3, unresolved = $4 WHERE id = $1`,
    [batchId, values.length, ids, unresolved],
  );
  if (ids.length === 0) {
    await query(
      `UPDATE lookup_batches SET status = 'done', message = 'None of the values matched a product we sell.' WHERE id = $1`,
      [batchId],
    );
    return;
  }

  // A product no longer in a feed may still be listed on our site; checking
  // it means it is live again for the runner's purposes.
  await query(`UPDATE products SET delisted_at = NULL WHERE id = ANY($1::bigint[])`, [ids]);
  const run = await startRun({ mode: 'both', productIds: ids, trigger: 'list', exclusive: false });
  await query(`UPDATE lookup_batches SET status = 'checking', run_id = $2 WHERE id = $1`, [batchId, run.id]);
}

export interface BatchResult {
  id: number;
  fileName: string | null;
  status: 'finding' | 'checking' | 'done' | 'failed';
  total: number;
  processed: number;
  unresolved: string[];
  message: string | null;
  createdAt: string;
  /** The check this list is being checked by, for its progress bar. */
  runId: number | null;
  products: LookupResult[];
}

/**
 * Pick up lists the app was working on when it last stopped.
 *
 * Nothing about a list's check survives a restart in memory — a deploy, or
 * the free hosting plan putting the app to sleep — so a list caught part-way
 * would sit at "Finding our products" or "Checking" for ever. At start-up, a
 * list still finding its products starts again, and one whose check was cut
 * off is checked again. A check is harmless to repeat.
 */
export async function resumeBatches(): Promise<void> {
  const { rows: unfinished } = await query<{ id: number; status: string; input_values: string[]; product_ids: string[] }>(
    `SELECT id, status, input_values, product_ids FROM lookup_batches
     WHERE status IN ('finding', 'checking') AND created_at > now() - interval '2 days'
     ORDER BY id DESC`,
  );
  // Only the newest. Uploading the same file again after a restart left
  // several unfinished lists, and resuming them all ran the same check
  // several times side by side — twice the work on a small server for one
  // answer. The older ones are closed; what they found is kept and shows in
  // the newest list and on All products.
  const rows = unfinished.slice(0, 1);
  if (unfinished.length > 1) {
    await query(
      `UPDATE lookup_batches SET status = 'failed',
              message = 'Stopped when the app restarted. A newer list was picked up instead.'
       WHERE id = ANY($1::bigint[])`,
      [unfinished.slice(1).map((batch) => Number(batch.id))],
    );
  }
  for (const batch of rows) {
    const batchId = Number(batch.id);
    logger.info('lookup', `resuming list ${batchId} (${batch.status}) after a restart`);
    if (batch.status === 'finding' || batch.product_ids.length === 0) {
      void processBatch(batchId, batch.input_values).catch((err) =>
        logger.error('lookup', `resumed list ${batchId} failed: ${(err as Error).message}`),
      );
    } else {
      const ids = batch.product_ids.map(Number);
      void startRun({ mode: 'both', productIds: ids, trigger: 'list', exclusive: false })
        .then((run) => query(`UPDATE lookup_batches SET run_id = $2 WHERE id = $1`, [batchId, run.id]))
        .catch((err) => logger.error('lookup', `resumed list ${batchId} failed: ${(err as Error).message}`));
    }
  }
}

export async function getBatch(batchId: number): Promise<BatchResult | null> {
  const { rows } = await query<{
    id: number;
    file_name: string | null;
    status: BatchResult['status'];
    input_values: string[];
    processed: number;
    product_ids: string[];
    unresolved: string[];
    run_id: number | null;
    message: string | null;
    created_at: string;
  }>('SELECT * FROM lookup_batches WHERE id = $1', [batchId]);
  const batch = rows[0];
  if (!batch) return null;

  let status = batch.status;
  if (status === 'checking' && batch.run_id != null) {
    const { rows: runs } = await query<{ status: string }>('SELECT status FROM scrape_runs WHERE id = $1', [
      batch.run_id,
    ]);
    if (runs[0] && runs[0].status !== 'running') {
      status = 'done';
      await query(`UPDATE lookup_batches SET status = 'done' WHERE id = $1`, [batchId]);
    }
  }

  const products: LookupResult[] = [];
  for (const id of batch.product_ids.map(Number)) {
    const result = await getLookup(id, batch.run_id);
    if (result) products.push(result);
  }

  return {
    id: Number(batch.id),
    fileName: batch.file_name,
    status,
    total: batch.input_values.length,
    processed: batch.processed,
    unresolved: batch.unresolved,
    message: batch.message,
    createdAt: batch.created_at,
    runId: batch.run_id != null ? Number(batch.run_id) : null,
    products,
  };
}

export async function recentBatches(): Promise<
  { id: number; fileName: string | null; status: string; total: number; products: number; createdAt: string }[]
> {
  const { rows } = await query<{
    id: number;
    file_name: string | null;
    status: string;
    total: number;
    products: number;
    created_at: string;
  }>(
    `SELECT id, file_name, status, cardinality(input_values) AS total,
            cardinality(product_ids) AS products, created_at
     FROM lookup_batches ORDER BY id DESC LIMIT 8`,
  );
  return rows.map((row) => ({
    id: Number(row.id),
    fileName: row.file_name,
    status: row.status,
    total: row.total,
    products: row.products,
    createdAt: row.created_at,
  }));
}
