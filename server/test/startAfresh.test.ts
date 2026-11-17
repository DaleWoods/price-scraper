import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import {
  beginRunProgress,
  finishRunProgress,
  latestRunProgress,
  updateCompetitorProgress,
} from '../src/scraping/runProgress.ts';

describe('progress of a check of every product', () => {
  it('follows each competitor from waiting, through reading, to done', () => {
    beginRunProgress(9001, [
      { slug: 'a', display_name: 'A' },
      { slug: 'b', display_name: 'B' },
    ]);
    updateCompetitorProgress(9001, 'a', { stage: 'reading', pagesTotal: 10 });
    updateCompetitorProgress(9001, 'a', (entry) => {
      entry.pagesRead += 3;
    });
    let progress = latestRunProgress()!;
    assert.equal(progress.runId, 9001);
    assert.deepEqual(
      progress.competitors.map((c) => [c.slug, c.stage, c.pagesRead, c.pagesTotal]),
      [
        ['a', 'reading', 3, 10],
        ['b', 'waiting', 0, 0],
      ],
    );
    finishRunProgress(9001);
    progress = latestRunProgress()!;
    assert.ok(progress.finishedAt);
    assert.ok(progress.competitors.every((c) => c.stage === 'done'));
  });

  it('marks what was unfinished as failed when the run fails', () => {
    beginRunProgress(9002, [{ slug: 'a', display_name: 'A' }]);
    finishRunProgress(9002, true);
    assert.equal(latestRunProgress()!.competitors[0]!.stage, 'failed');
  });
});

/**
 * Starting afresh clears every result of every check and nothing else: our
 * products and prices come from the feeds and must survive it.
 *
 * Needs a database. Skipped when DATABASE_URL is unset.
 */
const DATABASE_URL = process.env.DATABASE_URL;

describe('starting afresh', { skip: !DATABASE_URL && 'DATABASE_URL not set' }, () => {
  let startAfresh: typeof import('../src/services/startAfresh.ts').startAfresh;
  let query: typeof import('../src/db/pool.ts').query;
  let closePool: typeof import('../src/db/pool.ts').closePool;
  const sku = 'tst-afresh-1';
  const slug = 'tst-afresh-co';
  let productId = 0;

  before(async () => {
    ({ startAfresh } = await import('../src/services/startAfresh.ts'));
    ({ query, closePool } = await import('../src/db/pool.ts'));
    await query('DELETE FROM products WHERE internal_sku = $1', [sku]);
    await query('DELETE FROM competitors WHERE slug = $1', [slug]);

    const { rows: product } = await query<{ id: number }>(
      `INSERT INTO products (internal_sku, brand, product_name, source, looked_up_at, compared_at)
       VALUES ($1, 'B', 'Afresh Watch', 'manual', now(), now()) RETURNING id`,
      [sku],
    );
    productId = product[0]!.id;
    await query(
      `INSERT INTO fascia_prices (product_id, fascia_id, price, currency)
       SELECT $1, id, 100, 'GBP' FROM fascias WHERE enabled ORDER BY code LIMIT 1`,
      [productId],
    );
    const { rows: competitor } = await query<{ id: number }>(
      `INSERT INTO competitors (slug, display_name, base_url, search_url_pattern, enabled, config)
       VALUES ($1, 'Afresh Co', 'http://127.0.0.1:9', 'http://127.0.0.1:9/s?q={query}', TRUE, '{}'::jsonb)
       RETURNING id`,
      [slug],
    );
    const competitorId = competitor[0]!.id;
    const { rows: match } = await query<{ id: number }>(
      `INSERT INTO product_matches (product_id, competitor_id, competitor_url, status, confidence)
       VALUES ($1, $2, 'http://127.0.0.1:9/p', 'confirmed', 100) RETURNING id`,
      [productId, competitorId],
    );
    await query(
      `INSERT INTO price_observations (product_id, competitor_id, match_id, price, currency, source_url)
       VALUES ($1, $2, $3, 90, 'GBP', 'http://127.0.0.1:9/p')`,
      [productId, competitorId, match[0]!.id],
    );
    await query(`INSERT INTO scrape_runs (trigger, status) VALUES ('manual', 'completed')`);
    await query(`INSERT INTO lookup_batches (file_name, input_values) VALUES ('afresh.csv', '{x}')`);
  });

  after(async () => {
    await query('DELETE FROM products WHERE internal_sku = $1', [sku]);
    await query('DELETE FROM competitors WHERE slug = $1', [slug]);
    await closePool();
  });

  it('clears every price, match, run and list, and keeps our products and prices', async () => {
    const result = await startAfresh();
    assert.ok(result.pricesRemoved >= 1);
    assert.ok(result.matchesRemoved >= 1);
    assert.ok(result.runsRemoved >= 1);
    assert.ok(result.listsRemoved >= 1);

    const count = async (sql: string, params: unknown[] = []) =>
      (await query<{ n: number }>(`SELECT count(*)::int AS n FROM ${sql}`, params)).rows[0]!.n;
    assert.equal(await count('price_observations'), 0);
    assert.equal(await count('product_matches'), 0);
    assert.equal(await count(`scrape_runs WHERE status <> 'running'`), 0);
    assert.equal(await count('lookup_batches'), 0);

    // Kept: the product and our price for it, but no longer marked as checked.
    assert.equal(await count('products WHERE id = $1', [productId]), 1);
    assert.equal(await count('fascia_prices WHERE product_id = $1', [productId]), 1);
    assert.equal(await count('products WHERE id = $1 AND looked_up_at IS NULL AND compared_at IS NULL', [productId]), 1);
  });
});
