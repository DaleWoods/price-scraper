import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

/**
 * The alerts table has existed since the first migration with nothing writing
 * to it. This covers the part most likely to go wrong now that something
 * does: raising the same undercut twice must not duplicate, and a price that
 * recovers must resolve the alert rather than leave it open forever.
 *
 * Needs a database. Skipped when DATABASE_URL is unset, same as the other
 * DB-backed suites.
 */
const DATABASE_URL = process.env.DATABASE_URL;

describe('undercut alerts against a database', { skip: !DATABASE_URL && 'DATABASE_URL not set' }, () => {
  let query: typeof import('../src/db/pool.ts').query;
  let closePool: typeof import('../src/db/pool.ts').closePool;
  let syncUndercutAlerts: typeof import('../src/services/alerts.ts').syncUndercutAlerts;
  let resolveAlertsForPair: typeof import('../src/services/alerts.ts').resolveAlertsForPair;
  let resolveAllOpenAlerts: typeof import('../src/services/alerts.ts').resolveAllOpenAlerts;

  let productId: number;
  let competitorId: number;
  let fasciaId: number;
  const sku = 'tst-alert-90000001';

  before(async () => {
    ({ query, closePool } = await import('../src/db/pool.ts'));
    ({ syncUndercutAlerts, resolveAlertsForPair, resolveAllOpenAlerts } = await import(
      '../src/services/alerts.ts'
    ));

    const { rows: fasciaRows } = await query<{ id: number }>(
      'SELECT id FROM fascias WHERE enabled ORDER BY code LIMIT 1',
    );
    fasciaId = fasciaRows[0]!.id;

    const { rows: competitorRows } = await query<{ id: number }>(
      'SELECT id FROM competitors ORDER BY id LIMIT 1',
    );
    competitorId = competitorRows[0]!.id;

    await query('DELETE FROM products WHERE internal_sku = $1', [sku]);
    const { rows: productRows } = await query<{ id: number }>(
      `INSERT INTO products (internal_sku, brand, product_name, source)
       VALUES ($1, 'TestBrand', 'Alert Test Product', 'manual') RETURNING id`,
      [sku],
    );
    productId = productRows[0]!.id;

    await query('INSERT INTO fascia_prices (product_id, fascia_id, price) VALUES ($1, $2, 100.00)', [
      productId,
      fasciaId,
    ]);
  });

  after(async () => {
    await query('DELETE FROM products WHERE id = $1', [productId]);
    await closePool();
  });

  async function openAlerts() {
    const { rows } = await query<{ id: number; state: string; delta_abs: string }>(
      `SELECT id, state, delta_abs FROM alerts
       WHERE type = 'undercut' AND product_id = $1 AND competitor_id = $2 AND state = 'open'`,
      [productId, competitorId],
    );
    return rows;
  }

  it('raises an open alert when the competitor is cheaper', async () => {
    await syncUndercutAlerts(productId, competitorId, 90);
    const open = await openAlerts();
    assert.equal(open.length, 1);
    assert.equal(Number(open[0]!.delta_abs), 10);
  });

  it('does not duplicate the same open undercut on a later run', async () => {
    await syncUndercutAlerts(productId, competitorId, 91);
    const open = await openAlerts();
    assert.equal(open.length, 1, 'a second cheaper observation must not raise a second alert');
  });

  it('resolves the alert once the competitor is no longer cheaper', async () => {
    await syncUndercutAlerts(productId, competitorId, 150);
    const open = await openAlerts();
    assert.equal(open.length, 0);

    const { rows } = await query<{ state: string }>(
      `SELECT state FROM alerts
       WHERE type = 'undercut' AND product_id = $1 AND competitor_id = $2
       ORDER BY id DESC LIMIT 1`,
      [productId, competitorId],
    );
    assert.equal(rows[0]!.state, 'resolved');
  });

  it('raises a fresh alert for a new undercut after the old one resolved', async () => {
    await syncUndercutAlerts(productId, competitorId, 80);
    const open = await openAlerts();
    assert.equal(open.length, 1, 'resolution must not block a genuinely new undercut');
  });

  it('resolveAlertsForPair clears an open alert by hand, mirroring a manual delete', async () => {
    assert.equal((await openAlerts()).length, 1);
    await resolveAlertsForPair(productId, competitorId);
    assert.equal((await openAlerts()).length, 0);
  });

  it('resolveAllOpenAlerts resolves everything open, mirroring "clear comparisons"', async () => {
    await syncUndercutAlerts(productId, competitorId, 50);
    assert.equal((await openAlerts()).length, 1);
    const resolvedCount = await resolveAllOpenAlerts();
    assert.ok(resolvedCount >= 1);
    assert.equal((await openAlerts()).length, 0);
  });
});
