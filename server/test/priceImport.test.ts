import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parsePriceValue } from '../src/import/priceImport.ts';

describe('parsePriceValue', () => {
  it('reads the formats a price extract usually arrives in', () => {
    assert.equal(parsePriceValue('12500'), 12500);
    assert.equal(parsePriceValue('£12,500.00'), 12500);
    assert.equal(parsePriceValue(' 8995.50 '), 8995.5);
    assert.equal(parsePriceValue('£1,234'), 1234);
  });

  it('rejects anything that is not a usable amount', () => {
    assert.equal(parsePriceValue(''), null);
    assert.equal(parsePriceValue('POA'), null);
    assert.equal(parsePriceValue('n/a'), null);
    assert.equal(parsePriceValue('-50'), null, 'a negative price is never valid');
  });

  it('rounds to whole pence rather than carrying float noise', () => {
    assert.equal(parsePriceValue('10.005'), 10.01);
    assert.equal(parsePriceValue('19.999'), 20);
  });
});
