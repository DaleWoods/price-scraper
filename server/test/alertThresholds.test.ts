import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

/**
 * Alert thresholds and the two alert types beyond "undercut" (Spec §5.5).
 *
 * The load-bearing test here is the duplicate one. price_drop and listing_gone
 * are facts about a competitor's own listing, not about one of our sites, so
 * they carry fascia_id NULL — and Postgres treats NULLs as distinct in a unique
 * index, which means the original open-alert dedupe index does nothing for
 * them. Without the second partial index every run would raise another copy of
 * the same still-true alert.
 *
 * Needs a database. Skipped when DATABASE_URL is unset so the unit suite still
 * runs anywhere, rather than failing for a missing service.
 */
const DATABASE_URL = process.env.DATABASE_URL;

describe('alert thresholds and types', { skip: !DATABASE_URL && 'DATABASE_URL not set' }, () => {
  let alerts: typeof import('../src/services/alerts.ts');
  let settings: typeof import('../src/services/alertSettings.ts');
  let query: typeof import('../src/db/pool.ts').query;
  let closePool: typeof import('../src/db/pool.ts').closePool;

  const sku = 'tst-alert-90001';
  const slug = 'tst-alert-co';
  let productId = 0;
  let competitorId = 0;
  let fasciaId = 0;

  before(async () => {
    alerts = await import('../src/services/alerts.ts');
    settings = await import('../src/services/alertSettings.ts');
    ({ query, closePool } = await import('../src/db/pool.ts'));

    await cleanup();

    const { rows: product } = await query<{ id: number }>(
      `INSERT INTO products (internal_sku, brand, product_name, source)
       VALUES ($1, 'TestBrand', 'Alert Test Watch', 'manual') RETURNING id`,
      [sku],
    );
    productId = product[0]!.id;

    const { rows: competitor } = await query<{ id: number }>(
      `INSERT INTO competitors (slug, display_name, base_url, search_url_pattern, enabled, config)
       VALUES ($1, 'Alert Test Co', 'http://127.0.0.1:9', 'http://127.0.0.1:9/s?q={query}', TRUE, '{}'::jsonb)
       RETURNING id`,
      [slug],
    );
    competitorId = competitor[0]!.id;

    const { rows: fascia } = await query<{ id: number }>(
      'SELECT id FROM fascias WHERE enabled ORDER BY code LIMIT 1',
    );
    fasciaId = fascia[0]!.id;

    // Our price for this product: £100 at the first enabled fascia.
    await query(
      `INSERT INTO fascia_prices (product_id, fascia_id, price, currency)
       VALUES ($1, $2, 100, 'GBP')`,
      [productId, fasciaId],
    );
  });

  async function cleanup(): Promise<void> {
    await query('DELETE FROM alerts WHERE product_id IN (SELECT id FROM products WHERE internal_sku = $1)', [sku]);
    await query('DELETE FROM price_observations WHERE product_id IN (SELECT id FROM products WHERE internal_sku = $1)', [sku]);
    await query('DELETE FROM fascia_prices WHERE product_id IN (SELECT id FROM products WHERE internal_sku = $1)', [sku]);
    await query('DELETE FROM products WHERE internal_sku = $1', [sku]);
    await query('DELETE FROM competitors WHERE slug = $1', [slug]);
  }

  beforeEach(async () => {
    // Each case starts from no alerts, no observations and default settings.
    if (!productId) return;
    await query('DELETE FROM alerts WHERE product_id = $1', [productId]);
    await query('DELETE FROM price_observations WHERE product_id = $1', [productId]);
    await settings.updateAlertSettings({
      undercutMinPct: 0,
      undercutMinAbs: 0,
      priceDropEnabled: true,
      priceDropMinPct: 5,
      listingGoneEnabled: true,
    });
  });

  after(async () => {
    await settings.updateAlertSettings({
      undercutMinPct: 0,
      undercutMinAbs: 0,
      priceDropEnabled: true,
      priceDropMinPct: 5,
      listingGoneEnabled: true,
    });
    await cleanup();
    await closePool();
  });

  async function openAlerts(type?: string): Promise<{ type: string; message: string }[]> {
    const { rows } = await query<{ type: string; message: string }>(
      `SELECT type, message FROM alerts
       WHERE product_id = $1 AND state = 'open' AND ($2::text IS NULL OR type = $2)
       ORDER BY id`,
      [productId, type ?? null],
    );
    return rows;
  }

  /** Record an observation the way the runner does, so price_drop can see history. */
  async function observe(price: number, observedAt = 'now()'): Promise<void> {
    await query(
      `INSERT INTO price_observations
         (product_id, competitor_id, price, currency, in_stock, source_url, observed_at)
       VALUES ($1, $2, $3, 'GBP', TRUE, 'http://127.0.0.1:9/p', ${observedAt})`,
      [productId, competitorId, price],
    );
  }

  it('raises an undercut alert with the default thresholds of zero', async () => {
    await alerts.syncUndercutAlerts(productId, competitorId, 95);
    assert.equal((await openAlerts('undercut')).length, 1);
  });

  it('stays quiet when the undercut is below the percentage threshold', async () => {
    await settings.updateAlertSettings({ undercutMinPct: 10 });
    // £95 against our £100 is 5% — real, but not worth waking anyone for.
    await alerts.syncUndercutAlerts(productId, competitorId, 95);
    assert.equal((await openAlerts('undercut')).length, 0);
  });

  it('stays quiet when the undercut is below the absolute threshold', async () => {
    await settings.updateAlertSettings({ undercutMinAbs: 25 });
    await alerts.syncUndercutAlerts(productId, competitorId, 95);
    assert.equal((await openAlerts('undercut')).length, 0);
  });

  it('requires both thresholds to be met, not either', async () => {
    await settings.updateAlertSettings({ undercutMinPct: 2, undercutMinAbs: 50 });
    // 5% clears the percentage bar but £5 is far below the £50 one.
    await alerts.syncUndercutAlerts(productId, competitorId, 95);
    assert.equal((await openAlerts('undercut')).length, 0);
  });

  it('resolves an existing alert once the threshold is raised past it', async () => {
    await alerts.syncUndercutAlerts(productId, competitorId, 95);
    assert.equal((await openAlerts('undercut')).length, 1);

    await settings.updateAlertSettings({ undercutMinPct: 20 });
    await alerts.syncUndercutAlerts(productId, competitorId, 95);

    assert.equal(
      (await openAlerts('undercut')).length,
      0,
      'raising the bar should resolve what no longer qualifies, not strand it open',
    );
  });

  it('raises price_drop when a competitor cuts their own price far enough', async () => {
    await observe(200, "now() - interval '2 days'");
    await observe(150); // the run has already written the new observation
    await alerts.syncPriceDropAlert(productId, competitorId, 150);

    const raised = await openAlerts('price_drop');
    assert.equal(raised.length, 1);
    assert.match(raised[0]!.message, /25\.0%/);
  });

  it('ignores a price drop smaller than the configured percentage', async () => {
    await settings.updateAlertSettings({ priceDropMinPct: 10 });
    await observe(200, "now() - interval '2 days'");
    await observe(195);
    await alerts.syncPriceDropAlert(productId, competitorId, 195);

    assert.equal((await openAlerts('price_drop')).length, 0);
  });

  it('treats a first-ever observation as a sighting, not a drop from zero', async () => {
    await observe(150);
    await alerts.syncPriceDropAlert(productId, competitorId, 150);
    assert.equal((await openAlerts('price_drop')).length, 0);
  });

  it('ignores a price rise', async () => {
    await observe(100, "now() - interval '2 days'");
    await observe(200);
    await alerts.syncPriceDropAlert(productId, competitorId, 200);
    assert.equal((await openAlerts('price_drop')).length, 0);
  });

  /**
   * The reason the second partial unique index exists. Postgres treats NULLs as
   * distinct, so the original (type, product_id, competitor_id, fascia_id)
   * index does not dedupe rows with fascia_id NULL at all.
   */
  it('raises exactly one listing_gone however many runs report it', async () => {
    await alerts.raiseListingGoneAlert(productId, competitorId, 'the listing no longer exists');
    await alerts.raiseListingGoneAlert(productId, competitorId, 'the listing no longer exists');
    await alerts.raiseListingGoneAlert(productId, competitorId, 'the listing no longer exists');

    assert.equal(
      (await openAlerts('listing_gone')).length,
      1,
      'a still-true alert re-reported is not a new event',
    );
  });

  it('resolves listing_gone once the listing works again', async () => {
    await alerts.raiseListingGoneAlert(productId, competitorId, 'it is showing as out of stock');
    assert.equal((await openAlerts('listing_gone')).length, 1);

    await alerts.resolveListingGone(productId, competitorId);
    assert.equal((await openAlerts('listing_gone')).length, 0);
  });

  it('raises nothing when a type is switched off', async () => {
    await settings.updateAlertSettings({ listingGoneEnabled: false, priceDropEnabled: false });

    await alerts.raiseListingGoneAlert(productId, competitorId, 'gone');
    await observe(200, "now() - interval '2 days'");
    await observe(100);
    await alerts.syncPriceDropAlert(productId, competitorId, 100);

    assert.equal((await openAlerts('listing_gone')).length, 0);
    assert.equal((await openAlerts('price_drop')).length, 0);
  });

  it('keeps the three types independent of each other', async () => {
    await observe(200, "now() - interval '2 days'");
    await observe(50);
    await alerts.syncUndercutAlerts(productId, competitorId, 50);
    await alerts.syncPriceDropAlert(productId, competitorId, 50);
    await alerts.raiseListingGoneAlert(productId, competitorId, 'out of stock');

    const kinds = (await openAlerts()).map((a) => a.type).sort();
    assert.deepEqual(kinds, ['listing_gone', 'price_drop', 'undercut']);
  });
});
