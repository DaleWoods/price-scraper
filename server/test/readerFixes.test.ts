import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Competitor } from '../src/domain/types.ts';
import { extractListing, unescapeData } from '../src/scraping/extract.ts';

const ernestJones = {
  id: 1,
  slug: 'ernest-jones',
  display_name: 'Ernest Jones',
  base_url: 'https://www.ernestjones.co.uk',
  brands: [],
  config: { selectors: {} },
} as unknown as Competitor;

function page(html: string) {
  return { html, finalUrl: 'https://www.ernestjones.co.uk/x/p/V-1', status: 200, renderedWith: 'http' } as never;
}

const jsonLd = (extra: Record<string, unknown>) =>
  `<script type="application/ld+json">${JSON.stringify({
    '@type': 'Product',
    name: 'Rotary Heritage Watch',
    sku: '1307818',
    mpn: '1307818',
    offers: { '@type': 'Offer', price: '199.00', priceCurrency: 'GBP' },
    ...extra,
  })}</script>`;

/**
 * Found on 17 November 2026 in what had been read from the three main
 * competitors: references stored with a page-data escape in them, the
 * retailer's own name stored as the product's brand, and barcodes the
 * retailer's site publishes in scientific notation.
 */
describe('reading a competitor product page', () => {
  it('undoes page-data escapes in a reference', () => {
    assert.equal(unescapeData('GS05750\\u002F01'), 'GS05750/01');
    assert.equal(unescapeData('RGB10001\\/06'), 'RGB10001/06');
    assert.equal(unescapeData('T137.410.11.041.00'), 'T137.410.11.041.00');
  });

  it('reads a reference with a slash from page data as the maker wrote it', () => {
    const html = `<html><body>${jsonLd({})}<script>{"watchModelNumber":"GS05750\\u002F01"}</script></body></html>`;
    assert.equal(extractListing(ernestJones, page(html)).mpn, 'GS05750/01');
  });

  it("takes the product's brand, not the retailer's own name", () => {
    const html =
      `<html><body>${jsonLd({ brand: { '@type': 'Brand', name: 'ernestjones' } })}` +
      `<script>{"watchAttrs":[{"key":"modelnumber","value":"YA142320"},{"key":"brand","value":"Gucci"}]}</script></body></html>`;
    assert.equal(extractListing(ernestJones, page(html)).brand, 'Gucci');
  });

  it('keeps a real structured brand', () => {
    const html = `<html><body>${jsonLd({ brand: { '@type': 'Brand', name: 'Rotary' } })}</body></html>`;
    assert.equal(extractListing(ernestJones, page(html)).brand, 'Rotary');
  });

  it('does not keep a barcode published in scientific notation', () => {
    const html = `<html><body>${jsonLd({ gtin13: '5.01848E+12' })}</body></html>`;
    assert.equal(extractListing(ernestJones, page(html)).gtin, null);
  });
});

describe('matching on a manufacturer reference', () => {
  const ours = {
    id: 1,
    internal_sku: '18960009',
    brand: 'Seiko 5 Sports',
    product_name: "Flieger' Green 39mm Mens Watch",
    mpn: 'SRPH29K1',
    gtin: null,
    ean_mpn: 'SRPH29K1',
    category: 'Watches',
    specs: {},
  } as never;

  it("accepts a listing that shortens our brand: 'Seiko Sports' for 'Seiko 5 Sports'", async () => {
    const { scoreCandidate } = await import('../src/matching/score.ts');
    const scored = scoreCandidate(ours, {
      url: 'https://www.fraserhart.co.uk/srph29k1-seiko-sports-flieger/18-01-2-5383.html',
      title: 'Seiko Sports "Flieger" 39.4mm Green Dial Nylon Strap Watch',
      brand: 'Seiko',
      mpn: 'SRPH29K1',
      price: 180,
    });
    assert.equal(scored.tier, 'ean_mpn_exact');
  });

  it('still refuses the same reference under another brand', async () => {
    const { scoreCandidate } = await import('../src/matching/score.ts');
    const scored = scoreCandidate(ours, {
      url: 'https://www.example.co.uk/casio-watch-srph29k1',
      title: 'Casio Green Dial Watch',
      brand: 'Casio',
      mpn: 'SRPH29K1',
      price: 180,
    });
    assert.notEqual(scored.tier, 'ean_mpn_exact');
  });
});
