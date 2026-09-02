import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { startStandIn, standInConfig, type StandIn } from './helpers/standInCompetitor.ts';

/**
 * Coverage for the run orchestrator.
 *
 * runner.ts is the largest and most-modified file in the app — it gained
 * bounded competitor concurrency, changed its product scope from a scalar id
 * to an array with `= ANY($n::bigint[])` SQL, and changed when it reuses a
 * cached sitemap — and every one of those was verified by hand once and then
 * left unprotected.
 *
 * These are integration tests by necessity: competitors come from the database
 * and are reached over HTTP, with no injection seam, so the honest way to test
 * the orchestration is to give it a real (local) site to talk to.
 *
 * Three constraints shape everything below:
 *   1. `activeRunId` is module-level, so two runs can never overlap — every
 *      test awaits completion before the next begins, and all runner tests
 *      live in this one file.
 *   2. `startRun` is fire-and-forget: it returns as soon as the run row
 *      exists, so assertions must poll for the run to finish.
 *   3. A run scans every *enabled* competitor, so each run is scoped by
 *      competitorId — otherwise a real competitor left enabled in a dev
 *      database would send the tests out to the internet.
 */
const DATABASE_URL = process.env.DATABASE_URL;

describe('scrape runner', { skip: !DATABASE_URL && 'DATABASE_URL not set' }, () => {
  let startRun: typeof import('../src/scraping/runner.ts').startRun;
  let query: typeof import('../src/db/pool.ts').query;
  let closePool: typeof import('../src/db/pool.ts').closePool;

  let standIn: StandIn;
  let competitorId = 0;
  let brandLimitedId = 0;
  let fasciaId = 0;
  const productIds = new Map<string, number>();

  const SKU_PREFIX = 'tst-runner-';
  const SLUG = 'tst-runner-co';
  const BRAND_LIMITED_SLUG = 'tst-runner-brandco';

  /** Every product the stand-in serves, and how it behaves. */
  const CATALOGUE = [
    { slug: 'a', name: 'Runner Watch A', brand: 'TestBrand', price: '100.00', gtin: '7010000000001' },
    { slug: 'b', name: 'Runner Watch B', brand: 'TestBrand', price: '200.00', gtin: '7010000000002' },
    { slug: 'c', name: 'Runner Watch C', brand: 'TestBrand', price: '300.00', gtin: '7010000000003' },
    { slug: 'd', name: 'Runner Watch D', brand: 'TestBrand', status: 404 },
    { slug: 'e', name: 'Runner Watch E', brand: 'TestBrand', status: 403 },
    { slug: 'f', name: 'Runner Watch F', brand: 'TestBrand' }, // served, but no price
    { slug: 'g', name: 'Runner Watch G', brand: 'TestBrand', price: '400.00', inStock: false },
    { slug: 'h', name: 'Runner Watch H', brand: 'TestBrand', status: 403, challenge: true },
  ];

  before(async () => {
    ({ startRun } = await import('../src/scraping/runner.ts'));
    ({ query, closePool } = await import('../src/db/pool.ts'));

    await cleanup();
    standIn = await startStandIn(CATALOGUE);

    const open = standInConfig();
    const { rows: competitor } = await query<{ id: number }>(
      `INSERT INTO competitors (slug, display_name, base_url, search_url_pattern, brands, enabled, config)
       VALUES ($1, 'Runner Test Co', $2, $3, $4, TRUE, $5::jsonb) RETURNING id`,
      [SLUG, standIn.origin, `${standIn.origin}/search?q={query}`, open.brands, JSON.stringify(open.config)],
    );
    competitorId = competitor[0]!.id;

    // Stocks only a brand we do not sell, so every product should be skipped
    // before a single request is made.
    const limited = standInConfig(['SomeOtherBrand']);
    const { rows: brandCo } = await query<{ id: number }>(
      `INSERT INTO competitors (slug, display_name, base_url, search_url_pattern, brands, enabled, config)
       VALUES ($1, 'Runner Brand Co', $2, $3, $4, TRUE, $5::jsonb) RETURNING id`,
      [
        BRAND_LIMITED_SLUG,
        standIn.origin,
        `${standIn.origin}/search?q={query}`,
        limited.brands,
        JSON.stringify(limited.config),
      ],
    );
    brandLimitedId = brandCo[0]!.id;

    for (const entry of CATALOGUE) {
      const { rows } = await query<{ id: number }>(
        `INSERT INTO products (internal_sku, brand, product_name, ean_mpn, category, source)
         VALUES ($1, $2, $3, $4, 'Watches', 'manual') RETURNING id`,
        [`${SKU_PREFIX}${entry.slug}`, entry.brand, entry.name, entry.gtin ?? null],
      );
      productIds.set(entry.slug, rows[0]!.id);
    }

    const { rows: fascia } = await query<{ id: number }>(
      'SELECT id FROM fascias WHERE enabled ORDER BY code LIMIT 1',
    );
    fasciaId = fascia[0]!.id;
  });

  async function cleanup(): Promise<void> {
    await query(
      `DELETE FROM scrape_run_items WHERE run_id IN (SELECT id FROM scrape_runs WHERE trigger LIKE 'tst-runner%')`,
    );
    await query(`DELETE FROM scrape_runs WHERE trigger LIKE 'tst-runner%'`);
    await query(
      `DELETE FROM alerts WHERE product_id IN (SELECT id FROM products WHERE internal_sku LIKE $1)`,
      [`${SKU_PREFIX}%`],
    );
    await query(
      `DELETE FROM price_observations WHERE product_id IN (SELECT id FROM products WHERE internal_sku LIKE $1)`,
      [`${SKU_PREFIX}%`],
    );
    await query(
      `DELETE FROM product_matches WHERE product_id IN (SELECT id FROM products WHERE internal_sku LIKE $1)`,
      [`${SKU_PREFIX}%`],
    );
    await query(
      `DELETE FROM fascia_prices WHERE product_id IN (SELECT id FROM products WHERE internal_sku LIKE $1)`,
      [`${SKU_PREFIX}%`],
    );
    await query('DELETE FROM products WHERE internal_sku LIKE $1', [`${SKU_PREFIX}%`]);
    await query('DELETE FROM competitor_urls WHERE competitor_id IN (SELECT id FROM competitors WHERE slug LIKE $1)', [
      'tst-runner%',
    ]);
    await query('DELETE FROM competitors WHERE slug LIKE $1', ['tst-runner%']);
  }

  beforeEach(async () => {
    if (!competitorId) return;
    // Runs, items and observations are per-test; matches and cached URLs are
    // set up by whichever test needs them.
    await query(
      `DELETE FROM scrape_run_items WHERE run_id IN (SELECT id FROM scrape_runs WHERE trigger LIKE 'tst-runner%')`,
    );
    await query(`DELETE FROM scrape_runs WHERE trigger LIKE 'tst-runner%'`);
    await query('DELETE FROM price_observations WHERE competitor_id = ANY($1)', [
      [competitorId, brandLimitedId],
    ]);
    await query('DELETE FROM product_matches WHERE competitor_id = ANY($1)', [
      [competitorId, brandLimitedId],
    ]);
    await query('DELETE FROM alerts WHERE competitor_id = ANY($1)', [[competitorId, brandLimitedId]]);
    standIn.requests.length = 0;
  });

  after(async () => {
    await cleanup();
    if (standIn) await standIn.close();
    await closePool();
  });

  /* ---------- helpers ---------------------------------------------------- */

  type RunOptions = Parameters<typeof startRun>[0];

  /**
   * Start a run and wait for it to leave 'running'.
   *
   * Polls the run row rather than getActiveRunId(): the row is the contract,
   * and the in-memory flag is cleared in a `finally` that can win the race
   * against the final UPDATE.
   */
  async function runToCompletion(options: RunOptions): Promise<number> {
    const run = await startRun({ trigger: 'tst-runner', ...options });
    for (let attempt = 0; attempt < 1200; attempt += 1) {
      const { rows } = await query<{ status: string }>(
        'SELECT status FROM scrape_runs WHERE id = $1',
        [run.id],
      );
      if (rows[0] && rows[0].status !== 'running') return run.id;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    // Generous on purpose. env.minRequestDelayMs puts a 3s floor under every
    // request no matter what the competitor config says, so a run touching a
    // handful of pages legitimately takes tens of seconds. Timing out early
    // here does not just fail one test: the next beforeEach deletes the run
    // row out from under the still-running scrape, and the foreign key
    // violation that follows looks like a bug in the runner rather than an
    // impatient test.
    throw new Error(`run ${run.id} did not finish within 60s`);
  }

  interface ItemRow {
    product_id: number | null;
    status: string;
    error_kind: string | null;
    error: string | null;
  }

  async function itemsFor(runId: number): Promise<ItemRow[]> {
    const { rows } = await query<ItemRow>(
      'SELECT product_id, status, error_kind, error FROM scrape_run_items WHERE run_id = $1 ORDER BY id',
      [runId],
    );
    return rows;
  }

  async function confirmMatch(slug: string): Promise<void> {
    await query(
      `INSERT INTO product_matches
         (product_id, competitor_id, competitor_url, confidence, match_tier, status, confirmed_at, confirmed_by)
       VALUES ($1, $2, $3, 100, 'ean_mpn_exact', 'confirmed', now(), 'test')`,
      [productIds.get(slug), competitorId, standIn.urlFor(slug)],
    );
  }

  const id = (slug: string): number => productIds.get(slug)!;

  /* ---------- scope: which products a run looks at ------------------------ */

  it('scans exactly the products named in productIds, and no others', async () => {
    for (const slug of ['a', 'b', 'c']) await confirmMatch(slug);

    const runId = await runToCompletion({
      mode: 'prices',
      competitorId,
      productIds: [id('a'), id('c')],
    });

    const touched = (await itemsFor(runId)).map((item) => item.product_id).sort();
    assert.deepEqual(
      touched,
      [id('a'), id('c')].sort(),
      'a list scope must not leak into products that were not asked for',
    );
  });

  it('scans one product when productId is given, and records it on the run', async () => {
    await confirmMatch('a');
    await confirmMatch('b');

    const runId = await runToCompletion({ mode: 'prices', competitorId, productId: id('a') });

    const items = await itemsFor(runId);
    assert.equal(items.length, 1);
    assert.equal(items[0]!.product_id, id('a'));

    const { rows } = await query<{ product_id: number | null; product_count: number | null }>(
      'SELECT product_id, product_count FROM scrape_runs WHERE id = $1',
      [runId],
    );
    assert.equal(rows[0]!.product_id, id('a'), 'a single-product run points at that product');
    assert.equal(rows[0]!.product_count, null, 'and does not also claim a count');
  });

  it('records a count rather than a product id for a bulk list', async () => {
    for (const slug of ['a', 'b', 'c']) await confirmMatch(slug);

    const runId = await runToCompletion({
      mode: 'prices',
      competitorId,
      productIds: [id('a'), id('b'), id('c')],
    });

    const { rows } = await query<{ product_id: number | null; product_count: number | null }>(
      'SELECT product_id, product_count FROM scrape_runs WHERE id = $1',
      [runId],
    );
    assert.equal(rows[0]!.product_id, null, 'there is no single product to point at');
    assert.equal(rows[0]!.product_count, 3);
  });

  it('never scans a delisted product, even when it is named explicitly', async () => {
    await confirmMatch('a');
    await query('UPDATE products SET delisted_at = now() WHERE id = $1', [id('a')]);

    try {
      const runId = await runToCompletion({ mode: 'prices', competitorId, productIds: [id('a')] });
      assert.deepEqual(
        await itemsFor(runId),
        [],
        'a product no site sells any more is not worth re-pricing',
      );
    } finally {
      await query('UPDATE products SET delisted_at = NULL WHERE id = $1', [id('a')]);
    }
  });

  it('keeps the run counters consistent with the items it recorded', async () => {
    for (const slug of ['a', 'd', 'e']) await confirmMatch(slug);

    const runId = await runToCompletion({
      mode: 'prices',
      competitorId,
      productIds: [id('a'), id('d'), id('e')],
    });

    const items = await itemsFor(runId);
    const { rows } = await query<{ ok_count: number; error_count: number; skipped_count: number }>(
      'SELECT ok_count, error_count, skipped_count FROM scrape_runs WHERE id = $1',
      [runId],
    );
    const counters = rows[0]!;
    assert.equal(
      counters.ok_count + counters.error_count + counters.skipped_count,
      items.length,
      'the headline counters must add up to the rows behind them',
    );
    assert.equal(counters.ok_count, 1);
    assert.equal(counters.error_count, 2);
  });

  /* ---------- outcomes: how a run classifies what happened ---------------- */

  it('records a price for a confirmed match, with the transport that read it', async () => {
    await confirmMatch('a');

    const runId = await runToCompletion({ mode: 'prices', competitorId, productId: id('a') });

    const items = await itemsFor(runId);
    assert.equal(items[0]!.status, 'ok');

    const { rows } = await query<{ price: string; rendered_with: string; match_id: number | null }>(
      'SELECT price, rendered_with, match_id FROM price_observations WHERE scrape_run_id = $1',
      [runId],
    );
    assert.equal(Number(rows[0]!.price), 100);
    assert.equal(rows[0]!.rendered_with, 'http');
    assert.ok(rows[0]!.match_id, 'a priced observation is tied to the match it came from');
  });

  it('reports a listing that 404s as not_found', async () => {
    await confirmMatch('d');
    const runId = await runToCompletion({ mode: 'prices', competitorId, productId: id('d') });

    const item = (await itemsFor(runId))[0]!;
    assert.equal(item.status, 'error');
    assert.equal(item.error_kind, 'not_found');
  });

  it('treats an active block as blocked, and does not retry it', async () => {
    await confirmMatch('e');
    const runId = await runToCompletion({ mode: 'prices', competitorId, productId: id('e') });

    const item = (await itemsFor(runId))[0]!;
    assert.equal(item.status, 'error');
    assert.equal(item.error_kind, 'blocked');
    assert.equal(
      standIn.hits('e'),
      1,
      'a refusal is answered once — retrying it is working around a block',
    );
  });

  it('reports a page it cannot read a price from, rather than storing nothing quietly', async () => {
    await confirmMatch('f');
    const runId = await runToCompletion({ mode: 'prices', competitorId, productId: id('f') });

    const item = (await itemsFor(runId))[0]!;
    assert.equal(item.status, 'error');
    assert.equal(item.error_kind, 'no_price_found');

    const { rows } = await query('SELECT id FROM price_observations WHERE scrape_run_id = $1', [runId]);
    assert.equal(rows.length, 0, 'a page with no price must never produce an observation');
  });

  it('raises a listing_gone alert when a matched product is out of stock', async () => {
    await confirmMatch('g');
    const runId = await runToCompletion({ mode: 'prices', competitorId, productId: id('g') });

    // The scrape itself succeeded — an out-of-stock price is still a reading.
    assert.equal((await itemsFor(runId))[0]!.status, 'ok');

    const { rows } = await query<{ type: string }>(
      `SELECT type FROM alerts WHERE product_id = $1 AND competitor_id = $2 AND state = 'open'`,
      [id('g'), competitorId],
    );
    assert.deepEqual(rows.map((row) => row.type), ['listing_gone']);
  });

  it('skips a brand the competitor does not stock without making a request', async () => {
    const runId = await runToCompletion({
      mode: 'discover',
      competitorId: brandLimitedId,
      productIds: [id('a')],
    });

    const item = (await itemsFor(runId))[0]!;
    assert.equal(item.status, 'skipped');
    assert.equal(item.error_kind, 'brand_not_stocked');
    assert.equal(
      standIn.requests.length,
      0,
      'the brand gate must be applied before any network call, not after',
    );
  });

  it('finds and stores a candidate through discovery', async () => {
    const runId = await runToCompletion({
      mode: 'discover',
      competitorId,
      productIds: [id('a')],
      forceHarvest: true,
    });

    const item = (await itemsFor(runId))[0]!;
    assert.equal(item.status, 'ok');

    const { rows } = await query<{ status: string; competitor_url: string }>(
      'SELECT status, competitor_url FROM product_matches WHERE product_id = $1 AND competitor_id = $2',
      [id('a'), competitorId],
    );
    assert.ok(rows.length > 0, 'a matching sitemap URL should have produced a candidate');
    assert.ok(rows.some((row) => row.competitor_url.endsWith(standIn.pathFor('a'))));
  });

  it('explains itself when discovery finds nothing to match', async () => {
    // A product whose name resembles nothing in the stand-in's sitemap.
    const { rows: odd } = await query<{ id: number }>(
      `INSERT INTO products (internal_sku, brand, product_name, category, source)
       VALUES ($1, 'TestBrand', 'Entirely Unrelated Bracelet', 'Watches', 'manual') RETURNING id`,
      [`${SKU_PREFIX}zz`],
    );
    const oddId = odd[0]!.id;

    try {
      const runId = await runToCompletion({
        mode: 'discover',
        competitorId,
        productIds: [oddId],
        forceHarvest: true,
      });

      const item = (await itemsFor(runId))[0]!;
      // Either nothing resembled it (skipped/not_listed) or candidates were
      // opened and rejected (ok, with a reason) — both must carry an
      // explanation rather than a bare zero.
      assert.ok(['skipped', 'ok'].includes(item.status));
      assert.ok(item.error && item.error.length > 0, 'a nil result must say why');
    } finally {
      await query('DELETE FROM product_matches WHERE product_id = $1', [oddId]);
      await query('DELETE FROM products WHERE id = $1', [oddId]);
    }
  });

  it('completes rather than hanging when no competitor is enabled', async () => {
    await query('UPDATE competitors SET enabled = FALSE WHERE id = ANY($1)', [
      [competitorId, brandLimitedId],
    ]);
    try {
      // competitorId still names the (now disabled) competitor, so the run has
      // nothing to do at all.
      const runId = await runToCompletion({ mode: 'prices', competitorId });

      const { rows } = await query<{ status: string; error: string | null }>(
        'SELECT status, error FROM scrape_runs WHERE id = $1',
        [runId],
      );
      assert.equal(rows[0]!.status, 'completed');
      assert.match(rows[0]!.error ?? '', /No enabled competitors/);
    } finally {
      await query('UPDATE competitors SET enabled = TRUE WHERE id = ANY($1)', [
        [competitorId, brandLimitedId],
      ]);
    }
  });

  it('records what kind of wall a block was, not just that there was one', async () => {
    // "blocked" alone cannot be acted on. A Cloudflare challenge and a rate
    // limit are both blocks and have nothing in common as problems, so the
    // cause is what gets stored and reported.
    await confirmMatch('h');
    // 'prices' only: a 'both' run would also discover against this product and
    // add a second item, which has nothing to do with what is being asserted.
    const runId = await runToCompletion({
      competitorId,
      productIds: [productIds.get('h')!],
      mode: 'prices',
    });

    const items = await itemsFor(runId);
    assert.equal(items.length, 1);
    assert.equal(items[0]!.status, 'error');
    assert.equal(items[0]!.error_kind, 'blocked');

    const { rows } = await query<{ block_cause: string | null }>(
      'SELECT block_cause FROM scrape_run_items WHERE run_id = $1',
      [runId],
    );
    assert.equal(rows[0]!.block_cause, 'bot_challenge');
    // The remedy has to reach the person reading the run, not stop at the type.
    assert.match(items[0]!.error ?? '', /Cloudflare/);
  });

  it('does not retry a bot challenge, since nothing about a retry would differ', async () => {
    await confirmMatch('h');
    await runToCompletion({
      competitorId,
      productIds: [productIds.get('h')!],
      mode: 'prices',
    });
    assert.equal(standIn.hits('h'), 1);
  });

  it('refuses to start a second run while one is in flight', async () => {
    await confirmMatch('a');
    const first = startRun({ mode: 'prices', competitorId, productId: id('a'), trigger: 'tst-runner' });

    await assert.rejects(
      () => startRun({ mode: 'prices', competitorId, productId: id('b'), trigger: 'tst-runner' }),
      /already in progress/,
      'overlapping runs would double-scrape competitors and race the counters',
    );

    // Let the first finish so the guard clears before the next test.
    const run = await first;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const { rows } = await query<{ status: string }>(
        'SELECT status FROM scrape_runs WHERE id = $1',
        [run.id],
      );
      if (rows[0] && rows[0].status !== 'running') break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  });
});
