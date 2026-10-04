import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

/**
 * Aggregate position.
 *
 * Every failure here is a silently wrong number on a page someone uses to
 * argue for a range change or a supplier discount, which is worse than a
 * crash: nobody checks a percentage that looks plausible.
 */
const DATABASE_URL = process.env.DATABASE_URL;

describe('position analysis', { skip: !DATABASE_URL && 'DATABASE_URL not set' }, () => {
  let getPositionAnalysis: typeof import('../src/services/positionAnalysis.ts').getPositionAnalysis;
  let query: typeof import('../src/db/pool.ts').query;
  let closePool: typeof import('../src/db/pool.ts').closePool;

  let fasciaId = 0;
  const competitorIds: number[] = [];
  const PREFIX = 'tst-pos-';

  before(async () => {
    ({ getPositionAnalysis } = await import('../src/services/positionAnalysis.ts'));
    ({ query, closePool } = await import('../src/db/pool.ts'));

    await cleanup();

    const { rows: fascia } = await query<{ id: number }>(
      'SELECT id FROM fascias WHERE enabled ORDER BY code LIMIT 1',
    );
    fasciaId = fascia[0]!.id;

    for (const slug of ['tst-pos-a', 'tst-pos-b']) {
      const { rows } = await query<{ id: number }>(
        `INSERT INTO competitors (slug, display_name, base_url, search_url_pattern, brands, enabled, config)
         VALUES ($1, $1, 'https://x.test', 'https://x.test/s?q={query}', '{}', FALSE, '{}'::jsonb)
         RETURNING id`,
        [slug],
      );
      competitorIds.push(rows[0]!.id);
    }
  });

  async function cleanup(): Promise<void> {
    await query(
      `DELETE FROM price_observations WHERE product_id IN (SELECT id FROM products WHERE internal_sku LIKE $1)`,
      [`${PREFIX}%`],
    );
    await query(
      `DELETE FROM fascia_price_history WHERE product_id IN (SELECT id FROM products WHERE internal_sku LIKE $1)`,
      [`${PREFIX}%`],
    );
    await query(
      `DELETE FROM fascia_prices WHERE product_id IN (SELECT id FROM products WHERE internal_sku LIKE $1)`,
      [`${PREFIX}%`],
    );
    await query('DELETE FROM products WHERE internal_sku LIKE $1', [`${PREFIX}%`]);
    await query('DELETE FROM competitors WHERE slug LIKE $1', ['tst-pos-%']);
  }

  beforeEach(async () => {
    await query(
      `DELETE FROM price_observations WHERE product_id IN (SELECT id FROM products WHERE internal_sku LIKE $1)`,
      [`${PREFIX}%`],
    );
    await query(
      `DELETE FROM fascia_prices WHERE product_id IN (SELECT id FROM products WHERE internal_sku LIKE $1)`,
      [`${PREFIX}%`],
    );
    await query(
      `DELETE FROM fascia_price_history WHERE product_id IN (SELECT id FROM products WHERE internal_sku LIKE $1)`,
      [`${PREFIX}%`],
    );
    await query('DELETE FROM products WHERE internal_sku LIKE $1', [`${PREFIX}%`]);
  });

  after(async () => {
    await cleanup();
    await closePool();
  });

  /** A product with our price, and optionally a price at each competitor. */
  async function product(
    sku: string,
    brand: string,
    category: string,
    ourPrice: number | null,
    theirs: (number | null)[] = [],
    options: { inStock?: boolean } = {},
  ): Promise<void> {
    const { rows } = await query<{ id: number }>(
      `INSERT INTO products (internal_sku, brand, product_name, category, source)
       VALUES ($1, $2, $1, $3, 'manual') RETURNING id`,
      [`${PREFIX}${sku}`, brand, category],
    );
    const productId = rows[0]!.id;

    if (ourPrice != null) {
      await query(
        `INSERT INTO fascia_prices (product_id, fascia_id, price, currency, imported_at)
         VALUES ($1, $2, $3, 'GBP', now())`,
        [productId, fasciaId, ourPrice],
      );
    }

    for (let i = 0; i < theirs.length; i += 1) {
      if (theirs[i] == null) continue;
      await query(
        `INSERT INTO price_observations
           (product_id, competitor_id, price, currency, in_stock, source_url, observed_at)
         VALUES ($1, $2, $3, 'GBP', $4, 'https://x.test/p', now() - interval '2 hours')`,
        [productId, competitorIds[i], theirs[i], options.inStock ?? true],
      );
    }
  }

  it('counts lower, level and higher against the cheapest competitor', async () => {
    await product('1', 'Alpha', 'Watches', 100, [120, 140]); // we are cheaper
    await product('2', 'Alpha', 'Watches', 100, [100]); // level
    await product('3', 'Alpha', 'Watches', 100, [80]); // they are cheaper

    const analysis = await getPositionAnalysis(fasciaId);
    assert.equal(analysis.overall.compared, 3);
    assert.equal(analysis.overall.lower, 1);
    assert.equal(analysis.overall.equal, 1);
    assert.equal(analysis.overall.higher, 1);
    assert.equal(analysis.overall.higherPct, 33.3);
  });

  it('measures against the cheapest competitor, not the first or the average', async () => {
    // One rival at 120 and one at 80: our 100 is beaten, and a view that
    // averaged them (100) would call it level and hide the undercut.
    await product('1', 'Alpha', 'Watches', 100, [120, 80]);

    const analysis = await getPositionAnalysis(fasciaId);
    assert.equal(analysis.overall.higher, 1);
    assert.equal(analysis.overall.lower, 0);
  });

  it('ignores an out-of-stock competitor price', async () => {
    // An unbuyable price is a listing, not a competitive position.
    await product('1', 'Alpha', 'Watches', 100, [80], { inStock: false });

    const analysis = await getPositionAnalysis(fasciaId);
    assert.equal(analysis.overall.compared, 0);
  });

  it('treats a sub-penny difference as level, not as higher', async () => {
    await product('1', 'Alpha', 'Watches', 100.001, [100]);

    const analysis = await getPositionAnalysis(fasciaId);
    assert.equal(analysis.overall.equal, 1);
    assert.equal(analysis.overall.higher, 0);
  });

  it('breaks the position down by brand', async () => {
    await product('1', 'Alpha', 'Watches', 100, [80]);
    await product('2', 'Alpha', 'Watches', 100, [90]);
    await product('3', 'Beta', 'Watches', 100, [120]);

    const analysis = await getPositionAnalysis(fasciaId);
    const alpha = analysis.byBrand.find((row) => row.key === 'Alpha');
    const beta = analysis.byBrand.find((row) => row.key === 'Beta');

    assert.equal(alpha?.compared, 2);
    assert.equal(alpha?.higher, 2);
    assert.equal(alpha?.higherPct, 100);
    assert.equal(beta?.higher, 0);
    assert.equal(beta?.lower, 1);
  });

  it('breaks the position down by category', async () => {
    await product('1', 'Alpha', 'Watches', 100, [80]);
    await product('2', 'Alpha', 'Rings', 100, [120]);

    const analysis = await getPositionAnalysis(fasciaId);
    assert.equal(analysis.byCategory.find((row) => row.key === 'Watches')?.higher, 1);
    assert.equal(analysis.byCategory.find((row) => row.key === 'Rings')?.lower, 1);
  });

  it('reports every competitor separately, not only where they win', async () => {
    // The per-competitor question is "how does this retailer price against us
    // across their range", which a cheapest-wins filter would answer only for
    // the products they happen to be cheapest on.
    await product('1', 'Alpha', 'Watches', 100, [80, 140]);

    const analysis = await getPositionAnalysis(fasciaId);
    assert.equal(analysis.byCompetitor.length, 2);
    assert.equal(analysis.byCompetitor.find((row) => row.key === 'tst-pos-a')?.higher, 1);
    assert.equal(analysis.byCompetitor.find((row) => row.key === 'tst-pos-b')?.lower, 1);
  });

  it('reports the median gap with the sign the rest of the app uses', async () => {
    // Negative means we are cheaper, matching priceDelta everywhere else.
    await product('1', 'Alpha', 'Watches', 100, [120]);
    await product('2', 'Alpha', 'Watches', 100, [140]);

    const analysis = await getPositionAnalysis(fasciaId);
    assert.ok(analysis.overall.medianGapAbs! < 0, 'cheaper than the market reads negative');
    assert.equal(analysis.overall.medianGapAbs, -30);
    assert.equal(analysis.overall.medianGapPct, -30);
  });

  it('names the product with the widest gap against us', async () => {
    await product('1', 'Alpha', 'Watches', 100, [95]);
    await product('2', 'Alpha', 'Watches', 500, [200]);

    const analysis = await getPositionAnalysis(fasciaId);
    assert.equal(analysis.overall.worstGapAbs, 300);
    assert.equal(analysis.overall.worstGapSku, `${PREFIX}2`);
  });

  it('counts products nobody prices as uncovered, not as level', async () => {
    // The blind spot behind every percentage: a product with no competitor
    // price is not a tie, and folding it in would flatter the figures.
    await product('1', 'Alpha', 'Watches', 100, [100]);
    await product('2', 'Alpha', 'Watches', 100, []);

    const analysis = await getPositionAnalysis(fasciaId);
    assert.equal(analysis.overall.compared, 1);
    assert.equal(analysis.uncovered, 1);
  });

  it('leaves out a product we hold no price for', async () => {
    await product('1', 'Alpha', 'Watches', null, [100]);

    const analysis = await getPositionAnalysis(fasciaId);
    assert.equal(analysis.overall.compared, 0);
  });

  it('leaves out a delisted product', async () => {
    await product('1', 'Alpha', 'Watches', 100, [80]);
    await query(`UPDATE products SET delisted_at = now() WHERE internal_sku = $1`, [`${PREFIX}1`]);

    const analysis = await getPositionAnalysis(fasciaId);
    assert.equal(analysis.overall.compared, 0);
  });

  it('builds a weekly trend ending this week', async () => {
    await product('1', 'Alpha', 'Watches', 100, [80]);

    const analysis = await getPositionAnalysis(fasciaId);
    assert.ok(analysis.trend.length > 0);
    const latest = analysis.trend.at(-1)!;
    assert.equal(latest.compared, 1);
    assert.equal(latest.higher, 1);
    assert.equal(latest.higherPct, 100);
  });
});
