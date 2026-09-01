import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { after, describe, it } from 'node:test';
import type { Competitor } from '../src/domain/types.ts';
import { ScrapeError } from '../src/scraping/errors.ts';
import { fetchAndExtract } from '../src/scraping/fetchAndExtract.ts';

/**
 * Coverage for HTTP-first rendering.
 *
 * Every competitor config used to say `rendering: "browser"`, so every single
 * page fetch launched Chromium — the dominant cost behind a compute-quota
 * outage on the hosting platform, and contrary to Spec §5.4, which asks for a
 * plain HTTP fetch where a site allows one and a browser only where JS
 * rendering is genuinely needed.
 *
 * `auto` mode makes that decision per page: fetch over HTTP, and escalate only
 * when the resulting HTML turns out not to be extractable. The tests that
 * matter most here are the ones proving it does *not* escalate — escalating on
 * a 403 would be working around a site's refusal (Spec §9), and escalating on a
 * 404 would double the cost of the most common failure there is.
 *
 * Each case gets its own origin: the rate limiter enforces a floor between
 * requests to the same host, which would otherwise dominate the run time.
 */
describe('fetchAndExtract', () => {
  const servers: Server[] = [];

  after(async () => {
    await Promise.all(
      servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
    );
  });

  function competitor(origin: string, rendering: 'http' | 'browser' | 'auto'): Competitor {
    return {
      id: 1,
      slug: 'test-co',
      display_name: 'Test Co',
      base_url: origin,
      search_url_pattern: `${origin}/search?q={query}`,
      brands: [],
      enabled: true,
      scrape_frequency: 'daily',
      config: {
        rendering,
        rateLimit: { minDelayMs: 0, jitterMs: 0, maxConcurrent: 1 },
        retry: { attempts: 1, backoffMs: 1 },
        product: { useJsonLd: true, sanityContains: ['h1'] },
      },
      logo_url: null,
      logo_fetched_at: null,
      logo_error: null,
      has_logo: false,
      created_at: '',
      updated_at: '',
    } as Competitor;
  }

  /** A product page carrying schema.org JSON-LD, as most retail sites publish. */
  function productHtml(price: string | null): string {
    const jsonLd = {
      '@type': 'Product',
      name: 'Test Watch',
      brand: { name: 'TestBrand' },
      gtin13: '7000000001111',
      // The nested offer needs its own @type: extract.ts finds the offer node by
      // looking for @type offer/aggregateoffer, so an unlabelled object is
      // invisible to it and the page reads as having no price at all.
      ...(price
        ? {
            offers: {
              '@type': 'Offer',
              price,
              priceCurrency: 'GBP',
              availability: 'https://schema.org/InStock',
            },
          }
        : {}),
    };
    return `<html><head><script type="application/ld+json">${JSON.stringify(
      jsonLd,
    )}</script></head><body><h1>Test Watch</h1></body></html>`;
  }

  /**
   * Stand-in retailer. `productStatus` forces an HTTP status on the product
   * page; `price` of null serves a page with no readable price.
   */
  async function standIn(options: { price?: string | null; productStatus?: number } = {}) {
    let productHits = 0;
    const server = createServer((req, res) => {
      if (req.url === '/robots.txt') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('User-agent: *\n');
        return;
      }
      productHits += 1;
      const status = options.productStatus ?? 200;
      if (status !== 200) {
        res.writeHead(status, { 'content-type': 'text/plain' });
        res.end('nope');
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(productHtml(options.price === undefined ? '100.00' : options.price));
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    servers.push(server);
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    return { origin: `http://127.0.0.1:${port}`, productHits: () => productHits };
  }

  it('reads an extractable page over plain HTTP and never starts a browser', async () => {
    const { origin, productHits } = await standIn({ price: '100.00' });

    const result = await fetchAndExtract(competitor(origin, 'auto'), `${origin}/p/one`);

    assert.equal(result.listing.price, 100);
    assert.equal(result.escalated, false, 'a readable page must not escalate');
    assert.equal(result.page.renderedWith, 'http');
    assert.equal(productHits(), 1, 'exactly one request — no second, browser-rendered attempt');
  });

  it('does not escalate an active block, and does not retry it', async () => {
    const { origin, productHits } = await standIn({ productStatus: 403 });

    await assert.rejects(
      () => fetchAndExtract(competitor(origin, 'auto'), `${origin}/p/blocked`),
      (err: unknown) => {
        assert.ok(err instanceof ScrapeError);
        assert.equal(err.kind, 'blocked');
        return true;
      },
    );

    // Two things at once: a block is not retried (it is non-retryable), and it
    // is not escalated to a browser. Working around a refusal is exactly what
    // Spec §9 says not to do.
    assert.equal(productHits(), 1);
  });

  it('does not escalate a listing that no longer exists', async () => {
    const { origin, productHits } = await standIn({ productStatus: 404 });

    await assert.rejects(
      () => fetchAndExtract(competitor(origin, 'auto'), `${origin}/p/gone`),
      (err: unknown) => {
        assert.ok(err instanceof ScrapeError);
        assert.equal(err.kind, 'not_found');
        return true;
      },
    );

    assert.equal(productHits(), 1, 'a 404 is an answer, not a rendering problem');
  });

  it('honours an explicit http mode without attempting to escalate', async () => {
    // No price in the JSON-LD: under 'auto' this is the one case that *would*
    // escalate. Pinned to 'http' it must simply fail.
    const { origin, productHits } = await standIn({ price: null });

    await assert.rejects(
      () => fetchAndExtract(competitor(origin, 'http'), `${origin}/p/nopricee`),
      (err: unknown) => {
        assert.ok(err instanceof ScrapeError);
        assert.equal(err.kind, 'no_price_found');
        return true;
      },
    );

    assert.equal(productHits(), 1, 'an explicit mode is a decision, not a preference');
  });

  it('leaves the competitor object unmutated', async () => {
    const { origin } = await standIn({ price: '250.00' });
    const subject = competitor(origin, 'auto');

    await fetchAndExtract(subject, `${origin}/p/two`);

    // The same Competitor object is shared across every product for that
    // competitor, and up to three competitors run concurrently — forcing the
    // mode by mutating it would race and corrupt work already in flight.
    assert.equal(subject.config.rendering, 'auto');
  });
});
