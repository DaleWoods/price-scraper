import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { diagnoseBlock } from '../src/scraping/blockDiagnosis.js';
import {
  UnblockerBudget,
  buildRequest,
  isWorthUnblocking,
  unblockerStatus,
} from '../src/scraping/unblocker.js';

/**
 * These tests are about not spending money.
 *
 * The paid backend is the one part of this app with a per-request cost, so the
 * guards that decide whether to reach for it matter more than the fetch
 * itself. Every case below is one where an unguarded implementation would bill
 * for a request that could not have worked.
 */
describe('unblocker guards', () => {
  describe('isWorthUnblocking', () => {
    it('pays for the walls a backend can actually get past', () => {
      assert.equal(isWorthUnblocking(diagnoseBlock({ status: 403, headers: { 'cf-ray': 'x' } })), true);
      assert.equal(isWorthUnblocking(diagnoseBlock({ status: 403 })), true);
    });

    it('refuses to pay for a rate limit, which is ours to fix by slowing down', () => {
      const rateLimited = diagnoseBlock({ status: 429, headers: { 'retry-after': '60' } });
      assert.equal(rateLimited.cause, 'rate_limited');
      assert.equal(isWorthUnblocking(rateLimited), false);
    });

    it('refuses to pay for a block no backend can clear', () => {
      // Paying for these buys a request that cannot succeed, every time.
      assert.equal(isWorthUnblocking(diagnoseBlock({ status: 451 })), false);
      assert.equal(isWorthUnblocking(diagnoseBlock({ status: 401 })), false);
    });

    it('refuses to pay when there is no diagnosis at all', () => {
      // An unclassified failure is not a licence to start spending.
      assert.equal(isWorthUnblocking(undefined), false);
      assert.equal(isWorthUnblocking(diagnoseBlock({ status: 418 })), false);
    });
  });

  describe('UnblockerBudget', () => {
    it('hands out exactly the calls it was given and no more', () => {
      const budget = new UnblockerBudget(2);
      assert.equal(budget.take(), true);
      assert.equal(budget.take(), true);
      assert.equal(budget.take(), false);
      assert.equal(budget.spent, 2, 'a refused call must not be counted as spent');
      assert.equal(budget.exhausted, true);
    });

    it('is exhausted from the start when the ceiling is zero', () => {
      // The setting that turns the paid path off without unsetting the key.
      const budget = new UnblockerBudget(0);
      assert.equal(budget.exhausted, true);
      assert.equal(budget.take(), false);
      assert.equal(budget.spent, 0);
    });

    it('counts a single allowance correctly, as the test-URL panel uses', () => {
      const budget = new UnblockerBudget(1);
      assert.equal(budget.take(), true);
      assert.equal(budget.take(), false);
    });
  });

  describe('configuration', () => {
    it('reports itself unconfigured when no provider is set', () => {
      // The default, and the state the app must work perfectly well in.
      const status = unblockerStatus();
      assert.equal(status.configured, false);
      assert.equal(status.provider, null);
      assert.ok(status.maxCallsPerRun > 0, 'a ceiling must always exist, even unconfigured');
    });
  });
});

/**
 * Request shapes, checked without a subscription.
 *
 * These four providers are not interchangeable — different auth schemes,
 * different places to put the target URL, different response envelopes. Getting
 * one wrong does not fail loudly at build time; it fails at runtime, per
 * request, while the meter runs.
 */
describe('provider request shapes', () => {
  const target = 'https://www.example.co.uk/product/a-watch?size=42';

  it('puts the target URL through ScrapingBee encoded, not raw', () => {
    const request = buildRequest('scrapingbee', 'KEY123', target, 'UA');
    const parsed = new URL(request.url);
    assert.equal(parsed.host, 'app.scrapingbee.com');
    // The query string of the target must not leak into ours — that would
    // silently fetch the wrong page.
    assert.equal(parsed.searchParams.get('url'), target);
    assert.equal(parsed.searchParams.get('api_key'), 'KEY123');
    assert.equal(request.init.method, 'GET');
  });

  it('passes ScraperAPI its key and target as query parameters', () => {
    const parsed = new URL(buildRequest('scraperapi', 'KEY123', target, 'UA').url);
    assert.equal(parsed.host, 'api.scraperapi.com');
    assert.equal(parsed.searchParams.get('url'), target);
    assert.equal(parsed.searchParams.get('api_key'), 'KEY123');
  });

  it('authenticates to Zyte with the key as a Basic username and empty password', () => {
    const request = buildRequest('zyte', 'KEY123', target, 'UA');
    const headers = request.init.headers as Record<string, string>;
    const encoded = Buffer.from('KEY123:').toString('base64');
    assert.equal(headers.authorization, `Basic ${encoded}`);
    assert.equal(request.init.method, 'POST');
    assert.equal(JSON.parse(request.init.body as string).url, target);
  });

  it('decodes the base64 body Zyte returns rather than using it raw', async () => {
    const request = buildRequest('zyte', 'KEY123', target, 'UA');
    const html = '<html><body>a price</body></html>';
    const body = await request.readBody({
      json: async () => ({ httpResponseBody: Buffer.from(html).toString('base64') }),
    } as unknown as Response);
    assert.equal(body, html);
  });

  it('authenticates to Bright Data with a bearer token and names a zone', () => {
    const request = buildRequest('brightdata', 'KEY123', target, 'UA');
    const headers = request.init.headers as Record<string, string>;
    assert.equal(headers.authorization, 'Bearer KEY123');
    const body = JSON.parse(request.init.body as string);
    assert.equal(body.url, target);
    assert.ok(body.zone, 'Bright Data addresses the unlocker by zone');
  });
});
