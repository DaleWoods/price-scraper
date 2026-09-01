import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

/**
 * Scrape health (Spec §3 — "success rate per competitor").
 *
 * The assertion this file exists for is the denominator one: most of our range
 * is not carried by most competitors, so `skipped` is the normal majority
 * outcome. Counting it as failure makes a perfectly healthy competitor read as
 * a few percent successful, and a report nobody believes is worse than no
 * report.
 *
 * Needs a database. Skipped when DATABASE_URL is unset so the unit suite still
 * runs anywhere, rather than failing for a missing service.
 */
const DATABASE_URL = process.env.DATABASE_URL;

describe('getScrapeHealth', { skip: !DATABASE_URL && 'DATABASE_URL not set' }, () => {
  let getScrapeHealth: typeof import('../src/services/scrapeHealth.ts').getScrapeHealth;
  let query: typeof import('../src/db/pool.ts').query;
  let closePool: typeof import('../src/db/pool.ts').closePool;

  const slug = 'tst-health-co';
  const quietSlug = 'tst-health-quiet';
  let competitorId = 0;
  let quietCompetitorId = 0;
  let runId = 0;

  before(async () => {
    ({ getScrapeHealth } = await import('../src/services/scrapeHealth.ts'));
    ({ query, closePool } = await import('../src/db/pool.ts'));

    await cleanup();

    const { rows } = await query<{ id: number }>(
      `INSERT INTO competitors (slug, display_name, base_url, search_url_pattern, enabled, config)
       VALUES ($1, 'Health Test Co', 'http://127.0.0.1:9', 'http://127.0.0.1:9/s?q={query}', TRUE, '{}'::jsonb)
       RETURNING id`,
      [slug],
    );
    competitorId = rows[0]!.id;

    const { rows: quiet } = await query<{ id: number }>(
      `INSERT INTO competitors (slug, display_name, base_url, search_url_pattern, enabled, config)
       VALUES ($1, 'Health Quiet Co', 'http://127.0.0.1:9', 'http://127.0.0.1:9/s?q={query}', TRUE, '{}'::jsonb)
       RETURNING id`,
      [quietSlug],
    );
    quietCompetitorId = quiet[0]!.id;

    const { rows: run } = await query<{ id: number }>(
      `INSERT INTO scrape_runs (trigger, status) VALUES ('tst-health', 'completed') RETURNING id`,
    );
    runId = run[0]!.id;

    // 3 ok, 2 real errors, 1 robots refusal, 20 skipped.
    // Attempts must come out as 6 (ok + error), never 26.
    const items: [string, string | null, number | null][] = [
      ['ok', null, 100],
      ['ok', null, 200],
      ['ok', null, 300],
      ['error', 'layout_changed', 400],
      ['error', 'blocked', 500],
      ['error', 'robots_disallowed', null],
      ...Array.from({ length: 20 }, () => ['skipped', 'not_listed', null] as [string, string, null]),
    ];

    for (const [status, kind, duration] of items) {
      await query(
        `INSERT INTO scrape_run_items (run_id, competitor_id, status, error_kind, error, duration_ms)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [runId, competitorId, status, kind, kind ? `${kind} happened` : null, duration],
      );
    }
  });

  async function cleanup(): Promise<void> {
    await query(`DELETE FROM scrape_run_items WHERE run_id IN
                 (SELECT id FROM scrape_runs WHERE trigger = 'tst-health')`);
    await query(`DELETE FROM scrape_runs WHERE trigger = 'tst-health'`);
    await query('DELETE FROM competitors WHERE slug = ANY($1)', [[slug, quietSlug]]);
  }

  after(async () => {
    await cleanup();
    await closePool();
  });

  async function subject() {
    const report = await getScrapeHealth(7);
    const entry = report.competitors.find((c) => c.competitorSlug === slug);
    assert.ok(entry, 'the seeded competitor must appear in the report');
    return entry;
  }

  it('counts only ok and error as attempts — a skip is not a failure', async () => {
    const entry = await subject();
    assert.equal(entry.attempts, 6, '3 ok + 3 error; the 20 skipped rows are not attempts');
    assert.equal(entry.skipped, 20);
  });

  it('reports a success rate against attempts, not against every item', async () => {
    const entry = await subject();
    // 3 ok of 6 attempts. Counting the skips would have given 3 of 26 = 11.5%.
    assert.equal(entry.successPct, 50);
  });

  it('separates a robots refusal from a genuine breakage', async () => {
    const entry = await subject();
    assert.equal(entry.robotsDisallowed, 1, 'honouring robots.txt is policy, not a fault');
    assert.equal(entry.errored, 3, 'it is still an error row, just an explicable one');
  });

  it('names what is failing, worst first', async () => {
    const entry = await subject();
    const kinds = entry.topErrors.map((e) => e.kind);
    assert.ok(kinds.includes('layout_changed'));
    assert.ok(kinds.includes('blocked'));
    assert.equal(
      entry.topErrors.reduce((sum, e) => sum + e.count, 0),
      3,
    );
  });

  it('reports a median duration from the items that recorded one', async () => {
    const entry = await subject();
    // Durations present: 100, 200, 300, 400, 500 → median 300.
    assert.equal(entry.medianDurationMs, 300);
  });

  it('keeps a competitor with no activity in the report, with a null rate', async () => {
    const report = await getScrapeHealth(7);
    const quiet = report.competitors.find((c) => c.competitorSlug === quietSlug);

    assert.ok(quiet, 'a quiet competitor must not vanish from the report — those matter most');
    assert.equal(quiet.attempts, 0);
    assert.equal(
      quiet.successPct,
      null,
      'never attempted is not the same as attempted and always failed',
    );
    assert.equal(quiet.medianDurationMs, null);
    assert.equal(quiet.competitorId, quietCompetitorId);
  });

  it('excludes activity outside the window', async () => {
    await query(
      `UPDATE scrape_run_items SET created_at = now() - interval '400 days' WHERE run_id = $1`,
      [runId],
    );
    try {
      const entry = await subject();
      assert.equal(entry.attempts, 0, 'a 7-day window must not see year-old items');
      assert.equal(entry.successPct, null);
    } finally {
      await query(`UPDATE scrape_run_items SET created_at = now() WHERE run_id = $1`, [runId]);
    }
  });
});
