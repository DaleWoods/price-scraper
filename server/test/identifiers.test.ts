import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { after, before, describe, it } from 'node:test';
import type { Competitor, Product } from '../src/domain/types.ts';
import { compareIdentifiers, gtinKey, identKey, looksLikeGtin } from '../src/matching/identifiers.ts';
import { scoreCandidate } from '../src/matching/score.ts';
import { isProductUrl } from '../src/scraping/catalogue.ts';
import { extractListing } from '../src/scraping/extract.ts';
import type { FetchedPage } from '../src/scraping/fetcher.ts';
import { siteFetch } from '../src/scraping/httpClient.ts';
import { identityMismatch } from '../src/scraping/runner.ts';
import { inspectRobots } from '../src/scraping/robots.ts';
import { parseSitemapXml } from '../src/scraping/sitemap.ts';

/**
 * Coverage for the things that only showed up once real retailers were read:
 * which identifier is which, sites that publish their own stock code where the
 * manufacturer's reference belongs, a previous price that exists only in
 * embedded data, a sitemap index that is not marked up as one, a robots.txt
 * answered with a challenge, and response headers larger than Node allows.
 *
 * The values in these tests are the shapes seen on the live sites.
 */

describe('identifier keys', () => {
  it('agrees a UPC with the EAN that is the same number zero-padded', () => {
    assert.equal(gtinKey('703200164298'), gtinKey('0703200164298'));
  });

  it('ignores punctuation and case in a manufacturer reference', () => {
    assert.equal(identKey('220.13.41.21.10.001'), identKey('220-13-41-21-10-001'));
    assert.equal(identKey('GAC-2500-9AER'), 'gac25009aer');
  });

  it('does not mistake a seven or eight digit stock code for a barcode', () => {
    assert.equal(looksLikeGtin('1292447'), false);
    assert.equal(looksLikeGtin('12924470'), false);
    assert.equal(looksLikeGtin('7612586304941'), true);
  });
});

describe('compareIdentifiers', () => {
  it('matches barcode to barcode', () => {
    const verdict = compareIdentifiers({ gtin: '7612586304941' }, { gtin: '7612586304941', mpn: 'X' });
    assert.deepEqual(verdict, { verdict: 'match', via: 'gtin', ours: '7612586304941', theirs: '7612586304941' });
  });

  it('matches our reference to their mpn', () => {
    const verdict = compareIdentifiers({ mpn: '220.13.41.21.10.001' }, { mpn: '22013412110001' });
    assert.equal(verdict.verdict, 'match');
  });

  it('matches our reference to their sku, where some retailers put it', () => {
    // Berry's publishes the maker's reference as `sku`, not `mpn`.
    const verdict = compareIdentifiers({ mpn: 'WSSA0086' }, { sku: 'WSSA0086', gtin: '7624709167067' });
    assert.equal(verdict.verdict, 'match');
  });

  it('says nothing when we hold a barcode and they publish only a reference', () => {
    const verdict = compareIdentifiers({ gtin: '7612586304941' }, { mpn: '1292447', sku: '1292447' });
    assert.equal(verdict.verdict, 'unknown');
  });

  it('says nothing when the references differ, since theirs may be a stock code', () => {
    const verdict = compareIdentifiers({ mpn: 'L37204726' }, { mpn: '1642230' });
    assert.equal(verdict.verdict, 'unknown');
  });

  it('reports a conflict only when two barcodes differ', () => {
    const verdict = compareIdentifiers({ gtin: '7612586304941' }, { gtin: '7612356228132' });
    assert.equal(verdict.verdict, 'conflict');
  });

  it('lets a matching reference outweigh differing barcodes', () => {
    // One watch, two barcodes — a regional or packaging variant.
    const verdict = compareIdentifiers(
      { gtin: '7612356228132', mpn: 'L37204726' },
      { gtin: '0703200164298', mpn: 'L3.720.4.72.6' },
    );
    assert.deepEqual(verdict.verdict, 'match');
  });

  it('refuses to match on a reference too short to mean anything', () => {
    assert.equal(compareIdentifiers({ mpn: '1234' }, { mpn: '1234' }).verdict, 'unknown');
    assert.equal(compareIdentifiers({ mpn: 'GOLDEN' }, { mpn: 'GOLDEN' }).verdict, 'unknown');
  });

  it('reads the older combined fields as whichever kind they hold', () => {
    assert.equal(compareIdentifiers({ eanMpn: '7612586304941' }, { ean: '7612586304941' }).verdict, 'match');
    assert.equal(compareIdentifiers({ eanMpn: 'WSSA0086' }, { ean: 'wssa-0086' }).verdict, 'match');
    assert.equal(compareIdentifiers({ eanMpn: 'WSSA0086' }, { ean: '7624709167067' }).verdict, 'unknown');
  });
});

