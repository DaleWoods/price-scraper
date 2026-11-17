import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

/**
 * All products lists every product we sell, not only those a competitor has
 * priced. The first real use showed why: the feeds had loaded the Tudor being
 * searched for, the tile counted it, and the table — which only drew products
 * with a competitor price — said there was nothing there.
 *
 * Each product is in one of three states, and each can be filtered to:
 * priced; checked everywhere and sold by none; not checked yet.
 *
 * Needs a database. Skipped when DATABASE_URL is unset.
 */
const DATABASE_URL = process.env.DATABASE_URL;

describe('All products', { skip: !DATABASE_URL && 'DATABASE_URL not set' }, () => {
  let getComparison: typeof import('../src/services/comparison.ts').getComparison;
  let query: typeof import('../src/db/pool.ts').query;
  let closePool: typeof import('../src/db/pool.ts').closePool;

  const prefix = 'tst-allp-';
  const brand = 'AllProductsTestBrand';
  const slug = 'tst-allp-co';
  let fasciaCode = '';

  async function cleanup(): Promise<void> {
    await query(`DELETE FROM products WHERE internal_sku LIKE $1`, [`${prefix}%`]);
    await query('DELETE FROM competitors WHERE slug = $1', [slug]);
  }

  async function product(sku: string, ourPrice: number, compared: boolean): Promise<number> {
    const { rows } = await query<{ id: number }>(
      `INSERT INTO products (internal_sku, brand, product_name, source, compared_at)
       VALUES ($1, $2, $3, 'manual', ${compared ? 'now()' : 'NULL'}) RETURNING id`,
      [`${prefix}${sku}`, brand, `Test ${sku}`],
    );
    const id = rows[0]!.id;
    await query(
      `INSERT INTO fascia_prices (product_id, fascia_id, price, currency)
       SELECT $1, id, $2, 'GBP' FROM fascias WHERE code = $3`,
      [id, ourPrice, fasciaCode],
    );
    return id;
  }

  before(async () => {
    ({ getComparison } = await import('../src/services/comparison.ts'));
    ({ query, closePool } = await import('../src/db/pool.ts'));
    const { rows: fascia } = await query<{ code: string }>('SELECT code FROM fascias WHERE enabled ORDER BY code LIMIT 1');
    fasciaCode = fascia[0]!.code;
    await cleanup();

    const { rows: competitor } = await query<{ id: number }>(
      `INSERT INTO competitors (slug, display_name, base_url, search_url_pattern, enabled, config)
       VALUES ($1, 'All Products Co', 'http://127.0.0.1:9', 'http://127.0.0.1:9/s?q={query}', TRUE, '{}'::jsonb)
       RETURNING id`,
      [slug],
    );
    const competitorId = competitor[0]!.id;

    const undercut = await product('undercut', 100, true);
    const small = await product('small-undercut', 100, true);
    const level = await product('level', 100, true);
    const dearer = await product('dearer', 100, true);
    await product('not-sold', 100, true);
    await product('not-checked', 100, false);

    for (const [id, price] of [
      [undercut, 80],
      [small, 95],
      [level, 100],
      [dearer, 120],
    ] as const) {
      await query(
        `INSERT INTO price_observations (product_id, competitor_id, price, currency, in_stock, source_url)
         VALUES ($1, $2, $3, 'GBP', TRUE, 'http://127.0.0.1:9/p')`,
        [id, competitorId, price],
      );
    }
  });

  after(async () => {
    await cleanup();
    await closePool();
  });

  const filters = () => ({ fasciaCode, brand, limit: 50 });
  const skus = (rows: { product: { internal_sku: string } }[]) =>
    rows.map((row) => row.product.internal_sku.replace(prefix, ''));

  it('lists every product, priced or not, with the most urgent first', async () => {
    const page = await getComparison(filters());
    assert.equal(page.total, 6);
    assert.deepEqual(skus(page.rows).slice(0, 4), ['undercut', 'small-undercut', 'level', 'dearer']);
    assert.deepEqual(new Set(skus(page.rows).slice(4)), new Set(['not-sold', 'not-checked']));
  });

  it('counts each state', async () => {
    const { summary } = await getComparison(filters());
    assert.equal(summary.products, 6);
    assert.equal(summary.withCompetitorPrice, 4);
    assert.equal(summary.higher, 2);
    assert.equal(summary.equal, 1);
    assert.equal(summary.lower, 1);
    assert.equal(summary.notSold, 1);
    assert.equal(summary.notChecked, 1);
  });

  it('says which state each product is in', async () => {
    const page = await getComparison(filters());
    const status = new Map(page.rows.map((row) => [row.product.internal_sku.replace(prefix, ''), row.compareStatus]));
    assert.equal(status.get('undercut'), 'priced');
    assert.equal(status.get('not-sold'), 'not_sold');
    assert.equal(status.get('not-checked'), 'not_checked');
  });

  it('filters to each state', async () => {
    assert.deepEqual(skus((await getComparison({ ...filters(), position: 'higher' })).rows), ['undercut', 'small-undercut']);
    assert.deepEqual(skus((await getComparison({ ...filters(), position: 'lower' })).rows), ['dearer']);
    assert.deepEqual(skus((await getComparison({ ...filters(), position: 'not_sold' })).rows), ['not-sold']);
    assert.deepEqual(skus((await getComparison({ ...filters(), position: 'not_checked' })).rows), ['not-checked']);
  });

  it('finds a product with no competitor price by searching for it', async () => {
    const page = await getComparison({ ...filters(), search: `${prefix}not-checked` });
    assert.deepEqual(skus(page.rows), ['not-checked']);
  });

  it('pages across the priced and unpriced products without losing or repeating any', async () => {
    const first = await getComparison({ ...filters(), limit: 3, offset: 0 });
    const second = await getComparison({ ...filters(), limit: 3, offset: 3 });
    const all = [...skus(first.rows), ...skus(second.rows)];
    assert.equal(all.length, 6);
    assert.equal(new Set(all).size, 6);
  });
});
