import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseSkuList } from '../src/skuList.ts';

describe('parseSkuList', () => {
  it('reads a plain list, one per line, dropping blanks and repeats', () => {
    assert.deepEqual(parseSkuList('37538618\n\n7612586304941\r\n37538618\nWSSA0086\n'), [
      '37538618',
      '7612586304941',
      'WSSA0086',
    ]);
  });

  it('reads values separated by commas or tabs', () => {
    assert.deepEqual(parseSkuList('A1, B2,C3\tD4'), ['A1', 'B2', 'C3', 'D4']);
  });

  it('drops the heading of a single-column file', () => {
    assert.deepEqual(parseSkuList('SKU\n37538618\n37538619'), ['37538618', '37538619']);
  });

  it('reads only the identifier columns of a feed export, not its titles and prices', () => {
    const feed = [
      'id\ttitle\tprice\tgtin\tmpn\tbrand',
      '37538618\tSeamaster Aqua Terra 41mm\t5600.00 GBP\t7612586304941\t220.13.41.21.10.001\tOMEGA',
      '37538619\tConquest 38mm\t1500.00 GBP\t\tL37204726\tLongines',
    ].join('\n');
    assert.deepEqual(parseSkuList(feed), [
      '37538618',
      '7612586304941',
      '220.13.41.21.10.001',
      '37538619',
      'L37204726',
    ]);
  });

  it('recognises common spellings of an identifier column in a CSV', () => {
    const csv = 'Product Name,Barcode,Manufacturer_Ref\n"Diver 42mm",7020000000011,"CB-DIVER-42"';
    assert.deepEqual(parseSkuList(csv), ['7020000000011', 'CB-DIVER-42']);
  });
});