describe('scoring with separate identifiers', () => {
  const product = (overrides: Partial<Product> = {}): Product =>
    ({
      id: 1,
      internal_sku: 'GS-1',
      brand: 'Longines',
      product_name: 'Conquest 38mm Silver Dial Steel Bracelet Watch',
      ean_mpn: '7612356228132',
      gtin: '7612356228132',
      mpn: 'L37204726',
      our_price: 1500,
      currency: 'GBP',
      category: 'watches',
      our_product_url: null,
      specs: {},
      created_at: '',
      updated_at: '',
      ...overrides,
    }) as Product;

  it('confirms on the reference when the listing names the brand', () => {
    const scored = scoreCandidate(product({ gtin: null, ean_mpn: 'L37204726' }), {
      url: 'https://shop.example/longines-conquest/1.html',
      title: 'Longines Conquest 38mm Silver Dial Steel Bracelet Watch',
      brand: 'Longines',
      mpn: 'L37204726',
    });
    assert.equal(scored.confidence, 100);
    assert.equal(scored.tier, 'ean_mpn_exact');
  });

  it('does not confirm on a reference alone when nothing on the listing names the brand', () => {
    const scored = scoreCandidate(product({ gtin: null, ean_mpn: 'L37204726' }), {
      url: 'https://shop.example/p/99',
      title: 'Steel bracelet watch',
      brand: 'shopexample',
      mpn: 'L37204726',
    });
    assert.notEqual(scored.tier, 'ean_mpn_exact');
  });

  it('finds the brand in the title when the declared brand is the shop itself', () => {
    // Ernest Jones and H.Samuel declare their own name as the JSON-LD brand.
    const scored = scoreCandidate(product({ gtin: null, ean_mpn: 'L37204726' }), {
      url: 'https://shop.example/p/V-1',
      title: 'Longines Conquest 38mm Watch',
      brand: 'ernestjones',
      mpn: 'L37204726',
    });
    assert.equal(scored.confidence, 100);
  });
});

describe('identityMismatch', () => {
  it('flags a page whose barcode is not ours', () => {
    assert.equal(identityMismatch('7612586304941', '7612356228132').mismatched, true);
  });

  it('does not flag a page that publishes a stock code where we hold a barcode', () => {
    assert.equal(
      identityMismatch({ gtin: '7612586304941' }, { mpn: '1292447', sku: '1292447', ean: '1292447' }).mismatched,
      false,
    );
  });

  it('does not flag silence on either side', () => {
    assert.equal(identityMismatch(null, '7612356228132').mismatched, false);
    assert.equal(identityMismatch('7612586304941', null).mismatched, false);
  });
});

describe('extraction of identifiers and previous prices', () => {
  const competitor = (product: Competitor['config']['product']): Competitor =>
    ({
      id: 1,
      slug: 'test-retailer',
      display_name: 'Test Retailer',
      base_url: 'https://retailer.example',
      search_url_pattern: 'https://retailer.example/search?q={query}',
      brands: [],
      enabled: true,
      scrape_frequency: 'daily',
      config: { rendering: 'http', product: { useJsonLd: true, sanityContains: ['h1'], ...product } },
    }) as Competitor;

  const page = (html: string): FetchedPage => ({
    url: 'https://retailer.example/p/1',
    finalUrl: 'https://retailer.example/p/1',
    html,
    status: 200,
    renderedWith: 'http',
  });

  const jsonLd = (fields: Record<string, unknown>, price: number | string = 67) =>
    `<script type="application/ld+json">${JSON.stringify({
      '@type': 'Product',
      name: 'Necklace',
      ...fields,
      offers: { '@type': 'Offer', price, priceCurrency: 'GBP' },
    })}</script>`;

  it('keeps the barcode, the reference and the stock code apart', () => {
    const listing = extractListing(
      competitor({}),
      page(`${jsonLd({ gtin13: '4064092280173', mpn: 'MKC1726CZ791', sku: 'S141626' })}<h1>Necklace</h1>`),
    );
    assert.equal(listing.gtin, '4064092280173');
    assert.equal(listing.mpn, 'MKC1726CZ791');
    assert.equal(listing.sku, 'S141626');
    // The older combined field still prefers the barcode.
    assert.equal(listing.ean, '4064092280173');
  });

  it('leaves the barcode empty when only a stock code is published', () => {
    const listing = extractListing(
      competitor({}),
      page(`${jsonLd({ mpn: '1292447', sku: '1292447' })}<h1>Ring</h1>`),
    );
    assert.equal(listing.gtin, null);
    assert.equal(listing.mpn, '1292447');
  });

  it('reads a previous price from embedded data, tied to this product by its own price', () => {
    // Beaverbrooks' shape. The first block belongs to a recommended product
    // further up the page and must not be the one that is read.
    const html =
      `${jsonLd({})}<h1>Necklace</h1>` +
      '<script>{"price":{"value":310,"wasPrice":399},"x":1}{"price":{"value":67,"wasPrice":75,"wasWasPrice":109}}</script>';
    const listing = extractListing(
      competitor({ patterns: { wasPrice: ['"price":\\{"value":{price},"wasPrice":([0-9]+(?:\\.[0-9]+)?)'] } }),
      page(html),
    );
    assert.equal(listing.price, 67);
    assert.equal(listing.wasPrice, 75);
    assert.equal(listing.promo, true);
  });

  it('reports no previous price when the embedded value is not above the current one', () => {
    // Signet's shape: msrp equals the selling price on a full-price line.
    const html =
      `${jsonLd({}, 499)}<h1>Earrings</h1>` +
      '<script>{"priceData":{"currencyIso":"GBP","displayValue":499,"msrp":499,"useMsrp":true,"value":499}}</script>';
    const listing = extractListing(
      competitor({
        patterns: { wasPrice: ['"priceData":\\{[^{}]*"msrp":([0-9]+(?:\\.[0-9]+)?)[^{}]*"value":{price}\\}'] },
      }),
      page(html),
    );
    assert.equal(listing.wasPrice, null);
    assert.equal(listing.promo, false);
  });

  it('survives a pattern that is not a valid expression', () => {
    const listing = extractListing(
      competitor({ patterns: { wasPrice: ['(unclosed'] } }),
      page(`${jsonLd({})}<h1>Necklace</h1>`),
    );
    assert.equal(listing.price, 67);
    assert.equal(listing.wasPrice, null);
  });
});

