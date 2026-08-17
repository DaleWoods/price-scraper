import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Product } from '../src/domain/types.ts';
import { rejectionReason } from '../src/matching/discovery.ts';
import { scoreCandidate } from '../src/matching/score.ts';

/**
 * Coverage for turning a rejected score into a sentence a person can act on.
 *
 * This is the message a test run shows when a candidate was found and opened
 * but nothing was stored — the case that used to read as a bare "0 candidate(s)
 * stored" with no way to tell a genuine absence from a rejected listing.
 */

function watch(overrides: Partial<Product> = {}): Product {
  return {
    id: 1,
    internal_sku: 'GS-12345',
    brand: 'Tissot',
    product_name: 'PR100 Chronograph 40mm Mens Watch Blue',
    ean_mpn: 'T1504171104100',
    our_price: 355,
    currency: 'GBP',
    category: 'watches',
    our_product_url: null,
    specs: {},
    created_at: '',
    updated_at: '',
    ...overrides,
  } as Product;
}

describe('rejectionReason', () => {
  it('names the brand gate when the listing does not identify the brand', () => {
    const product = watch();
    const scored = scoreCandidate(product, {
      url: 'https://example.test/p/pr100-chronograph-blue',
      title: 'PR100 Chronograph 40mm Blue Dial',
      // No brand field, and "Tissot" appears nowhere in the title — the
      // reported case exactly.
    });
    assert.equal(scored.viable, false);
    assert.match(rejectionReason(scored), /does not identify the brand as ours/);
  });

  it('names a differing gate attribute other than brand', () => {
    const product = watch({ category: 'rings', specs: { metal: '18ct Gold' } });
    const scored = scoreCandidate(product, {
      url: 'https://example.test/p/ring',
      title: 'Tissot Solitaire Ring',
      brand: 'Tissot',
      attributes: { metal: 'Silver' },
    });
    assert.equal(scored.viable, false);
    assert.match(rejectionReason(scored), /metal.*does not agree with ours/);
  });

  it('reports a differing EAN when the competitor publishes a different one', () => {
    const product = watch();
    const scored = scoreCandidate(product, {
      url: 'https://example.test/p/pr100',
      title: 'Tissot PR100 Chronograph',
      brand: 'Tissot',
      ean: '9999999999999',
    });
    assert.equal(scored.viable, false);
    assert.match(rejectionReason(scored), /differs from ours/);
  });

  it('falls back to the confidence score when nothing failed a gate outright', () => {
    const product = watch();
    const scored = scoreCandidate(product, {
      url: 'https://example.test/p/something-else',
      title: 'Completely unrelated listing',
      brand: 'Tissot',
    });
    assert.equal(scored.viable, false);
    assert.match(rejectionReason(scored), /scored \d+% confidence, below the \d+% needed/);
  });
});
