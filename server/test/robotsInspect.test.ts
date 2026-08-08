import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { extractDisallowRules } from '../src/scraping/robots.ts';

const UA = 'PriceMonitorBot/0.1';

describe('extractDisallowRules', () => {
  it('reads the rules for the wildcard agent', () => {
    // The shape a retail robots.txt actually takes: search closed, product
    // pages open, because they want those indexed.
    const body = `
User-agent: *
Disallow: /search
Disallow: /checkout
Disallow: /*?q=
Allow: /products/

Sitemap: https://example.co.uk/sitemap.xml
`;
    assert.deepEqual(extractDisallowRules(body, UA), ['/search', '/checkout', '/*?q=']);
  });

  it('picks up a block naming our agent specifically', () => {
    const body = `
User-agent: *
Disallow: /search

User-agent: PriceMonitorBot
Disallow: /
`;
    const rules = extractDisallowRules(body, UA);
    assert.ok(rules.includes('/'), 'a targeted block must be visible');
  });

  it('ignores rules for other named agents', () => {
    const body = `
User-agent: AhrefsBot
Disallow: /

User-agent: *
Disallow: /search
`;
    assert.deepEqual(extractDisallowRules(body, UA), ['/search']);
  });

  it('strips comments and blank lines', () => {
    const body = `
# our rules
User-agent: *   # everyone
Disallow: /search   # no internal search

Disallow:
`;
    assert.deepEqual(extractDisallowRules(body, UA), ['/search']);
  });

  it('does not repeat a rule listed twice', () => {
    const body = 'User-agent: *\nDisallow: /search\nDisallow: /search\n';
    assert.deepEqual(extractDisallowRules(body, UA), ['/search']);
  });

  it('returns nothing for a permissive file', () => {
    assert.deepEqual(extractDisallowRules('User-agent: *\nAllow: /\n', UA), []);
  });
});
