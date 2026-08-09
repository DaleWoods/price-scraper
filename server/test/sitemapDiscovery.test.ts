import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { slugWords } from '../src/scraping/sitemap.ts';
import { searchTermsFor } from '../src/matching/sitemapDiscovery.ts';
import type { Product } from '../src/domain/types.ts';

function product(partial: Partial<Product> = {}): Product {
  return {
    id: 1,
    internal_sku: '17302848',
    brand: 'Rolex',
    product_name: 'Cosmograph Daytona Oyster 40mm',
    ean_mpn: null,
    currency: 'GBP',
    category: 'Watches',
    our_product_url: null,
    specs: {},
    created_at: '',
    updated_at: '',
    ...partial,
  } as Product;
}

describe('slugWords', () => {
  it('reduces a product URL to searchable words', () => {
    assert.equal(
      slugWords('https://www.example.co.uk/Rolex-Cosmograph-Daytona-M116503-0001/p/123'),
      'rolex cosmograph daytona m116503 0001 p 123',
    );
  });

  it('splits underscores and mixed separators alike', () => {
    assert.equal(slugWords('https://x.co/a/cosmograph_daytona.oyster'), 'a cosmograph daytona oyster');
  });

  it('decodes percent-encoding so encoded names are searchable', () => {
    assert.equal(slugWords('https://x.co/Mappin%20%26%20Webb-Ring'), 'mappin webb ring');
  });

  it('ignores the query string, which is not part of the product identity', () => {
    assert.equal(slugWords('https://x.co/rolex-daytona?utm_source=google'), 'rolex daytona');
  });

  it('survives a malformed URL rather than throwing', () => {
    assert.equal(slugWords('not a url'), 'not a url');
  });
});

describe('searchTermsFor', () => {
  it('leads with the manufacturer reference, the strongest signal in a slug', () => {
    const terms = searchTermsFor(product({ ean_mpn: 'M116503-0001' }));
    assert.ok(terms.includes('m116503'));
  });

  it('includes brand and the distinctive words of the name', () => {
    const terms = searchTermsFor(product());
    assert.ok(terms.includes('rolex'));
    assert.ok(terms.includes('cosmograph'));
    assert.ok(terms.includes('daytona'));
  });

  it('drops words too common in a retail URL to narrow anything', () => {
    const terms = searchTermsFor(product({ product_name: 'The Gold Watch For Ladies' }));
    for (const noise of ['the', 'gold', 'watch', 'for', 'ladies']) {
      assert.ok(!terms.includes(noise), `${noise} should not be a search term`);
    }
  });

  it('caps the number of terms so one long name cannot dominate', () => {
    const terms = searchTermsFor(
      product({ product_name: 'Alpha Bravo Charlie Delta Echo Foxtrot Golf Hotel India Juliet' }),
    );
    assert.ok(terms.length <= 8, `got ${terms.length}`);
  });

  it('returns nothing when there is nothing distinctive to search for', () => {
    assert.deepEqual(searchTermsFor(product({ brand: '', product_name: 'the watch' })), []);
  });
});
