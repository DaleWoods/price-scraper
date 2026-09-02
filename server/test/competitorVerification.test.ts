import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { Competitor } from '../src/domain/types.js';
import { verifyCompetitor } from '../src/services/competitorVerification.js';
import { standInConfig, startStandIn, type StandIn } from './helpers/standInCompetitor.js';

/**
 * The verification check is the thing that decides whether a competitor gets
 * switched on, so a wrong verdict is expensive in both directions: a false
 * "working" enables a source that silently records nothing, and a false
 * "refused us" throws away a usable competitor and starts a conversation about
 * paying for proxies we do not need.
 *
 * These run against a local stand-in retailer rather than the real web, so the
 * verdicts are checked against sites whose behaviour is known exactly.
 */
describe('verifyCompetitor', () => {
  let working: StandIn;
  let priceless: StandIn;
  let walled: StandIn;

  function competitorFor(standIn: StandIn, slug: string): Competitor {
    const { brands, config } = standInConfig();
    return {
      id: 1,
      slug,
      display_name: slug,
      base_url: standIn.origin,
      search_url_pattern: `${standIn.origin}/search?q={query}`,
      brands,
      enabled: false,
      has_logo: false,
      config,
    } as unknown as Competitor;
  }

  before(async () => {
    working = await startStandIn([
      { slug: 'a', name: 'Verify Watch Alpha', brand: 'TestBrand', price: '100.00' },
      { slug: 'b', name: 'Verify Watch Bravo', brand: 'TestBrand', price: '200.00' },
      { slug: 'c', name: 'Verify Watch Charlie', brand: 'TestBrand', price: '300.00' },
    ]);
    // Served happily, but with no readable price anywhere — a config problem,
    // not an access problem, and the two must not be confused.
    priceless = await startStandIn([
      { slug: 'a', name: 'Priceless Watch Alpha', brand: 'TestBrand' },
      { slug: 'b', name: 'Priceless Watch Bravo', brand: 'TestBrand' },
      { slug: 'c', name: 'Priceless Watch Charlie', brand: 'TestBrand' },
    ]);
    walled = await startStandIn([
      { slug: 'a', name: 'Walled Watch Alpha', brand: 'TestBrand', status: 403, challenge: true },
      { slug: 'b', name: 'Walled Watch Bravo', brand: 'TestBrand', status: 403, challenge: true },
      { slug: 'c', name: 'Walled Watch Charlie', brand: 'TestBrand', status: 403, challenge: true },
    ]);
  });

  after(async () => {
    await Promise.all([working?.close(), priceless?.close(), walled?.close()]);
  });

  it('says a readable site is ready, and shows the prices it read', async () => {
    const result = await verifyCompetitor(competitorFor(working, 'verify-ok'));

    assert.equal(result.verdict, 'ready');
    assert.ok(result.sitemap.urlsFound >= 3);

    const priced = result.samples.filter((sample) => sample.price != null);
    assert.ok(priced.length >= 2, 'one lucky page is not proof; the bar is two');
    // The prices have to come back so a person can compare them to the page —
    // a verdict nobody can check is a verdict nobody should trust.
    assert.ok(priced.every((sample) => typeof sample.price === 'number'));
    assert.ok(priced.every((sample) => sample.url.startsWith(working.origin)));
  });

  it('separates "we cannot read it" from "they will not let us in"', async () => {
    const result = await verifyCompetitor(competitorFor(priceless, 'verify-priceless'));

    // Nothing blocked us here. Calling this blocked would send someone off to
    // buy an unblocking service to fix a selector.
    assert.equal(result.verdict, 'needs_config');
    assert.equal(result.blockCause, null);
    assert.match(result.whatToDo, /config/i);
    assert.ok(result.robots.allowsProductPages);
  });

  it('reports a refusal as blocked, and names who refused', async () => {
    const result = await verifyCompetitor(competitorFor(walled, 'verify-walled'));

    assert.equal(result.verdict, 'blocked');
    assert.equal(result.blockCause, 'bot_challenge');
    assert.equal(result.blockVendor, 'Cloudflare');
    assert.match(result.headline, /Cloudflare/);
  });

  it('stops asking once a site has refused us', async () => {
    walled.requests.length = 0;
    await verifyCompetitor(competitorFor(walled, 'verify-walled'));
    // Three samples were available. Making a site that just said no say it
    // twice more is rude and tells us nothing new.
    assert.equal(walled.requests.length, 1);
  });

  it('reports an unreachable host without blaming the retailer', async () => {
    const dead = competitorFor(working, 'verify-dead');
    // Port 1 is reserved and nothing listens there.
    const unreachable = { ...dead, base_url: 'http://127.0.0.1:1' } as Competitor;

    const result = await verifyCompetitor(unreachable);
    assert.equal(result.verdict, 'unreachable');
    // The single most costly misreading available: a locked-down host looks
    // exactly like every retailer blocking us at once.
    assert.match(result.whatToDo, /own internet access/i);
  });

  it('rejects a malformed base URL as a config error, not a site problem', async () => {
    const broken = { ...competitorFor(working, 'verify-broken'), base_url: 'not a url' } as Competitor;
    const result = await verifyCompetitor(broken);
    assert.equal(result.verdict, 'unreachable');
    assert.match(result.whatToDo, /baseUrl/);
  });
});
