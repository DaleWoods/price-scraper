import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  isPricingKschl,
  isSaleKschl,
  pickByPrecedence,
  selectFasciaPrice,
  type FasciaDefinition,
  type LoadsheetRow,
} from '../src/import/priceSelection.ts';
import { parseLoadsheetDate, parsePrice } from '../src/import/loadsheetImport.ts';

const GOLDSMITHS: FasciaDefinition = {
  code: '197',
  name: 'Goldsmiths',
  salesOrg: 'GS01',
  distributionChannel: 'G1',
  priceListType: null,
};
const MAPPIN: FasciaDefinition = { ...GOLDSMITHS, code: '439', name: 'Mappin & Webb' };

let nextRow = 1;
function row(partial: Partial<LoadsheetRow> & { price: number }): LoadsheetRow {
  return {
    rowNumber: nextRow++,
    code: '17361430',
    kschl: 'VKP0',
    vkorg: 'GS01',
    vtweg: 'G1',
    werks: '-',
    pltyp: '-',
    validFrom: null,
    validTo: null,
    ...partial,
  };
}

const NOW = new Date('2026-08-08T00:00:00Z');

describe('isSaleKschl', () => {
  it('treats VKA0 as the sale type', () => {
    assert.equal(isSaleKschl('VKA0'), true);
    assert.equal(isSaleKschl('vka0'), true, 'case should not matter');
    assert.equal(isSaleKschl('VKP0'), false);
  });

  it('does not treat VKA1 as an in-scope sale', () => {
    // The UK sites price from VKA0 and VKP0 only. VKA1 is excluded by the
    // allow-list rather than silently treated as a sale.
    assert.equal(isSaleKschl('VKA1'), false);
  });
});

describe('selectFasciaPrice — the supplied loadsheet sample', () => {
  // All nine rows of the full export, VKP1 included.
  const sample = [
    row({ kschl: 'VKP0', werks: '433', price: 466.67 }),
    row({ kschl: 'VKP1', werks: '433', price: 466.67 }),
    row({ kschl: 'VKP0', werks: '192', price: 490 }),
    row({ kschl: 'VKP1', werks: '192', price: 466.67 }),
    row({ kschl: 'VKP0', werks: '-', price: 560 }),
    row({ kschl: 'VKP1', werks: '-', price: 466.67 }),
    row({ kschl: 'VKA0', werks: '197', price: 445 }),
    row({ kschl: 'VKA0', werks: '439', price: 445 }),
    row({ kschl: 'VKA0', werks: '470', price: 445 }),
  ];

  it('ignores VKP1 — it is the net twin of VKP0, not a shelf price', () => {
    // Regression: treating VKP1 as another regular price made it win the
    // tie-break at equal specificity, giving a was-price of £466.67 (the
    // ex-VAT figure) instead of £560.
    const selected = selectFasciaPrice(sample, GOLDSMITHS, NOW);
    assert.equal(selected?.regularPrice, 560);
    assert.notEqual(selected?.regularPrice, 466.67);
  });

  it('prices Goldsmiths at the fascia sale, with the org-wide regular as the was-price', () => {
    const selected = selectFasciaPrice(sample, GOLDSMITHS, NOW);
    assert.ok(selected);
    assert.equal(selected.price, 445);
    assert.equal(selected.regularPrice, 560);
    assert.equal(selected.onSale, true);
    assert.equal(selected.sourceKschl, 'VKA0');
    assert.equal(selected.sourceWerks, '197');
  });

  it('gives Mappin & Webb the same treatment from its own row', () => {
    const selected = selectFasciaPrice(sample, MAPPIN, NOW);
    assert.equal(selected?.price, 445);
    assert.equal(selected?.sourceWerks, '439');
  });

  it('ignores other stores entirely — 433 and 192 are not our fascias', () => {
    const selected = selectFasciaPrice(sample, GOLDSMITHS, NOW);
    assert.notEqual(selected?.price, 466.67);
    assert.notEqual(selected?.price, 490);
  });

  it('flags that the sample carries no usable validity dates', () => {
    assert.ok(selectFasciaPrice(sample, GOLDSMITHS, NOW)?.warnings.includes('no_validity_dates'));
  });
});

