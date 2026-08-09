import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { detectDelimiter, detectFormat } from '../src/import/parseTabular.ts';

describe('detectFormat', () => {
  it('recognises a zip-based workbook whatever the extension', () => {
    assert.equal(detectFormat(Buffer.from('PK\x03\x04rest')), 'xlsx');
  });

  it('recognises the legacy OLE2 binary .xls', () => {
    const ole = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0x00]);
    assert.equal(detectFormat(ole), 'legacy-xls');
  });

  it('recognises an HTML table masquerading as a spreadsheet', () => {
    assert.equal(detectFormat(Buffer.from('<html><table><tr>')), 'html');
  });

  it('treats anything else as delimited text', () => {
    assert.equal(detectFormat(Buffer.from('sku,name\n123,thing')), 'text');
  });
});

describe('detectDelimiter', () => {
  it('finds tabs in a tab-separated export saved as .xls', () => {
    assert.equal(detectDelimiter('sku\tname\tprice\n1\ta\t2'), '\t');
  });

  it('finds semicolons in a European-locale export', () => {
    assert.equal(detectDelimiter('sku;name;price'), ';');
  });

  it('defaults to a comma', () => {
    assert.equal(detectDelimiter('sku,name,price'), ',');
    assert.equal(detectDelimiter('single'), ',');
  });
});