describe('product URL patterns', () => {
  const withPattern = (pattern?: string) =>
    ({ slug: 'x', config: { rendering: 'http', productUrlPattern: pattern } }) as Competitor;

  it('picks out product pages by the shape of their path', () => {
    const signet = withPattern('/p/V-\\d+$');
    assert.equal(isProductUrl(signet, 'https://www.example.co.uk/tudor-black-bay/p/V-5097371'), true);
    assert.equal(isProductUrl(signet, 'https://www.example.co.uk/l/watches'), false);
  });

  it('treats every URL as a candidate when no pattern is configured', () => {
    assert.equal(isProductUrl(withPattern(undefined), 'https://www.example.co.uk/anything'), true);
  });

  it('ignores a pattern that is not a valid expression rather than emptying the catalogue', () => {
    assert.equal(isProductUrl(withPattern('(unclosed'), 'https://www.example.co.uk/p/1'), true);
  });
});

describe('sitemap index published as an ordinary page list', () => {
  it('follows entries that are themselves sitemap files', () => {
    // 77 Diamonds' sitemap-index.xml: a <urlset> whose pages are sitemaps.
    const xml = `<?xml version="1.0"?><urlset>
      <url><loc>https://shop.example/sitemap.xml</loc></url>
      <url><loc>https://shop.example/de/sitemap.xml</loc></url>
      <url><loc>https://shop.example/rings/solitaire</loc></url>
    </urlset>`;
    const parsed = parseSitemapXml(xml);
    assert.deepEqual(parsed.children, ['https://shop.example/sitemap.xml', 'https://shop.example/de/sitemap.xml']);
    assert.deepEqual(parsed.urls.map((entry) => entry.loc), ['https://shop.example/rings/solitaire']);
  });
});

describe('against a site with awkward responses', () => {
  let server: Server;
  let origin = '';

  before(async () => {
    server = createServer((req, res) => {
      if (req.url === '/robots.txt') {
        // How an AWS WAF answers a visitor it wants to challenge.
        res.writeHead(202, { 'x-amzn-waf-action': 'challenge' });
        res.end();
        return;
      }
      if (req.url === '/big-headers') {
        // Larger than Node's default 16 KB header limit, as Beaverbrooks' are.
        res.writeHead(200, {
          'content-type': 'text/html',
          'content-security-policy': `default-src ${'https://cdn.example '.repeat(1500)}`,
        });
        res.end('<h1>fine</h1>');
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    origin = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('does not read a challenge with an empty body as permission to crawl everything', async () => {
    const inspection = await inspectRobots(origin, 'PriceMonitorBot/0.1', [`${origin}/`]);
    assert.equal(inspection.status, 'unreachable');
    assert.match(inspection.failureDetail ?? '', /202/);
  });

  it('reads a page whose response headers exceed the default limit', async () => {
    const response = await siteFetch(`${origin}/big-headers`);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), '<h1>fine</h1>');
  });
});