describe('selectFasciaPrice — precedence', () => {
  it('prefers a store-specific regular price over the sales-org-wide one', () => {
    const rows = [
      row({ kschl: 'VKP0', werks: '-', price: 560 }),
      row({ kschl: 'VKP0', werks: '197', price: 520 }),
    ];
    const selected = selectFasciaPrice(rows, GOLDSMITHS, NOW);
    assert.equal(selected?.price, 520);
    assert.equal(selected?.sourceWerks, '197');
  });

  it('keeps the store-specific price even when the org-wide one is cheaper', () => {
    // Precedence is not "lowest wins" across specificity levels — a more
    // specific price is the applicable one whatever its value.
    const rows = [
      row({ kschl: 'VKP0', werks: '-', price: 400 }),
      row({ kschl: 'VKP0', werks: '197', price: 520 }),
    ];
    assert.equal(selectFasciaPrice(rows, GOLDSMITHS, NOW)?.price, 520);
  });

  it('takes the most recently started price among equally specific rows', () => {
    const rows = [
      row({ kschl: 'VKP0', werks: '197', price: 500, validFrom: new Date('2024-01-01') }),
      row({ kschl: 'VKP0', werks: '197', price: 530, validFrom: new Date('2026-01-01') }),
    ];
    assert.equal(selectFasciaPrice(rows, GOLDSMITHS, NOW)?.price, 530);
  });

  it('returns null when nothing applies to this fascia', () => {
    const rows = [row({ kschl: 'VKP0', vkorg: 'GS04', werks: '-', price: 800 })];
    assert.equal(selectFasciaPrice(rows, GOLDSMITHS, NOW), null);
  });

  it('ignores a different sales organisation even at the right store code', () => {
    const rows = [row({ kschl: 'VKP0', vkorg: 'GS04', werks: '197', price: 800 })];
    assert.equal(selectFasciaPrice(rows, GOLDSMITHS, NOW), null);
  });
});

describe('selectFasciaPrice — sale handling', () => {
  it('refuses a "sale" that is not cheaper, and says so', () => {
    const rows = [
      row({ kschl: 'VKP0', werks: '197', price: 500 }),
      row({ kschl: 'VKA0', werks: '197', price: 550 }),
    ];
    const selected = selectFasciaPrice(rows, GOLDSMITHS, NOW);
    assert.equal(selected?.price, 500, 'the regular price is what a customer pays');
    assert.equal(selected?.onSale, false);
    assert.ok(selected?.warnings.includes('sale_not_cheaper'));
  });

  it('uses a sale price that stands alone, with no was-price', () => {
    const rows = [row({ kschl: 'VKA0', werks: '197', price: 445 })];
    const selected = selectFasciaPrice(rows, GOLDSMITHS, NOW);
    assert.equal(selected?.price, 445);
    assert.equal(selected?.onSale, true);
    assert.equal(selected?.regularPrice, null);
  });

  it('flags the documented org-wide-sale vs fascia-regular ambiguity', () => {
    // The Confluence page warns the live site may return the fascia regular
    // price here instead of the sale. We apply the intended rule and flag it.
    const rows = [
      row({ kschl: 'VKP0', werks: '197', price: 520 }),
      row({ kschl: 'VKA0', werks: '-', price: 445 }),
    ];
    const selected = selectFasciaPrice(rows, GOLDSMITHS, NOW);
    assert.equal(selected?.price, 445);
    assert.ok(selected?.warnings.includes('precedence_ambiguous'));
  });

  it('does not flag ambiguity when the sale is fascia-specific', () => {
    const rows = [
      row({ kschl: 'VKP0', werks: '-', price: 560 }),
      row({ kschl: 'VKA0', werks: '197', price: 445 }),
    ];
    assert.ok(!selectFasciaPrice(rows, GOLDSMITHS, NOW)?.warnings.includes('precedence_ambiguous'));
  });
});

describe('selectFasciaPrice — validity dates', () => {
  it('ignores a price whose window has closed', () => {
    const rows = [
      row({ kschl: 'VKP0', werks: '197', price: 520, validFrom: new Date('2020-01-01'), validTo: new Date('2021-01-01') }),
      row({ kschl: 'VKP0', werks: '-', price: 560 }),
    ];
    assert.equal(selectFasciaPrice(rows, GOLDSMITHS, NOW)?.price, 560);
  });

  it('ignores a price that has not started yet', () => {
    const rows = [
      row({ kschl: 'VKA0', werks: '197', price: 300, validFrom: new Date('2030-01-01') }),
      row({ kschl: 'VKP0', werks: '197', price: 520 }),
    ];
    const selected = selectFasciaPrice(rows, GOLDSMITHS, NOW);
    assert.equal(selected?.price, 520, 'a future sale must not be applied today');
    assert.equal(selected?.onSale, false);
  });

  it('accepts the end-of-time convention as open-ended', () => {
    const rows = [
      row({ kschl: 'VKP0', werks: '197', price: 520, validFrom: new Date('2018-08-01'), validTo: new Date('9999-12-31') }),
    ];
    assert.equal(selectFasciaPrice(rows, GOLDSMITHS, NOW)?.price, 520);
  });
});

