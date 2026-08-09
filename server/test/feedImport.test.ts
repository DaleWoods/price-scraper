import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isDamagedIdentifier, parseFeedPrice } from '../src/import/feedImport.ts';

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
