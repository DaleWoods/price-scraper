import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

/**
 * What moved overnight.
 *
 * Every assertion here guards against a silent wrong answer rather than a
 * crash. Reporting a change that did not happen sends someone to re-price a
 * product for no reason; missing one that did is the whole point of the tool
 * failing quietly.
 */
const DATABASE_URL = process.env.DATABASE_URL;

describe('price movements', { skip: !DATABASE_URL && 'DATABASE_URL not set' }, () => {
  let getPriceMovements: typeof import('../src/services/priceMovements.ts').getPriceMovements;
  let query: typeof import('../src/db/pool.ts').query;
  let closePool: typeof import('../src/db/pool.ts').closePool;

  const SKU = 'tst-move-a';
  const SLUG = 'tst-move-co';
  let productId = 0;
  let competitorId = 0;
  let fasciaId = 0;

  before(async () => {
    ({ getPriceMovements } = await import('../src/services/priceMovements.ts'));
    ({ query, closePool } = await import('../src/db/pool.ts'));

    await cleanup();

    const { rows: fascia } = await query<{ id: number }>(
      'SELECT id FROM fascias WHERE enabled ORDER BY code LIMIT 1',
    );
    fasciaId = fascia[0]!.id;

    const { rows: product } = await query<{ id: number }>(
      `INSERT INTO products (internal_sku, brand, product_name, category, source)
       VALUES ($1, 'TestBrand', 'Movement Test Watch', 'Watches', 'manual') RETURNING id`,
      [SKU],
    );
    productId = product[0]!.id;

    const { rows: competitor } = await query<{ id: number }>(
      `INSERT INTO competitors (slug, display_name, base_url, search_url_pattern, brands, enabled, config)
       VALUES ($1, 'Movement Test Co', 'https://example.test', 'https://example.test/s?q={query}',
               '{}', FALSE, '{}'::jsonb) RETURNING id`,
      [SLUG],
    );
    competitorId = competitor[0]!.id;
  });

  async function cleanup(): Promise<void> {
    await query(
      `DELETE FROM fascia_price_history WHERE product_id IN (SELECT id FROM products WHERE internal_sku LIKE 'tst-move%')`,
    );
    await query(
      `DELETE FROM price_observations WHERE product_id IN (SELECT id FROM products WHERE internal_sku LIKE 'tst-move%')`,
    );
    await query(
      `DELETE FROM fascia_prices WHERE product_id IN (SELECT id FROM products WHERE internal_sku LIKE 'tst-move%')`,
    );
    await query(`DELETE FROM products WHERE internal_sku LIKE 'tst-move%'`);
    await query(`DELETE FROM competitors WHERE slug LIKE 'tst-move%'`);
  }

  beforeEach(async () => {
    if (!productId) return;
    await query('DELETE FROM price_observations WHERE product_id = $1', [productId]);
    await query('DELETE FROM fascia_price_history WHERE product_id = $1', [productId]);
    await query('DELETE FROM fascia_prices WHERE product_id = $1', [productId]);
  });

  after(async () => {
    await cleanup();
    await closePool();
  });

  /** An observation at a given age in hours. */
  async function observe(price: number, hoursAgo: number): Promise<void> {
    await query(
      `INSERT INTO price_observations (product_id, competitor_id, price, currency, in_stock, source_url, observed_at)
       VALUES ($1, $2, $3, 'GBP', TRUE, 'https://example.test/p', now() - ($4 * interval '1 hour'))`,
      [productId, competitorId, price, hoursAgo],
    );
  }

  async function setOurPrice(price: number): Promise<void> {
    await query(
      `INSERT INTO fascia_prices (product_id, fascia_id, price, currency, imported_at)
       VALUES ($1, $2, $3, 'GBP', now())
       ON CONFLICT (product_id, fascia_id) DO UPDATE SET price = EXCLUDED.price, imported_at = now()`,
      [productId, fasciaId, price],
    );
  }

  it('reports a competitor price change with the direction and size', async () => {
    await setOurPrice(1000);
    await observe(1200, 30);
    await observe(900, 2);

    const report = await getPriceMovements({ fasciaId, days: 1 });
    const movement = report.movements.find((entry) => entry.side === 'competitor');

    assert.ok(movement, 'a change within the window must be reported');
    assert.equal(movement.previousPrice, 1200);
    assert.equal(movement.price, 900);
    assert.equal(movement.deltaAbs, -300);
    assert.equal(movement.deltaPct, -25);
    assert.equal(movement.position, 'higher', 'they are now cheaper, so we are higher');
  });

  it('says nothing when the price was observed again unchanged', async () => {
    // The common case by far: we re-check every night and almost nothing
    // moves. Reporting those would bury the real changes.
    await setOurPrice(1000);
    await observe(1200, 30);
    await observe(1200, 2);

    const report = await getPriceMovements({ fasciaId, days: 1 });
    assert.equal(report.movements.length, 0);
    assert.equal(report.summary.competitorChanges, 0);
  });

  it('compares against the previous observation even when it predates the window', async () => {
    // The trap: filtering observations to the window *before* taking the
    // previous one makes last night's change look like a first sighting, and
    // it vanishes from the report entirely.
    await setOurPrice(1000);
    await observe(1200, 240); // ten days ago
    await observe(950, 3); // last night

    const report = await getPriceMovements({ fasciaId, days: 1 });
    assert.equal(report.movements.length, 1);
    assert.equal(report.movements[0]!.previousPrice, 1200);
  });

  it('ignores changes outside the window', async () => {
    await setOurPrice(1000);
    await observe(1200, 400);
    await observe(900, 300);

    const report = await getPriceMovements({ fasciaId, days: 1 });
    assert.equal(report.movements.length, 0);
  });

  it('records one of our own price changes, not just theirs', async () => {
    // Without this the report can only ever say "they moved", never "we did"
    // — and the two call for completely different responses.
    await setOurPrice(1000);
    await setOurPrice(1100);

    const report = await getPriceMovements({ fasciaId, days: 1 });
    const ours = report.movements.find((entry) => entry.side === 'ours');

    assert.ok(ours, 'our own change must appear');
    assert.equal(ours.previousPrice, 1000);
    assert.equal(ours.price, 1100);
    assert.equal(ours.competitorId, null);
    assert.equal(report.summary.ourChanges, 1);
  });

  it('does not report the first price we ever held as a change', async () => {
    await setOurPrice(1000);

    const report = await getPriceMovements({ fasciaId, days: 1 });
    assert.equal(report.summary.ourChanges, 0, 'a baseline is not a movement');
  });

  it('counts a new undercut, and does not count one that already existed', async () => {
    await setOurPrice(1000);
    // 1200 -> 900 crosses our price: newly undercut.
    await observe(1200, 30);
    await observe(900, 2);

    let report = await getPriceMovements({ fasciaId, days: 1 });
    assert.equal(report.summary.newlyUndercut, 1);

    // 900 -> 800 is cheaper still, but they were already beating us.
    await observe(800, 1);
    report = await getPriceMovements({ fasciaId, days: 1 });
    assert.equal(report.summary.newlyUndercut, 1, 'a deeper cut is not a new undercut');
    assert.equal(report.summary.competitorChanges, 2);
  });

  it('counts an undercut that has been resolved', async () => {
    await setOurPrice(1000);
    await observe(900, 30);
    await observe(1100, 2);

    const report = await getPriceMovements({ fasciaId, days: 1 });
    assert.equal(report.summary.undercutResolved, 1);
    assert.equal(report.movements[0]!.position, 'lower');
  });

  it('separates cuts from rises', async () => {
    await setOurPrice(1000);
    await observe(1200, 30);
    await observe(1100, 10);
    await observe(1300, 2);

    const report = await getPriceMovements({ fasciaId, days: 1 });
    assert.equal(report.summary.competitorChanges, 2);
    assert.equal(report.summary.competitorCuts, 1);
    assert.equal(report.summary.competitorRises, 1);
  });

  it('leaves a delisted product out — it is not ours to compare any more', async () => {
    await setOurPrice(1000);
    await observe(1200, 30);
    await observe(900, 2);
    await query('UPDATE products SET delisted_at = now() WHERE id = $1', [productId]);

    try {
      const report = await getPriceMovements({ fasciaId, days: 1 });
      assert.equal(report.movements.length, 0);
    } finally {
      await query('UPDATE products SET delisted_at = NULL WHERE id = $1', [productId]);
    }
  });

  it('can be narrowed to one side', async () => {
    await setOurPrice(1000);
    await setOurPrice(1100);
    await observe(1200, 30);
    await observe(900, 2);

    const theirs = await getPriceMovements({ fasciaId, days: 1, side: 'competitor' });
    assert.ok(theirs.movements.every((entry) => entry.side === 'competitor'));
    assert.ok(theirs.movements.length > 0);

    const ours = await getPriceMovements({ fasciaId, days: 1, side: 'ours' });
    assert.ok(ours.movements.every((entry) => entry.side === 'ours'));
    assert.ok(ours.movements.length > 0);
  });

  it('summarises everything, even when the view is filtered to undercuts', async () => {
    // The headline numbers must describe what happened overnight, not what
    // survived the filter the reader happens to have applied.
    await setOurPrice(1000);
    await observe(900, 30);
    await observe(1100, 2); // a rise, leaving us lower — filtered out below

    const report = await getPriceMovements({ fasciaId, days: 1, undercutsOnly: true });
    assert.equal(report.movements.length, 0);
    assert.equal(report.summary.competitorChanges, 1, 'the summary covers all of it');
  });
});
