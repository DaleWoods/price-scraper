import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

/**
 * What the figures are based on, and where a rival cannot fulfil.
 *
 * The coverage and freshness numbers exist to pre-empt the first challenge any
 * percentage gets, so they have to be right in the unflattering direction: a
 * bug that overstates coverage or understates age makes the tool look more
 * authoritative than it is, which is worse than no figure at all.
 */
const DATABASE_URL = process.env.DATABASE_URL;

describe('evidence basis', { skip: !DATABASE_URL && 'DATABASE_URL not set' }, () => {
  let getEvidenceBasis: typeof import('../src/services/evidenceBasis.ts').getEvidenceBasis;
  let getStockOpportunities: typeof import('../src/services/evidenceBasis.ts').getStockOpportunities;
  let query: typeof import('../src/db/pool.ts').query;
  let closePool: typeof import('../src/db/pool.ts').closePool;

  let fasciaId = 0;
  const competitorIds: number[] = [];
  const PREFIX = 'tst-ev-';

  before(async () => {
    ({ getEvidenceBasis, getStockOpportunities } = await import('../src/services/evidenceBasis.ts'));
    ({ query, closePool } = await import('../src/db/pool.ts'));
    await cleanup();

    const { rows: fascia } = await query<{ id: number }>(
      'SELECT id FROM fascias WHERE enabled ORDER BY code LIMIT 1',
    );
    fasciaId = fascia[0]!.id;

    for (const slug of ['tst-ev-a', 'tst-ev-b']) {
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
    for (const table of ['price_observations', 'product_matches', 'fascia_price_history', 'fascia_prices']) {
      await query(
        `DELETE FROM ${table} WHERE product_id IN (SELECT id FROM products WHERE internal_sku LIKE $1)`,
        [`${PREFIX}%`],
      );
    }
    await query('DELETE FROM products WHERE internal_sku LIKE $1', [`${PREFIX}%`]);
    await query('DELETE FROM competitors WHERE slug LIKE $1', ['tst-ev-%']);
  }

  beforeEach(async () => {
    for (const table of ['price_observations', 'fascia_price_history', 'fascia_prices']) {
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
    ourPrice: number | null,
    theirs: { price: number; inStock: boolean; ageHours?: number; at?: number }[] = [],
  ): Promise<void> {
    const { rows } = await query<{ id: number }>(
      `INSERT INTO products (internal_sku, brand, product_name, category, source)
       VALUES ($1, 'Alpha', $1, 'Watches', 'manual') RETURNING id`,
      [`${PREFIX}${sku}`],
    );
    const productId = rows[0]!.id;

    if (ourPrice != null) {
      await query(
        `INSERT INTO fascia_prices (product_id, fascia_id, price, currency, imported_at)
         VALUES ($1, $2, $3, 'GBP', now())`,
        [productId, fasciaId, ourPrice],
      );
    }
    for (const entry of theirs) {
      await query(
        `INSERT INTO price_observations
           (product_id, competitor_id, price, currency, in_stock, source_url, observed_at)
         VALUES ($1, $2, $3, 'GBP', $4, 'https://x.test/p', now() - ($5 * interval '1 hour'))`,
        [productId, competitorIds[entry.at ?? 0], entry.price, entry.inStock, entry.ageHours ?? 2],
      );
    }
  }

  describe('coverage and freshness', () => {
    it('reports how much of what we sell is actually compared', async () => {
      await product('1', 100, [{ price: 90, inStock: true }]);
      await product('2', 100, []);

      const basis = await getEvidenceBasis(fasciaId);
      assert.equal(basis.productsPriced, 2);
      assert.equal(basis.productsCompared, 1);
      assert.equal(basis.coveragePct, 50);
    });

    it('does not count a product we hold no price for as part of the range', async () => {
      await product('1', 100, [{ price: 90, inStock: true }]);
      await product('2', null, [{ price: 90, inStock: true }]);

      const basis = await getEvidenceBasis(fasciaId);
      assert.equal(basis.productsPriced, 1, 'coverage is of what we price, not of everything');
    });

    it('ages the latest price per pair, not every price ever recorded', async () => {
      // The trap: averaging the whole table drags the figure back through
      // every superseded price and makes the data look far staler than the
      // figures people are actually reading.
      await product('1', 100, [
        { price: 90, inStock: true, ageHours: 24 * 30 },
        { price: 95, inStock: true, ageHours: 24 },
      ]);

      const basis = await getEvidenceBasis(fasciaId);
      assert.ok(basis.medianPriceAgeDays != null);
      assert.ok(basis.medianPriceAgeDays < 2, 'the current price is a day old, not a month');
    });

    it('reports the oldest price still being shown as current', async () => {
      await product('1', 100, [{ price: 90, inStock: true, ageHours: 24 * 20 }]);
      await product('2', 100, [{ price: 90, inStock: true, ageHours: 2 }]);

      const basis = await getEvidenceBasis(fasciaId);
      assert.ok(basis.oldestPriceAgeDays! >= 19 && basis.oldestPriceAgeDays! <= 21);
    });

    it('counts the competitors that actually produced a price', async () => {
      await product('1', 100, [
        { price: 90, inStock: true, at: 0 },
        { price: 95, inStock: true, at: 1 },
      ]);

      const basis = await getEvidenceBasis(fasciaId);
      assert.equal(basis.competitorsContributing, 2);
    });

    it('reads zero coverage rather than crashing on an empty catalogue', async () => {
      const basis = await getEvidenceBasis(fasciaId);
      assert.equal(basis.productsPriced, 0);
      assert.equal(basis.coveragePct, 0);
      assert.equal(basis.medianPriceAgeDays, null);
    });
  });

  describe('where only an unavailable rival beats us', () => {
    it('finds a product whose cheaper competitor is out of stock', async () => {
      await product('1', 100, [{ price: 80, inStock: false }]);

      const opportunities = await getStockOpportunities(fasciaId);
      assert.equal(opportunities.length, 1);
      assert.equal(opportunities[0]!.theirPrice, 80);
      assert.equal(opportunities[0]!.gapAbs, 20);
      assert.equal(opportunities[0]!.gapPct, 20);
    });

    it('ignores it when someone buyable already beats us', async () => {
      // The window is imaginary if a customer can still get it cheaper
      // elsewhere — nothing has moved in our favour.
      await product('1', 100, [
        { price: 80, inStock: false, at: 0 },
        { price: 90, inStock: true, at: 1 },
      ]);

      assert.equal((await getStockOpportunities(fasciaId)).length, 0);
    });

    it('still counts when the in-stock rival is dearer than us', async () => {
      await product('1', 100, [
        { price: 80, inStock: false, at: 0 },
        { price: 120, inStock: true, at: 1 },
      ]);

      const opportunities = await getStockOpportunities(fasciaId);
      assert.equal(opportunities.length, 1);
    });

    it('ignores an out-of-stock rival who is dearer anyway', async () => {
      await product('1', 100, [{ price: 130, inStock: false }]);
      assert.equal((await getStockOpportunities(fasciaId)).length, 0);
    });

    it('reports the cheapest unavailable price when several are out of stock', async () => {
      await product('1', 100, [
        { price: 95, inStock: false, at: 0 },
        { price: 70, inStock: false, at: 1 },
      ]);

      const opportunities = await getStockOpportunities(fasciaId);
      assert.equal(opportunities.length, 1, 'one row per product, not one per rival');
      assert.equal(opportunities[0]!.theirPrice, 70);
    });
  });
});
