import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Competitor } from '../src/domain/types.ts';
import { ScrapeError } from '../src/scraping/errors.ts';
import { extractListing, extractSearchResults, parsePrice } from '../src/scraping/extract.ts';
import type { FetchedPage } from '../src/scraping/fetcher.ts';
import { classifyPosition } from '../src/services/comparison.ts';

const competitor: Competitor = {
  id: 1,
  slug: 'test-retailer',
  display_name: 'Test Retailer',
  base_url: 'https://retailer.example',
  search_url_pattern: 'https://retailer.example/search?q={query}',
  brands: [],
  enabled: true,
  scrape_frequency: 'daily',
  config: {
    rendering: 'http',
    product: {
      useJsonLd: true,
      sanityContains: ['h1'],
      selectors: {
        price: ['.price-now'],
        wasPrice: ['.price-was'],
        availability: ['.stock'],
        promoBadge: ['.promo'],
      },
    },
    search: {
      resultItem: ['.product-tile'],
      resultLink: ['a'],
      resultTitle: ['.tile-title'],
      resultPrice: ['.tile-price'],
    },
  },
  created_at: '',
  updated_at: '',
};

const page = (html: string): FetchedPage => ({
  url: 'https://retailer.example/p/1',
  finalUrl: 'https://retailer.example/p/1',
  html,
  status: 200,
  renderedWith: 'http',
});

describe('parsePrice', () => {
  it('reads UK-formatted currency strings', () => {
    assert.equal(parsePrice('£1,234.00'), 1234);
    assert.equal(parsePrice('£950'), 950);
    assert.equal(parsePrice('From £2,499.99'), 2499.99);
  });

  it('reads continental formatting where the comma is the decimal separator', () => {
    assert.equal(parsePrice('1.234,56'), 1234.56);
  });

  it('returns null when there is no number at all', () => {
    assert.equal(parsePrice('Price on application'), null);
    assert.equal(parsePrice(''), null);
    assert.equal(parsePrice(null), null);
  });
});

describe('extractListing', () => {
  it('prefers schema.org JSON-LD over CSS selectors', () => {
    const listing = extractListing(
      competitor,
      page(`
        <h1>TAG Heuer Carrera</h1>
        <div class="price-now">£9,999.00</div>
        <script type="application/ld+json">
          {
            "@context": "https://schema.org",
            "@type": "Product",
            "name": "TAG Heuer Carrera Chronograph 41mm",
            "gtin13": "7612345678901",
            "brand": { "@type": "Brand", "name": "TAG Heuer" },
            "offers": {
              "@type": "Offer",
              "price": "4250.00",
              "priceCurrency": "GBP",
              "availability": "https://schema.org/InStock"
            }
          }
        </script>
      `),
    );

    assert.equal(listing.price, 4250);
    assert.equal(listing.source, 'json-ld');
    assert.equal(listing.ean, '7612345678901');
    assert.equal(listing.brand, 'TAG Heuer');
    assert.equal(listing.inStock, true);
    assert.equal(listing.currency, 'GBP');
  });

  it('falls back to CSS selectors when there is no JSON-LD', () => {
    const listing = extractListing(
      competitor,
      page(`
        <h1>Longines Master Collection</h1>
        <div class="price-now">£1,780.00</div>
        <div class="price-was">£2,100.00</div>
        <div class="stock">Out of stock</div>
      `),
    );

    assert.equal(listing.price, 1780);
    assert.equal(listing.source, 'selector');
    assert.equal(listing.wasPrice, 2100);
    assert.equal(listing.promo, true, 'a was-price above the sale price implies a promotion');
    assert.equal(listing.inStock, false);
  });

  it('reads spec tables into attributes', () => {
    const listing = extractListing(
      competitor,
      page(`
        <h1>Rado Captain Cook</h1>
        <div class="price-now">£1,950.00</div>
        <table>
          <tr><th>Case Size</th><td>42mm</td></tr>
          <tr><th>Dial Colour</th><td>Green</td></tr>
        </table>
      `),
    );

    assert.equal(listing.attributes.case_size, '42mm');
    assert.equal(listing.attributes.dial_colour, 'Green');
  });

  it('throws a loud layout_changed error when the page markers are gone', () => {
    assert.throws(
      () => extractListing(competitor, page('<div>Search results for…</div>')),
      (err: unknown) => err instanceof ScrapeError && err.kind === 'layout_changed',
    );
  });

  it('throws no_price_found rather than recording a wrong price', () => {
    assert.throws(
      () => extractListing(competitor, page('<h1>Some product</h1><div>No price here</div>')),
      (err: unknown) => err instanceof ScrapeError && err.kind === 'no_price_found',
    );
  });

  it('rejects an implausible price instead of storing it', () => {
    assert.throws(
      () => extractListing(competitor, page('<h1>Product</h1><div class="price-now">£0.00</div>')),
      (err: unknown) => err instanceof ScrapeError && err.kind === 'implausible_price',
    );
  });
});

describe('extractSearchResults', () => {
  it('resolves relative hrefs against the competitor base URL and de-duplicates', () => {
    const results = extractSearchResults(
      competitor,
      page(`
        <div class="product-tile"><a href="/p/abc"><span class="tile-title">Watch A</span></a><span class="tile-price">£500</span></div>
        <div class="product-tile"><a href="/p/abc"><span class="tile-title">Watch A again</span></a></div>
        <div class="product-tile"><a href="https://retailer.example/p/def"><span class="tile-title">Watch B</span></a></div>
      `),
    );

    assert.equal(results.length, 2);
    assert.equal(results[0]?.url, 'https://retailer.example/p/abc');
    assert.equal(results[0]?.title, 'Watch A');
    assert.equal(results[0]?.price, 500);
    assert.equal(results[1]?.url, 'https://retailer.example/p/def');
  });
});

describe('classifyPosition', () => {
  it('classifies our price against a competitor', () => {
    assert.equal(classifyPosition(100, 120), 'lower');
    assert.equal(classifyPosition(120, 100), 'higher');
    assert.equal(classifyPosition(100, 100), 'equal');
  });

  it('treats a sub-penny difference as level', () => {
    assert.equal(classifyPosition(100.001, 100), 'equal');
  });
});
