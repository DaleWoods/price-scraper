import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { startStandIn, standInConfig, type StandIn } from './helpers/standInCompetitor.ts';

/**
 * Coverage for reading a competitor's catalogue and matching against it.
 *
 * The claim under test is the one the whole design rests on: a full run reads
 * each of a competitor's product pages once, matches our products to them by
 * barcode or manufacturer reference in the database, and prices a new match
 * from the page it has just read — without asking the competitor for that page
 * a second time.
 *
 * Like the runner tests these talk to a real local site, because the runner
 * reads competitors from the database and reaches them over HTTP. Only one run
 * can be in flight per process, so every test awaits completion.
 */
const DATABASE_URL = process.env.DATABASE_URL;

// Read at import by config/env.ts. The politeness floor is real behaviour, but
// a second's pause per page across these tests proves nothing extra.
process.env.SCRAPER_MIN_DELAY_MS = '0';

describe('competitor catalogue', { skip: !DATABASE_URL && 'DATABASE_URL not set' }, () => {
  let startRun: typeof import('../src/scraping/runner.ts').startRun;
  let harvestCatalogue: typeof import('../src/scraping/catalogue.ts').harvestCatalogue;
  let query: typeof import('../src/db/pool.ts').query;
  let closePool: typeof import('../src/db/pool.ts').closePool;

  let standIn: StandIn;
  let blockedSite: StandIn;
  let competitorId = 0;
  let blockedId = 0;
  const productIds = new Map<string, number>();

  const SKU_PREFIX = 'tst-cat-';
  const SLUG = 'tst-cat-co';
  const BLOCKED_SLUG = 'tst-cat-blocked';

  /** What the stand-in retailer lists. */
  const THEIR_CATALOGUE = [
    // Publishes the barcode: matched on it.
    { slug: 'gtin', name: 'CatBrand Diver 42mm Blue', brand: 'CatBrand', price: '1000.00', gtin: '7020000000011' },
    // Publishes only the manufacturer reference, punctuated differently to ours.
    { slug: 'mpn', name: 'CatBrand Chrono 40mm Black', brand: 'CatBrand', price: '2000.00', mpn: '220.13.41-21' },
    // Publishes their own stock code as `mpn` — it is not the maker's reference.
    { slug: 'own', name: 'CatBrand Dress 38mm White', brand: 'CatBrand', price: '3000.00', mpn: 'STOCK-998877' },
    // A barcode nobody of ours carries: read and remembered, matched to nothing.
    { slug: 'other', name: 'OtherBrand Field 36mm', brand: 'OtherBrand', price: '400.00', gtin: '7020000000099' },
    { slug: 'gone', name: 'CatBrand Retired 41mm', brand: 'CatBrand', status: 404 },
  ];

  /** What we sell. */
  const OUR_PRODUCTS = [
    { key: 'gtin', brand: 'CatBrand', name: 'Diver 42mm Blue Dial', gtin: '7020000000011', mpn: null },
    // Held by reference only; theirs is "220.13.41-21".
    { key: 'mpn', brand: 'CatBrand', name: 'Chronograph 40mm', gtin: null, mpn: '2201341.21' },
    // We hold a barcode; their page publishes only their own stock code.
    { key: 'own', brand: 'CatBrand', name: 'Dress 38mm White', gtin: '7020000000033', mpn: 'CB-DRESS-38' },
    // Nobody lists this one.
    { key: 'unlisted', brand: 'CatBrand', name: 'Pilot 44mm Green', gtin: '7020000000044', mpn: null },
  ];

  before(async () => {
    ({ startRun } = await import('../src/scraping/runner.ts'));
    ({ harvestCatalogue } = await import('../src/scraping/catalogue.ts'));
    ({ query, closePool } = await import('../src/db/pool.ts'));

    await cleanup();
    standIn = await startStandIn(THEIR_CATALOGUE, { extraSitemapPaths: ['/watches/divers'] });
    // Seven pages, every one refused: the harvest must give up, not grind on.
    blockedSite = await startStandIn(
      Array.from({ length: 7 }, (_, index) => ({
        slug: `b${index}`,
        name: `Blocked Watch ${index}`,
        brand: 'CatBrand',
        status: 403,
      })),
    );

    const base = standInConfig();
    const { rows: competitor } = await query<{ id: number }>(
      `INSERT INTO competitors (slug, display_name, base_url, search_url_pattern, brands, enabled, config)
       VALUES ($1, 'Catalogue Test Co', $2, $3, '{}', TRUE, $4::jsonb) RETURNING id`,
      [
        SLUG,
        standIn.origin,
        `${standIn.origin}/search?q={query}`,
        // Only /p/ pages are products; the category page in the sitemap is not.
        JSON.stringify({ ...base.config, productUrlPattern: '^/p/' }),
      ],
    );
    competitorId = competitor[0]!.id;

    const { rows: blocked } = await query<{ id: number }>(
      `INSERT INTO competitors (slug, display_name, base_url, search_url_pattern, brands, enabled, config)
       VALUES ($1, 'Catalogue Blocked Co', $2, $3, '{}', FALSE, $4::jsonb) RETURNING id`,
      [BLOCKED_SLUG, blockedSite.origin, `${blockedSite.origin}/search?q={query}`, JSON.stringify(base.config)],
    );
    blockedId = blocked[0]!.id;

    for (const product of OUR_PRODUCTS) {
      const { rows } = await query<{ id: number }>(
        `INSERT INTO products (internal_sku, brand, product_name, ean_mpn, gtin, mpn, category, source)
         VALUES ($1, $2, $3, $4, $5, $6, 'Watches', 'manual') RETURNING id`,
        [
          `${SKU_PREFIX}${product.key}`,
          product.brand,
          product.name,
          product.gtin ?? product.mpn,
          product.gtin,
          product.mpn,
        ],
      );
      productIds.set(product.key, rows[0]!.id);
    }
  });

  async function cleanup(): Promise<void> {
    await query(
      `DELETE FROM scrape_run_items WHERE run_id IN (SELECT id FROM scrape_runs WHERE trigger LIKE 'tst-cat%')`,
    );
    await query(`DELETE FROM scrape_runs WHERE trigger LIKE 'tst-cat%'`);
    for (const table of ['alerts', 'price_observations', 'product_matches', 'fascia_prices']) {
      await query(
        `DELETE FROM ${table} WHERE product_id IN (SELECT id FROM products WHERE internal_sku LIKE $1)`,
        [`${SKU_PREFIX}%`],
      );
    }
    await query('DELETE FROM products WHERE internal_sku LIKE $1', [`${SKU_PREFIX}%`]);
    // competitor_urls and competitor_products go with the competitor.
    await query('DELETE FROM competitors WHERE slug LIKE $1', ['tst-cat%']);
  }

  beforeEach(async () => {
    if (!competitorId) return;
    await query(
      `DELETE FROM scrape_run_items WHERE run_id IN (SELECT id FROM scrape_runs WHERE trigger LIKE 'tst-cat%')`,
    );
    await query(`DELETE FROM scrape_runs WHERE trigger LIKE 'tst-cat%'`);
    const both = [[competitorId, blockedId]];
    await query('DELETE FROM alerts WHERE competitor_id = ANY($1)', both);
    await query('DELETE FROM price_observations WHERE competitor_id = ANY($1)', both);
    await query('DELETE FROM product_matches WHERE competitor_id = ANY($1)', both);
    await query('DELETE FROM competitor_products WHERE competitor_id = ANY($1)', both);
    await query('DELETE FROM competitor_urls WHERE competitor_id = ANY($1)', both);
    standIn.requests.length = 0;
    blockedSite.requests.length = 0;
  });

  after(async () => {
    await cleanup();
    if (standIn) await standIn.close();
    if (blockedSite) await blockedSite.close();
    await closePool();
  });

  async function fullRun(): Promise<number> {
    const run = await startRun({ trigger: 'tst-cat', mode: 'both', competitorId });
    for (let attempt = 0; attempt < 1200; attempt += 1) {
      const { rows } = await query<{ status: string }>('SELECT status FROM scrape_runs WHERE id = $1', [run.id]);
      if (rows[0] && rows[0].status !== 'running') return run.id;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`run ${run.id} did not finish within 60s`);
  }

  async function matchFor(key: string): Promise<{ status: string; competitor_url: string; match_tier: string } | null> {
    const { rows } = await query<{ status: string; competitor_url: string; match_tier: string }>(
      'SELECT status, competitor_url, match_tier FROM product_matches WHERE product_id = $1 AND competitor_id = $2',
      [productIds.get(key), competitorId],
    );
    return rows[0] ?? null;
  }

  async function pricesFor(key: string): Promise<number[]> {
    const { rows } = await query<{ price: string }>(
      'SELECT price FROM price_observations WHERE product_id = $1 AND competitor_id = $2 ORDER BY id',
      [productIds.get(key), competitorId],
    );
    return rows.map((row) => Number(row.price));
  }

  it('reads every product page in the sitemap once, and nothing that is not a product', async () => {
    await fullRun();

    for (const handle of ['gtin', 'mpn', 'own', 'other', 'gone']) {
      assert.equal(standIn.hits(handle), 1, `${handle} should have been read exactly once`);
    }
    assert.ok(
      !standIn.requests.includes('/watches/divers'),
      'a sitemap URL that does not match productUrlPattern must not be requested',
    );

    const { rows } = await query<{ url: string; status: string; gtin: string | null; mpn: string | null; price: string | null }>(
      'SELECT url, status, gtin, mpn, price FROM competitor_products WHERE competitor_id = $1',
      [competitorId],
    );
    const byUrl = new Map(rows.map((row) => [row.url, row]));
    assert.equal(rows.length, 5);
    assert.equal(byUrl.get(standIn.urlFor('gtin'))?.gtin, '7020000000011');
    assert.equal(byUrl.get(standIn.urlFor('mpn'))?.mpn, '220.13.41-21');
    assert.equal(Number(byUrl.get(standIn.urlFor('other'))?.price), 400);
    assert.equal(byUrl.get(standIn.urlFor('gone'))?.status, 'gone');
  });

  it('matches on the barcode and prices the match without a second request', async () => {
    await fullRun();

    const match = await matchFor('gtin');
    assert.equal(match?.status, 'confirmed');
    assert.equal(match?.match_tier, 'ean_mpn_exact');
    assert.equal(match?.competitor_url, standIn.urlFor('gtin'));
    assert.deepEqual(await pricesFor('gtin'), [1000]);
    assert.equal(standIn.hits('gtin'), 1, 'the price must come from the page already read');
  });

  it('matches on the manufacturer reference when that is all we hold, whatever the punctuation', async () => {
    await fullRun();

    const match = await matchFor('mpn');
    assert.equal(match?.status, 'confirmed');
    assert.equal(match?.match_tier, 'ean_mpn_exact');
    assert.deepEqual(await pricesFor('mpn'), [2000]);
  });

  it("does not treat a retailer's own stock code as a different product", async () => {
    await fullRun();

    // Our barcode against a page that publishes only their stock code is no
    // evidence either way — so it is scored on its title like any other
    // candidate, never rejected on the identifier gate.
    const { rows } = await query<{ evidence: { gatesFailed?: string[] }; status: string }>(
      'SELECT evidence, status FROM product_matches WHERE product_id = $1 AND competitor_id = $2',
      [productIds.get('own'), competitorId],
    );
    assert.equal(rows.length, 1, 'the title match should have been stored');
    assert.deepEqual(rows[0]!.evidence.gatesFailed ?? [], []);
  });

  it('stores nothing for a product the competitor does not list', async () => {
    await fullRun();
    assert.equal(await matchFor('unlisted'), null);
  });

  it('does not read the catalogue again the next night, only the matched pages for their price', async () => {
    await fullRun();
    standIn.requests.length = 0;
    await fullRun();

    // Unmatched pages were read moments ago and are not due again.
    assert.equal(standIn.hits('other'), 0);
    assert.equal(standIn.hits('gone'), 0);
    // A confirmed match is re-read for today's price.
    assert.equal(standIn.hits('gtin'), 1);
    assert.deepEqual(await pricesFor('gtin'), [1000, 1000]);
  });

  it('gives up on a competitor that refuses five pages in a row', async () => {
    const { rows } = await query<Parameters<typeof harvestCatalogue>[0]>(
      'SELECT * FROM competitors WHERE id = $1',
      [blockedId],
    );
    // Seed the URL cache the way a sitemap refresh would.
    for (let index = 0; index < 7; index += 1) {
      await query(
        `INSERT INTO competitor_urls (competitor_id, url, slug) VALUES ($1, $2, $3)`,
        [blockedId, blockedSite.urlFor(`b${index}`), `blocked watch ${index}`],
      );
    }

    const result = await harvestCatalogue(rows[0]!);

    assert.equal(result.stopped, 'blocked');
    assert.equal(result.attempted, 5);
    assert.equal(blockedSite.requests.length, 5, 'pages after the fifth refusal must not be requested');
    assert.match(result.detail ?? '', /refused 5 pages in a row/);
  });
});
