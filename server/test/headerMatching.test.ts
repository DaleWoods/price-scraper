import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { detectDelimiter, detectFormat, normaliseHeader } from '../src/import/parseTabular.ts';
import { planHeaders } from '../src/import/catalogueImport.ts';

describe('normaliseHeader', () => {
  it('strips the decorations hybris Backoffice adds', () => {
    // These exact headings came back in a failed import.
    assert.equal(normaliseHeader('Article Number*^'), 'article number');
    assert.equal(normaliseHeader('Identifier[en]'), 'identifier');
    assert.equal(normaliseHeader('Supercategories†'), 'supercategories');
    assert.equal(normaliseHeader('Catalog version*^'), 'catalog version');
  });

  it('still normalises ordinary separators', () => {
    assert.equal(normaliseHeader('internal_sku'), 'internal sku');
    assert.equal(normaliseHeader('  Product   Name  '), 'product name');
    assert.equal(normaliseHeader('Manufacturer-Name'), 'manufacturer name');
  });

  it('leaves meaningful punctuation alone', () => {
    assert.equal(normaliseHeader('EAN/MPN'), 'ean/mpn');
  });
});

describe('planHeaders — the failing Backoffice export', () => {
  const headers = [
    'Article Number*^',
    'EAN',
    'Identifier[en]',
    'MPN',
    'Manufacturer',
    'Supercategories†',
    'Catalog version*^',
  ];
  const filled = new Map(headers.map((header) => [header, 5]));

  it('recognises the SKU, name and brand columns it previously rejected', () => {
    const plan = planHeaders(headers, filled);
    assert.equal(plan.mapping.internal_sku, 'Article Number*^');
    assert.equal(plan.mapping.product_name, 'Identifier[en]');
    assert.equal(plan.mapping.manufacturer, 'Manufacturer');
  });

  it('still finds the identifiers used for matching', () => {
    const plan = planHeaders(headers, filled);
    assert.ok([plan.mapping.ean_mpn].includes('EAN') || [plan.mapping.ean_mpn].includes('MPN'));
  });
});

describe('planHeaders — alias priority', () => {
  it('prefers an explicit SKU column over a generic Code column', () => {
    const headers = ['Code', 'SKU', 'Name'];
    const plan = planHeaders(headers, new Map(headers.map((h) => [h, 3])));
    assert.equal(plan.mapping.internal_sku, 'SKU');
  });

  it('falls back to Code when that is all there is', () => {
    const headers = ['Code', 'Name'];
    const plan = planHeaders(headers, new Map(headers.map((h) => [h, 3])));
    assert.equal(plan.mapping.internal_sku, 'Code');
  });

  it('prefers a page title over an identifier for the product name', () => {
    const headers = ['SKU', 'Page Title', 'Identifier[en]'];
    const plan = planHeaders(headers, new Map(headers.map((h) => [h, 3])));
    assert.equal(plan.mapping.product_name, 'Page Title');
  });
});

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
