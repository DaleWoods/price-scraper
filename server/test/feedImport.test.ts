import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isDamagedIdentifier, isSaleWindowOpen, parseFeedPrice } from '../src/import/feedImport.ts';

describe('parseFeedPrice', () => {
  it('reads the Google feed format', () => {
    assert.deepEqual(parseFeedPrice('1900.0 GBP'), { amount: 1900, currency: 'GBP' });
    assert.deepEqual(parseFeedPrice('445.00 GBP'), { amount: 445, currency: 'GBP' });
    assert.deepEqual(parseFeedPrice('1,250.50 GBP'), { amount: 1250.5, currency: 'GBP' });
  });

  it('accepts a bare amount with no currency', () => {
    assert.deepEqual(parseFeedPrice('1900'), { amount: 1900, currency: null });
  });

  it('rejects anything unusable', () => {
    assert.equal(parseFeedPrice(''), null);
    assert.equal(parseFeedPrice('POA'), null);
    assert.equal(parseFeedPrice('call for price GBP'), null);
  });
});

describe('isDamagedIdentifier', () => {
  it('spots the scientific notation Excel leaves behind', () => {
    // 263 of the 266 GTINs in the supplied feed look like this.
    assert.equal(isDamagedIdentifier('7.32E+11'), true);
    assert.equal(isDamagedIdentifier('4.50013E+11'), true);
    assert.equal(isDamagedIdentifier('5E+12'), true);
  });

  it('leaves real identifiers alone', () => {
    assert.equal(isDamagedIdentifier('7320000000123'), false);
    assert.equal(isDamagedIdentifier('6161 WG'), false, 'a real MPN with a space');
    assert.equal(isDamagedIdentifier('M116503-0001'), false);
    assert.equal(isDamagedIdentifier(''), false);
  });
});

describe('isSaleWindowOpen', () => {
  const now = new Date('2026-08-09T12:00:00Z');

  it('treats an absent window as no restriction', () => {
    assert.equal(isSaleWindowOpen('', now), true);
    assert.equal(isSaleWindowOpen(undefined, now), true);
  });

  it('accepts a window that is currently open', () => {
    assert.equal(
      isSaleWindowOpen('2026-08-01T00:00:00Z/2026-08-31T23:59:59Z', now),
      true,
    );
  });

  it('rejects a sale that has not started', () => {
    // The feed carries scheduled promotions; applying one early would report us
    // cheaper than we actually are.
    assert.equal(isSaleWindowOpen('2026-09-01T00:00:00Z/2026-09-30T00:00:00Z', now), false);
  });

  it('rejects a sale that has finished', () => {
    assert.equal(isSaleWindowOpen('2026-07-01T00:00:00Z/2026-07-31T00:00:00Z', now), false);
  });

  it('handles the offset timestamps Google publishes', () => {
    assert.equal(
      isSaleWindowOpen('2026-08-01T17:00:00-03:00/2026-08-27T05:00:00-03:00', now),
      true,
    );
  });

  it('ignores an unparseable window rather than dropping the sale', () => {
    assert.equal(isSaleWindowOpen('not-a-date/also-not', now), true);
  });

  it('copes with only one side of the range given', () => {
    assert.equal(isSaleWindowOpen('2026-08-01T00:00:00Z/', now), true);
    assert.equal(isSaleWindowOpen('2026-09-01T00:00:00Z/', now), false);
  });
});
