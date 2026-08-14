import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { after, before, describe, it } from 'node:test';
import { harvestSitemapUrls, parseSitemapXml } from '../src/scraping/sitemap.ts';

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

/**
 * Retailers repeat URLs, both within one sitemap and across the children of an
 * index. Returning the duplicates made the caller's batched upsert fail with
 * "ON CONFLICT DO UPDATE command cannot affect row a second time", which failed
 * the whole scrape run.
 */
describe('harvestSitemapUrls de-duplicates', () => {
  let server: Server;
  let origin: string;

  const page = (loc: string) => `<url><loc>${loc}</loc></url>`;

  before(async () => {
    server = createServer((req, res) => {
      const send = (body: string, type = 'application/xml') => {
        res.writeHead(200, { 'content-type': type });
        res.end(body);
      };

      if (req.url === '/robots.txt') {
        send(`User-agent: *\nSitemap: ${origin}/sitemap.xml\n`, 'text/plain');
        return;
      }
      if (req.url === '/sitemap.xml') {
        send(
          `<sitemapindex><sitemap><loc>${origin}/one.xml</loc></sitemap>` +
            `<sitemap><loc>${origin}/two.xml</loc></sitemap></sitemapindex>`,
        );
        return;
      }
      if (req.url === '/one.xml') {
        // The same URL twice inside a single file.
        send(`<urlset>${page(`${origin}/p/a`)}${page(`${origin}/p/b`)}${page(`${origin}/p/a`)}</urlset>`);
        return;
      }
      if (req.url === '/two.xml') {
        // And again in a sibling sitemap.
        send(`<urlset>${page(`${origin}/p/b`)}${page(`${origin}/p/c`)}</urlset>`);
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

  it('returns each URL once, however many times it is listed', async () => {
    const harvest = await harvestSitemapUrls(origin, 'test-agent');

    assert.equal(harvest.error, null);
    const locs = harvest.urls.map((entry) => entry.loc).sort();
    assert.deepEqual(locs, [`${origin}/p/a`, `${origin}/p/b`, `${origin}/p/c`]);
    assert.equal(new Set(locs).size, locs.length);
  });
});
