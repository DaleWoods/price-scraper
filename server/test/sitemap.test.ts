import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseSitemapXml } from '../src/scraping/sitemap.ts';

describe('parseSitemapXml', () => {
  it('reads page URLs from a urlset', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
      <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
        <url><loc>https://shop.co.uk/products/watch-a</loc><lastmod>2026-08-01</lastmod></url>
        <url><loc>https://shop.co.uk/products/watch-b</loc></url>
      </urlset>`;
    const parsed = parseSitemapXml(xml);
    assert.equal(parsed.isIndex, false);
    assert.equal(parsed.urls.length, 2);
    assert.equal(parsed.urls[0]?.loc, 'https://shop.co.uk/products/watch-a');
    assert.equal(parsed.urls[0]?.lastmod, '2026-08-01');
    assert.equal(parsed.urls[1]?.lastmod, null);
  });

  it('recognises an index and returns its children rather than URLs', () => {
    const xml = `<?xml version="1.0"?>
      <sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
        <sitemap><loc>https://shop.co.uk/sitemap-products-1.xml</loc></sitemap>
        <sitemap><loc>https://shop.co.uk/sitemap-products-2.xml.gz</loc></sitemap>
      </sitemapindex>`;
    const parsed = parseSitemapXml(xml);
    assert.equal(parsed.isIndex, true);
    assert.equal(parsed.urls.length, 0);
    assert.deepEqual(parsed.children, [
      'https://shop.co.uk/sitemap-products-1.xml',
      'https://shop.co.uk/sitemap-products-2.xml.gz',
    ]);
  });

  it('decodes XML entities in URLs', () => {
    const xml = '<urlset><url><loc>https://shop.co.uk/p?a=1&amp;b=2</loc></url></urlset>';
    assert.equal(parseSitemapXml(xml).urls[0]?.loc, 'https://shop.co.uk/p?a=1&b=2');
  });

  it('copes with namespace prefixes', () => {
    const xml = `<sm:urlset xmlns:sm="http://www.sitemaps.org/schemas/sitemap/0.9">
        <url><loc>https://shop.co.uk/a</loc></url>
      </sm:urlset>`;
    assert.equal(parseSitemapXml(xml).urls.length, 1);
  });

  it('handles whitespace and newlines inside loc', () => {
    const xml = '<urlset><url><loc>\n  https://shop.co.uk/a\n  </loc></url></urlset>';
    assert.equal(parseSitemapXml(xml).urls[0]?.loc, 'https://shop.co.uk/a');
  });

  it('returns nothing for an empty or non-sitemap document', () => {
    assert.equal(parseSitemapXml('<html><body>not a sitemap</body></html>').urls.length, 0);
    assert.equal(parseSitemapXml('').urls.length, 0);
  });

  it('ignores entries with no loc', () => {
    const xml = '<urlset><url><lastmod>2026-01-01</lastmod></url><url><loc>https://a.co/b</loc></url></urlset>';
    assert.equal(parseSitemapXml(xml).urls.length, 1);
  });
});
