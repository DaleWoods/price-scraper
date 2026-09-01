import { createServer, type Server } from 'node:http';

/**
 * A stand-in retailer for runner tests.
 *
 * `runner.ts` reads competitors from the database and reaches them over HTTP,
 * with no injection seam — so testing it honestly means giving it a real site
 * to talk to. This is that site: robots.txt, a sitemap and product pages, with
 * per-product behaviour a test can bend (404, 403, no price, out of stock).
 *
 * It also records every product-page request, which is how the tests assert
 * things no database row can show: that a non-retryable failure was not
 * retried, and that a brand a competitor does not stock is skipped *before*
 * any request is made.
 */
export interface StandInProduct {
  /**
   * Short handle the tests use to name this product. It is NOT the URL: the
   * page is served at a realistic retail slug built from brand and name, and
   * `pathFor(handle)` resolves one to the other.
   */
  slug: string;
  name: string;
  brand: string;
  /** Omit to serve a page with no readable price at all. */
  price?: string;
  gtin?: string;
  /** Force an HTTP status instead of serving the page — 404 or 403, typically. */
  status?: number;
  /** Defaults to true. False publishes an OutOfStock availability. */
  inStock?: boolean;
}

export interface StandIn {
  origin: string;
  /** Every product-page path requested, in order. */
  requests: string[];
  /** How many times one product's page was requested. */
  hits(handle: string): number;
  /** The path a product is served at, e.g. `/p/testbrand-runner-watch-a`. */
  pathFor(handle: string): string;
  /** The absolute URL a product is served at. */
  urlFor(handle: string): string;
  close(): Promise<void>;
}

/**
 * The URL slug a product is served under.
 *
 * Deliberately a realistic retail slug rather than the short handle, because
 * sitemap discovery ranks cached URLs by full-text search over their slug
 * words (`slugWords` in sitemap.ts). A page at `/p/a` carries no searchable
 * word at all — "a" is one character and "p" is a stop word — so a product
 * would never surface as its own candidate and every discovery test would
 * fail for a reason that has nothing to do with the runner.
 */
export function slugFor(product: StandInProduct): string {
  return `${product.brand} ${product.name}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function productHtml(product: StandInProduct): string {
  const jsonLd: Record<string, unknown> = {
    '@type': 'Product',
    name: product.name,
    brand: { name: product.brand },
    ...(product.gtin ? { gtin13: product.gtin } : {}),
  };

  if (product.price) {
    // The nested offer needs its own @type. extract.ts finds the offer node by
    // looking for @type offer/aggregateoffer, so an unlabelled object is
    // invisible to it and the page reads as having no price — which has cost
    // real debugging time before.
    jsonLd.offers = {
      '@type': 'Offer',
      price: product.price,
      priceCurrency: 'GBP',
      availability:
        product.inStock === false
          ? 'https://schema.org/OutOfStock'
          : 'https://schema.org/InStock',
    };
  }

  return (
    `<html><head><script type="application/ld+json">${JSON.stringify(jsonLd)}</script></head>` +
    `<body><h1>${product.name}</h1></body></html>`
  );
}

/**
 * Start a stand-in retailer serving the given products.
 *
 * Binds to port 0 and reports the assigned port, so parallel test files never
 * collide on a fixed one.
 */
export async function startStandIn(products: StandInProduct[]): Promise<StandIn> {
  const requests: string[] = [];
  const bySlug = new Map(products.map((product) => [slugFor(product), product]));
  const pathByHandle = new Map(products.map((product) => [product.slug, `/p/${slugFor(product)}`]));

  function pathFor(handle: string): string {
    const path = pathByHandle.get(handle);
    if (!path) throw new Error(`no stand-in product with handle "${handle}"`);
    return path;
  }

  const server = createServer((req, res) => {
    const url = req.url ?? '/';

    if (url === '/robots.txt') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(`User-agent: *\nDisallow: /search\nSitemap: ${origin()}/sitemap.xml\n`);
      return;
    }

    if (url === '/sitemap.xml') {
      const entries = products
        .map((product) => `<url><loc>${origin()}${pathFor(product.slug)}</loc></url>`)
        .join('');
      res.writeHead(200, { 'content-type': 'application/xml' });
      res.end(`<?xml version="1.0" encoding="UTF-8"?><urlset>${entries}</urlset>`);
      return;
    }

    const match = /^\/p\/([^/?]+)/.exec(url);
    if (match) {
      const product = bySlug.get(match[1]!);
      requests.push(url);
      if (!product) {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('no such product');
        return;
      }
      if (product.status && product.status !== 200) {
        res.writeHead(product.status, { 'content-type': 'text/plain' });
        res.end(`status ${product.status}`);
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(productHtml(product));
      return;
    }

    res.writeHead(404);
    res.end();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

  function origin(): string {
    const address = (server as Server).address();
    const port = typeof address === 'object' && address ? address.port : 0;
    return `http://127.0.0.1:${port}`;
  }

  return {
    origin: origin(),
    requests,
    hits: (handle: string) => {
      const path = pathFor(handle);
      return requests.filter((requested) => requested === path).length;
    },
    pathFor,
    urlFor: (handle: string) => `${origin()}${pathFor(handle)}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/**
 * The competitor config the stand-in expects.
 *
 * Zero delays keep the suite quick, one retry attempt stops a deliberate
 * failure taking three, and `rendering: 'http'` keeps Chromium out of the test
 * run entirely — the escalation path has its own coverage in
 * fetchAndExtract.test.ts.
 */
export function standInConfig(brands: string[] = []): {
  brands: string[];
  config: Record<string, unknown>;
} {
  return {
    brands,
    config: {
      discovery: 'sitemap',
      rendering: 'http',
      rateLimit: { minDelayMs: 0, jitterMs: 0, maxConcurrent: 1 },
      retry: { attempts: 1, backoffMs: 10 },
      product: { useJsonLd: true, sanityContains: ['h1'] },
    },
  };
}
