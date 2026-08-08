import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  deriveBrandFromCategory,
  deriveCategory,
  planHeaders,
  specsFromText,
} from '../src/import/catalogueImport.ts';
import { rulesForCategory } from '../src/matching/attributes.ts';

/** Build the fill-count map planHeaders expects. */
const fills = (entries: Record<string, number>) => new Map(Object.entries(entries));

describe('column planning for a SAP master loadsheet', () => {
  it('prefers a populated MPN column over an EAN column that is present but empty', () => {
    const { map, ignored } = planHeaders(
      ['SKU', 'MPN', 'EAN'],
      fills({ SKU: 66, MPN: 66, EAN: 0 }),
    );

    assert.equal(map.get('MPN'), 'ean_mpn');
    assert.ok(ignored.some((i) => i.column === 'EAN' && i.reason.includes('empty')));
  });

  it('prefers Page Title over Name, because Name repeats across variants', () => {
    const { map } = planHeaders(
      ['SKU', 'Name', 'Page Title'],
      fills({ SKU: 66, Name: 66, 'Page Title': 66 }),
    );

    assert.equal(map.get('Page Title'), 'product_name');
    // The runner-up is kept as an attribute rather than thrown away.
    assert.equal(map.get('Name'), 'spec:name');
  });

  it('does not treat Manufacturer Name as the brand', () => {
    const { map } = planHeaders(
      ['SKU', 'Manufacturer Name', 'Categories'],
      fills({ SKU: 66, 'Manufacturer Name': 66, Categories: 66 }),
    );

    assert.equal(map.get('Manufacturer Name'), 'manufacturer');
    assert.notEqual(map.get('Manufacturer Name'), 'brand');
  });

  it('drops double-encoded locale duplicate columns', () => {
    const mangled = 'Name ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬ ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢';
    const { map, ignored } = planHeaders(['SKU', mangled], fills({ SKU: 66, [mangled]: 66 }));

    assert.equal(map.has(mangled), false);
    assert.ok(ignored.some((i) => i.reason.includes('unreadable')));
  });

  it('drops site-configuration and marketing columns rather than storing them as attributes', () => {
    const headers = ['SKU', 'Description', 'Meta Keywords', 'Display On Site', 'Approved'];
    const { map, ignored } = planHeaders(
      headers,
      fills({ SKU: 66, Description: 66, 'Meta Keywords': 66, 'Display On Site': 66, Approved: 66 }),
    );

    for (const junk of ['Description', 'Meta Keywords', 'Display On Site', 'Approved']) {
      assert.equal(map.has(junk), false, `${junk} should not be imported`);
    }
    assert.equal(ignored.filter((i) => i.reason.includes('not a product attribute')).length, 4);
  });

  it('still accepts a conventional export where Brand and Price exist', () => {
    const { map } = planHeaders(
      ['SKU', 'Brand', 'Product Name', 'Our Price', 'Dial Colour'],
      fills({ SKU: 8, Brand: 8, 'Product Name': 8, 'Our Price': 8, 'Dial Colour': 8 }),
    );

    assert.equal(map.get('Brand'), 'brand');
    assert.equal(map.get('Our Price'), 'our_price');
    assert.equal(map.get('Dial Colour'), 'spec:dial_colour');
  });
});

describe('deriving brand and category from a category path', () => {
  it('strips the product-type suffix to leave the marque', () => {
    assert.equal(deriveBrandFromCategory('Rolex Watches, Rolex Cosmograph Daytona'), 'Rolex');
    assert.equal(deriveBrandFromCategory('TAG Heuer Watches'), 'TAG Heuer');
    assert.equal(deriveBrandFromCategory('Goldsmiths Rings, Engagement'), 'Goldsmiths');
  });

  it('maps a category path onto a canonical product type', () => {
    assert.equal(deriveCategory('Rolex Watches, Rolex Cosmograph Daytona'), 'watches');
    assert.equal(deriveCategory('Engagement Rings'), 'rings');
    assert.equal(deriveCategory('Necklaces & Pendants'), 'necklaces');
    assert.equal(deriveCategory('Gifts'), 'gifts');
  });

  it('classifies watch winders as accessories, not watches', () => {
    assert.equal(deriveCategory('Watch Winders'), 'watch winders');
    const rules = rulesForCategory('watch winders');
    assert.ok(!rules.high.includes('dial_colour'), 'a winder has no dial');
    assert.ok(rules.high.includes('model'));
  });
});

describe('specsFromText', () => {
  it('reads case size and metal out of a structured page title', () => {
    const specs = specsFromText('Rolex Cosmograph Daytona Oyster, 40 mm, Oystersteel and yellow gold M116503-0001');
    assert.equal(specs.case_size, '40mm');
    assert.equal(specs.case_material, 'Oystersteel');
  });

  it('reads carat weight from a jewellery title', () => {
    const specs = specsFromText('18ct White Gold Diamond Halo Ring 0.75ct');
    assert.equal(specs.carat_weight, '0.75ct');
    assert.equal(specs.case_material, 'White Gold');
  });

  it('returns nothing when the title carries no attributes', () => {
    assert.deepEqual(specsFromText('Gift Card'), {});
  });
});
