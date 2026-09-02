import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { diagnoseBlock, describeBlock } from '../src/scraping/blockDiagnosis.js';

/**
 * The value of this module is telling four different walls apart, because each
 * has a different remedy and three of the four are cheap to fix. A wrong
 * classification is worse than no classification: it sends someone off to buy
 * an unblocking subscription for what was a user-agent problem, or to keep
 * slowing down a scan against a gate that speed has nothing to do with.
 */
describe('diagnoseBlock', () => {
  it('reads a 429 as ours to fix, not a wall', () => {
    const result = diagnoseBlock({ status: 429, headers: { 'retry-after': '120' } });
    assert.equal(result.cause, 'rate_limited');
    assert.equal(result.retryAfterSeconds, 120);
    // The whole point: do not send someone to a vendor for a problem that is
    // one config value away from fixed.
    assert.equal(result.vendorWouldHelp, false);
  });

  it('understands a Retry-After given as a date rather than seconds', () => {
    const at = new Date(Date.now() + 90_000).toUTCString();
    const result = diagnoseBlock({ status: 429, headers: { 'Retry-After': at } });
    assert.equal(result.cause, 'rate_limited');
    assert.ok(result.retryAfterSeconds !== null);
    assert.ok(Math.abs(result.retryAfterSeconds! - 90) <= 2);
  });

  it('names Cloudflare from a header alone, with no body to read', () => {
    const result = diagnoseBlock({ status: 403, headers: { 'cf-ray': '8a1b2c3d4e5f' } });
    assert.equal(result.cause, 'bot_challenge');
    assert.equal(result.vendor, 'Cloudflare');
  });

  it('names DataDome from its challenge markup', () => {
    const result = diagnoseBlock({
      status: 403,
      html: '<html><body><script src="https://js.captcha-delivery.com/x.js"></script></body></html>',
    });
    assert.equal(result.cause, 'bot_challenge');
    assert.equal(result.vendor, 'DataDome');
  });

  it('separates a bare 403 from a challenge, because the remedy differs', () => {
    const bare = diagnoseBlock({ status: 403, html: '<html><body>Forbidden</body></html>' });
    assert.equal(bare.cause, 'ua_or_waf');
    assert.equal(bare.vendor, null);
    // The cheap thing to try first should be named in the remedy.
    assert.match(bare.remedy, /user agent|SCRAPER_USER_AGENT/i);

    const challenged = diagnoseBlock({
      status: 403,
      html: '<html><body>Checking your browser before accessing the site.</body></html>',
    });
    assert.equal(challenged.cause, 'bot_challenge');
  });

  it('spots a soft block: HTTP 200 hiding an interstitial', () => {
    const result = diagnoseBlock({
      status: 200,
      html: '<html><body>Please enable JavaScript and cookies to continue</body></html>',
      extractionFailed: true,
    });
    assert.equal(result.cause, 'soft_block');
  });

  it('does not call a healthy 200 a block just because extraction failed', () => {
    // The trap this guards: every redesign would otherwise be reported as a
    // block, and the team would go looking for an access problem instead of a
    // selector. A soft block needs challenge evidence, not just a failure.
    const result = diagnoseBlock({
      status: 200,
      html: '<html><body><h1>A watch</h1><p>Redesigned page, no price element</p></body></html>',
      extractionFailed: true,
    });
    assert.notEqual(result.cause, 'soft_block');
    assert.equal(result.vendorWouldHelp, false);
    assert.match(result.remedy, /layout change/i);
  });

  it('treats 451 as final, and does not offer a tool for it', () => {
    const result = diagnoseBlock({ status: 451 });
    assert.equal(result.cause, 'geo_or_legal');
    assert.equal(result.vendorWouldHelp, false);
  });

  it('keeps a login wall out of scope rather than suggesting a way in', () => {
    const result = diagnoseBlock({ status: 401 });
    assert.equal(result.cause, 'login_required');
    assert.equal(result.vendorWouldHelp, false);
  });

  it('says so plainly when it does not recognise the refusal', () => {
    // Guessing here is how a fixable config problem becomes a subscription.
    const result = diagnoseBlock({ status: 418, html: '<html></html>' });
    assert.equal(result.cause, 'unclassified');
    assert.equal(result.vendorWouldHelp, false);
  });

  it('survives having nothing but a status to go on', () => {
    const result = diagnoseBlock({ status: 403 });
    assert.equal(result.cause, 'ua_or_waf');
    assert.equal(result.retryAfterSeconds, null);
  });

  it('reads headers from a real Headers object as well as a plain record', () => {
    const headers = new Headers({ 'cf-ray': 'abc', 'retry-after': '30' });
    const result = diagnoseBlock({ status: 429, headers });
    assert.equal(result.retryAfterSeconds, 30);
    assert.equal(result.vendor, 'Cloudflare');
  });

  it('ignores a Retry-After it cannot make sense of', () => {
    const result = diagnoseBlock({ status: 429, headers: { 'retry-after': 'soonish' } });
    assert.equal(result.retryAfterSeconds, null);
  });

  it('describes a block as one line carrying both the what and the what-next', () => {
    const line = describeBlock(diagnoseBlock({ status: 403, headers: { 'cf-ray': 'x' } }));
    assert.match(line, /Cloudflare/);
    assert.ok(line.length > 40, 'a remedy should be part of the description, not just a label');
  });
});
