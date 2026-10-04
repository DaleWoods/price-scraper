import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

/**
 * New lines that nothing has compared yet.
 *
 * The gap this closes: discovery works through the catalogue, so a product
 * added this morning sits behind everything added before it — and new lines
 * are exactly where pricing decisions get made. Until now the only way to
 * notice was to spot a blank row among thousands of filled ones.
 */
const DATABASE_URL = process.env.DATABASE_URL;

describe('coverage gaps', { skip: !DATABASE_URL && 'DATABASE_URL not set' }, () => {
  let getCoverageGaps: typeof import('../src/services/coverageGaps.ts').getCoverageGaps;
  let newestUncoveredProductIds: typeof import('../src/services/coverageGaps.ts').newestUncoveredProductIds;
  let query: typeof import('../src/db/pool.ts').query;
  let closePool: typeof import('../src/db/pool.ts').closePool;

  let fasciaId = 0;
  let competitorId = 0;
  const PREFIX = 'tst-gap-';

  before(async () => {
    ({ getCoverageGaps, newestUncoveredProductIds } = await import('../src/services/coverageGaps.ts'));
    ({ query, closePool } = await import('../src/db/pool.ts'));
    await cleanup();

    const { rows: fascia } = await query<{ id: number }>(
      'SELECT id FROM fascias WHERE enabled ORDER BY code LIMIT 1',
    );
    fasciaId = fascia[0]!.id;

    const { rows: competitor } = await query<{ id: number }>(
      `INSERT INTO competitors (slug, display_name, base_url, search_url_pattern, brands, enabled, config)
       VALUES ('tst-gap-co', 'Gap Co', 'https://x.test', 'https://x.test/s?q={query}', '{}', FALSE, '{}'::jsonb)
       RETURNING id`,
    );
    competitorId = competitor[0]!.id;
  });

  async function cleanup(): Promise<void> {
    for (const table of ['price_observations', 'product_matches', 'fascia_price_history', 'fascia_prices']) {
      await query(
        `DELETE FROM ${table} WHERE product_id IN (SELECT id FROM products WHERE internal_sku LIKE $1)`,
        [`${PREFIX}%`],
      );
    }
    await query('DELETE FROM products WHERE internal_sku LIKE $1', [`${PREFIX}%`]);
    await query('DELETE FROM competitors WHERE slug LIKE $1', ['tst-gap-%']);
  }

  beforeEach(async () => {
    for (const table of ['price_observations', 'product_matches', 'fascia_price_history', 'fascia_prices']) {
      await query(
        `DELETE FROM ${table} WHERE product_id IN (SELECT id FROM products WHERE internal_sku LIKE $1)`,
        [`${PREFIX}%`],
      );
    }
    await query('DELETE FROM products WHERE internal_sku LIKE $1', [`${PREFIX}%`]);
  });

  after(async () => {
    await cleanup();
    await closePool();
  });

  async function product(
    sku: string,
    options: {
      ageDays?: number;
      priced?: boolean;
      observed?: boolean;
      match?: 'confirmed' | 'pending';
    } = {},
  ): Promise<number> {
    const { rows } = await query<{ id: number }>(
      `INSERT INTO products (internal_sku, brand, product_name, category, source, created_at)
       VALUES ($1, 'Alpha', $1, 'Watches', 'manual', now() - ($2 * interval '1 day'))
       RETURNING id`,
      [`${PREFIX}${sku}`, options.ageDays ?? 0],
    );
    const productId = rows[0]!.id;

    if (options.priced !== false) {
      await query(
        `INSERT INTO fascia_prices (product_id, fascia_id, price, currency, imported_at)
         VALUES ($1, $2, 100, 'GBP', now())`,
        [productId, fasciaId],
      );
    }
    if (options.match) {
      await query(
        `INSERT INTO product_matches
           (product_id, competitor_id, competitor_url, confidence, match_tier, status)
         VALUES ($1, $2, 'https://x.test/p', 90, 'ean_mpn_exact', $3)`,
        [productId, competitorId, options.match],
      );
    }
    if (options.observed) {
      await query(
        `INSERT INTO price_observations
           (product_id, competitor_id, price, currency, in_stock, source_url, observed_at)
         VALUES ($1, $2, 95, 'GBP', TRUE, 'https://x.test/p', now())`,
        [productId, competitorId],
      );
    }
    return productId;
  }

  it('lists a live priced product nothing has compared', async () => {
    await product('new');

    const report = await getCoverageGaps({ fasciaId });
    const gap = report.gaps.find((entry) => entry.internalSku === `${PREFIX}new`);
    assert.ok(gap);
    assert.equal(gap.reason, 'never_discovered');
    assert.equal(report.total, 1);
  });

  it('leaves out a product that already has a competitor price', async () => {
    await product('covered', { match: 'confirmed', observed: true });

    const report = await getCoverageGaps({ fasciaId });
    assert.equal(report.total, 0);
  });

  it('separates never-looked-at from matched-but-unpriced', async () => {
    // Both are gaps, but one needs a discovery run and the other needs a scan
    // — reporting them identically would send someone to the wrong fix.
    await product('nothing');
    await product('pending', { match: 'pending' });
    await product('confirmed', { match: 'confirmed' });

    const report = await getCoverageGaps({ fasciaId });
    const by = (sku: string) => report.gaps.find((g) => g.internalSku === `${PREFIX}${sku}`);
    assert.equal(by('nothing')?.reason, 'never_discovered');
    assert.equal(by('pending')?.reason, 'awaiting_review');
    assert.equal(by('confirmed')?.reason, 'matched_but_unpriced');
  });

  it('counts how many of the gaps are new lines', async () => {
    await product('fresh', { ageDays: 2 });
    await product('stale', { ageDays: 200 });

    const report = await getCoverageGaps({ fasciaId, windowDays: 14 });
    assert.equal(report.total, 2);
    assert.equal(report.newlyAdded, 1, 'a line live for 200 days is not a new line');
  });

  it('puts the newest first, because that is the one worth chasing', async () => {
    await product('old', { ageDays: 90 });
    await product('recent', { ageDays: 1 });

    const report = await getCoverageGaps({ fasciaId });
    assert.equal(report.gaps[0]!.internalSku, `${PREFIX}recent`);
  });

  it('leaves out a product we hold no price for', async () => {
    // Nothing to compare against, so it is not a coverage gap — it is a
    // pricing gap, which is a different problem on a different page.
    await product('unpriced', { priced: false });

    const report = await getCoverageGaps({ fasciaId });
    assert.equal(report.total, 0);
  });

  it('leaves out a delisted product', async () => {
    await product('gone');
    await query('UPDATE products SET delisted_at = now() WHERE internal_sku = $1', [`${PREFIX}gone`]);

    const report = await getCoverageGaps({ fasciaId });
    assert.equal(report.total, 0);
  });

  it('offers the uncovered products to discovery, oldest first', async () => {
    // Oldest-first within the uncovered set, so a backlog drains in the order
    // it formed instead of newest-first starving whatever missed a run.
    await product('older', { ageDays: 30 });
    await product('newer', { ageDays: 1 });
    await product('already', { match: 'confirmed' });

    const ids = await newestUncoveredProductIds(10);
    const { rows } = await query<{ internal_sku: string }>(
      'SELECT internal_sku FROM products WHERE id = ANY($1::bigint[]) ORDER BY created_at ASC',
      [ids],
    );
    const skus = rows.map((r) => r.internal_sku);
    assert.deepEqual(skus, [`${PREFIX}older`, `${PREFIX}newer`]);
    assert.ok(!skus.includes(`${PREFIX}already`), 'one already matched is not awaiting discovery');
  });
});