describe('pickByPrecedence', () => {
  it('returns null for no candidates', () => {
    assert.equal(pickByPrecedence([], GOLDSMITHS), null);
  });

  it('prefers a dated row over an undated one of equal specificity', () => {
    const dated = row({ werks: '197', price: 500, validFrom: new Date('2025-01-01') });
    const undated = row({ werks: '197', price: 600 });
    assert.equal(pickByPrecedence([undated, dated], GOLDSMITHS)?.price, 500);
  });
});

describe('parseLoadsheetDate', () => {
  it('returns null for the time-only leftovers Excel produces', () => {
    // Every row of the supplied loadsheet looks like this.
    assert.equal(parseLoadsheetDate('00:00.0'), null);
    assert.equal(parseLoadsheetDate('00:00:00'), null);
    assert.equal(parseLoadsheetDate(''), null);
    assert.equal(parseLoadsheetDate(undefined), null);
  });

  it('reads DD.MM.YYYY as a European date, not a US one', () => {
    const parsed = parseLoadsheetDate('01.09.2018');
    assert.equal(parsed?.toISOString().slice(0, 10), '2018-09-01');
  });

  it('reads DD/MM/YYYY the same way', () => {
    assert.equal(parseLoadsheetDate('15/08/2018')?.toISOString().slice(0, 10), '2018-08-15');
  });

  it('accepts ISO dates', () => {
    assert.equal(parseLoadsheetDate('2018-08-01')?.toISOString().slice(0, 10), '2018-08-01');
  });

  it('handles the end-of-time convention', () => {
    assert.equal(parseLoadsheetDate('31.12.9999')?.getUTCFullYear(), 9999);
  });
});

describe('parsePrice', () => {
  it('reads plain and formatted amounts', () => {
    assert.equal(parsePrice('466.67'), 466.67);
    assert.equal(parsePrice('£1,150.00'), 1150);
    assert.equal(parsePrice('0'), 0);
  });

  it('rejects unusable values', () => {
    assert.equal(parsePrice(''), null);
    assert.equal(parsePrice('POA'), null);
    assert.equal(parsePrice('-5'), null);
  });
});

describe('condition type allow-list', () => {
  it('accepts only the two UK pricing types', () => {
    assert.equal(isPricingKschl('VKP0'), true, 'UK RRP');
    assert.equal(isPricingKschl('VKA0'), true, 'UK sale');
    assert.equal(isPricingKschl('VKP1'), false, 'net twin of VKP0');
    assert.equal(isPricingKschl('VKA1'), false, 'not in scope for the UK sites');
    assert.equal(isPricingKschl(''), false);
  });

  it('leaves a fascia unpriced when only excluded types are present', () => {
    const rows = [row({ kschl: 'VKP1', werks: '197', price: 466.67 })];
    assert.equal(selectFasciaPrice(rows, GOLDSMITHS, NOW), null);
  });
});

describe('distribution channel and price list', () => {
  it('ignores a row from another distribution channel', () => {
    const rows = [row({ kschl: 'VKP0', werks: '197', vtweg: 'G2', price: 400 })];
    assert.equal(selectFasciaPrice(rows, GOLDSMITHS, NOW), null);
  });

  it('ignores a price-list row when the fascia uses no price list', () => {
    const rows = [
      row({ kschl: 'VKP0', werks: '-', pltyp: 'PriceListTest', price: 400 }),
      row({ kschl: 'VKP0', werks: '-', price: 560 }),
    ];
    assert.equal(selectFasciaPrice(rows, GOLDSMITHS, NOW)?.price, 560);
  });

  it('uses a price-list row when the fascia is on that list', () => {
    const onList = { ...GOLDSMITHS, priceListType: 'PriceListTest' };
    const rows = [
      row({ kschl: 'VKP0', werks: '-', pltyp: 'PriceListTest', price: 400 }),
      row({ kschl: 'VKP0', werks: '-', price: 560 }),
    ];
    assert.equal(selectFasciaPrice(rows, onList, NOW)?.price, 400);
  });

  it('still lets a store-specific price beat the price list', () => {
    const onList = { ...GOLDSMITHS, priceListType: 'PriceListTest' };
    const rows = [
      row({ kschl: 'VKP0', werks: '-', pltyp: 'PriceListTest', price: 400 }),
      row({ kschl: 'VKP0', werks: '197', price: 520 }),
    ];
    assert.equal(selectFasciaPrice(rows, onList, NOW)?.price, 520);
  });
});
