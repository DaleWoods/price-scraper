import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

/**
 * End-to-end cover for the riskiest part of the importer: a feed being
 * authoritative for its fascia.
 *
 * Needs a database. Skipped when DATABASE_URL is unset so the unit suite still
 * runs anywhere, rather than failing for a missing service.
 */
const DATABASE_URL = process.env.DATABASE_URL;

describe('importFeed against a database', { skip: !DATABASE_URL && 'DATABASE_URL not set' }, () => {
  let importFeed: typeof import('../src/import/feedImport.ts').importFeed;
  let query: typeof import('../src/db/pool.ts').query;
  let closePool: typeof import('../src/db/pool.ts').closePool;
  let fasciaCode: string;

  const HEADER =
    'id\ttitle\tdescription\tproduct_type\tlink\tavailability\tprice\tsale_price\t' +
    'sale_price_effective_date\tprice_visible\tbrand\tgtin\tmpn\tmetal_type';

  function feed(rows: string[]): Buffer {
    return Buffer.from([HEADER, ...rows].join('\n'), 'utf8');
  }

  /** One product row; blanks for the fields a given test does not care about. */
  function row(
    id: string,
    price: string,
    { sale = '', window = '', visible = 'TRUE' } = {},
  ): string {
    return [
      id, `Test ${id}`, 'desc', 'Watches', `https://example.test/${id}`, 'in stock',
      price, sale, window, visible, 'TestBrand', '', `MPN-${id}`, 'Steel',
    ].join('\t');
  }

  const skus = ['tst-90000001', 'tst-90000002', 'tst-90000003'];

  before(async () => {
    ({ importFeed } = await import('../src/import/feedImport.ts'));
    ({ query, closePool } = await import('../src/db/pool.ts'));
    const { rows } = await query<{ code: string }>(
      'SELECT code FROM fascias WHERE enabled ORDER BY code LIMIT 1',
    );
    fasciaCode = rows[0]!.code;
    await query('DELETE FROM products WHERE internal_sku = ANY($1)', [skus]);
  });

  after(async () => {
    await query('DELETE FROM products WHERE internal_sku = ANY($1)', [skus]);
    await closePool();
  });

  async function listedSkus(): Promise<string[]> {
    const { rows } = await query<{ internal_sku: string }>(
      'SELECT internal_sku FROM products WHERE internal_sku = ANY($1) AND delisted_at IS NULL ORDER BY 1',
      [skus],
    );
    return rows.map((r) => r.internal_sku);
  }

  it('imports every product in the file', async () => {
    const result = await importFeed(
      feed([row(skus[0]!, '100.0 GBP'), row(skus[1]!, '200.0 GBP'), row(skus[2]!, '300.0 GBP')]),
      'three.tsv',
      fasciaCode,
    );
    assert.equal(result.pricesWritten, 3);
    assert.deepEqual(await listedSkus(), skus);
  });

  it('delists products a later feed leaves out', async () => {
    // The reported bug: a one-product feed did not narrow what gets scanned.
    const result = await importFeed(feed([row(skus[1]!, '250.0 GBP')]), 'one.tsv', fasciaCode);

    assert.equal(result.pricesWritten, 1);
    assert.equal(result.stalePricesRemoved, 2);
    assert.equal(result.productsDelisted, 2);
    assert.deepEqual(await listedSkus(), [skus[1]]);
  });

  it('keeps the delisted rows rather than deleting them', async () => {
    const { rows } = await query<{ count: number }>(
      'SELECT count(*)::int AS count FROM products WHERE internal_sku = ANY($1)',
      [skus],
    );
    assert.equal(rows[0]!.count, 3, 'price history must survive a delisting');
  });

  it('relists a product that comes back in a later feed', async () => {
    const result = await importFeed(
      feed([row(skus[0]!, '100.0 GBP'), row(skus[1]!, '200.0 GBP'), row(skus[2]!, '300.0 GBP')]),
      'three-again.tsv',
      fasciaCode,
    );
    assert.equal(result.productsRelisted, 2);
    assert.equal(result.productsDelisted, 0);
    assert.deepEqual(await listedSkus(), skus);
  });

  it('applies a sale price that is cheaper and currently open', async () => {
    const result = await importFeed(
      feed([
        row(skus[0]!, '100.0 GBP', { sale: '80.0 GBP' }),
        row(skus[1]!, '200.0 GBP'),
        row(skus[2]!, '300.0 GBP'),
      ]),
      'sale.tsv',
      fasciaCode,
    );
    assert.equal(result.onSale, 1);

    const { rows } = await query<{ price: string; regular_price: string; on_sale: boolean }>(
      `SELECT fp.price, fp.regular_price, fp.on_sale FROM fascia_prices fp
       JOIN products p ON p.id = fp.product_id WHERE p.internal_sku = $1`,
      [skus[0]],
    );
    assert.equal(Number(rows[0]!.price), 80);
    assert.equal(Number(rows[0]!.regular_price), 100);
    assert.equal(rows[0]!.on_sale, true);
  });

  it('refuses a cheaper sale whose window has not opened', async () => {
    const result = await importFeed(
      feed([
        row(skus[0]!, '100.0 GBP', {
          sale: '80.0 GBP',
          window: '2099-01-01T00:00:00Z/2099-02-01T00:00:00Z',
        }),
        row(skus[1]!, '200.0 GBP'),
        row(skus[2]!, '300.0 GBP'),
      ]),
      'future-sale.tsv',
      fasciaCode,
    );
    assert.equal(result.onSale, 0);
    assert.equal(result.saleNotYetActive, 1);

    const { rows } = await query<{ price: string; on_sale: boolean }>(
      `SELECT fp.price, fp.on_sale FROM fascia_prices fp
       JOIN products p ON p.id = fp.product_id WHERE p.internal_sku = $1`,
      [skus[0]],
    );
    assert.equal(Number(rows[0]!.price), 100, 'the regular price applies until the sale starts');
    assert.equal(rows[0]!.on_sale, false);
  });

  it('records no price for a product whose price is hidden', async () => {
    const result = await importFeed(
      feed([
        row(skus[0]!, '100.0 GBP', { visible: 'FALSE' }),
        row(skus[1]!, '200.0 GBP'),
        row(skus[2]!, '300.0 GBP'),
      ]),
      'hidden.tsv',
      fasciaCode,
    );
    assert.equal(result.priceHidden, 1);
    assert.equal(result.pricesWritten, 2);
  });
});
