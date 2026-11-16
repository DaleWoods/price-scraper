import { query } from '../db/pool.js';
import { logger } from '../lib/logger.js';
import {
  ownSiteFor,
  readOwnProductBySku,
  readOwnProductPage,
  type OwnProduct,
} from '../ownSite/readOwnProduct.js';
import { skusForReference } from '../ownSite/ownIndex.js';
import { listCompetitors } from '../scraping/competitorRegistry.js';
import { startRun } from '../scraping/runner.js';
import { resolveProducts } from './productLookup.js';

/**
 * Check a product: paste one of our URLs, a SKU, a manufacturer reference or a
 * barcode, and see which competitors sell the same product and for how much.
 *
 * The product is read from our own website — name, brand, price, reference —
 * so nothing has to be typed in. Each enabled competitor is then checked for
 * an exact match (same barcode, or same reference on a page naming the
 * brand). Nothing is reported on likeness of name alone.
 */

/** A message meant for the person using the page. */
export class LookupError extends Error {}

export async function startLookup(input: string, preferredFasciaCode?: string | null): Promise<{ productId: number }> {
  const text = input.trim();
  if (!text) throw new LookupError('Enter a product URL, SKU, manufacturer reference or barcode.');

  let own: OwnProduct | null = null;
  let productId: number | null = null;

  if (/^https?:\/\//i.test(text)) {
    if (!ownSiteFor(text)) {
      throw new LookupError(
        "That address isn't one of our sites. Paste a product page from Goldsmiths, Mappin & Webb or Watches of Switzerland.",
      );
    }
    own = await readOwnProductPage(text);
    if (!own) throw new LookupError('There is no product at that address on our site.');
  } else {
    const { productIds } = await resolveProducts([text]);
    productId = productIds[0] ?? null;

    // Read the live page for the price on the site today and the reference,
    // which a feed does not always carry. By SKU — ours, or the one a
    // reference or barcode led to.
    let sku: string | null = /^[0-9]{6,10}$/.test(text) ? text : null;
    if (productId != null) {
      const { rows } = await query<{ internal_sku: string }>('SELECT internal_sku FROM products WHERE id = $1', [productId]);
      sku = rows[0]?.internal_sku ?? sku;
    }
    if (sku) {
      try {
        own = await readOwnProductBySku(sku, preferredFasciaCode);
      } catch (err) {
        // Our site being slow is no reason to refuse a product we already hold.
        if (productId == null) throw err;
        logger.warn('lookup', `could not read our own page for ${sku}: ${(err as Error).message}`);
      }
    }
    // A reference we do not hold: our own addresses carry the reference, so
    // find the product there.
    if (!own && productId == null && !/^[0-9]{12,14}$/.test(text.replace(/[\s-]/g, ''))) {
      for (const hit of await skusForReference(text, preferredFasciaCode)) {
        own = await readOwnProductBySku(hit.sku, hit.fasciaCode);
        if (own) break;
      }
    }
    if (!own && productId == null) {
      throw new LookupError(
        /^[0-9]{12,14}$/.test(text.replace(/[\s-]/g, ''))
          ? `We don't hold a product with barcode ${text} yet, and our website doesn't show barcodes to search by. Try its SKU, reference or address.`
          : `We couldn't find "${text}" on our sites or in our product feeds. Try its SKU, or paste the product's address from our website.`,
      );
    }
  }

  if (own) productId = await saveOwnProduct(own, productId);
  await query('UPDATE products SET looked_up_at = now(), delisted_at = NULL WHERE id = $1', [productId]);
  await startRun({ mode: 'both', productId, trigger: 'lookup', exclusive: false });
  return { productId: productId! };
}

/** Store what our own page said, adding to a product we already hold rather than replacing it. */
export async function saveOwnProduct(own: OwnProduct, existingId: number | null): Promise<number> {
  const { rows } = await query<{ id: number }>(
    `INSERT INTO products
       (internal_sku, brand, product_name, ean_mpn, mpn, category, our_product_url, image_url, specs, source)
     VALUES ($1, $2, $3, $4, $4, $5, $6, $7, $8::jsonb, 'manual')
     ON CONFLICT (internal_sku) DO UPDATE SET
       brand           = EXCLUDED.brand,
       product_name    = EXCLUDED.product_name,
       mpn             = COALESCE(products.mpn, EXCLUDED.mpn),
       ean_mpn         = COALESCE(products.ean_mpn, EXCLUDED.ean_mpn),
       category        = COALESCE(products.category, EXCLUDED.category),
       our_product_url = EXCLUDED.our_product_url,
       image_url       = EXCLUDED.image_url,
       updated_at      = now()
     RETURNING id`,
    [
      own.sku,
      own.brand,
      own.name,
      own.mpn,
      own.category,
      own.url,
      own.imageUrl,
      JSON.stringify(own.mpn ? { reference_number: own.mpn } : {}),
    ],
  );
  const id = existingId ?? rows[0]!.id;

  await query(
    `INSERT INTO fascia_prices (product_id, fascia_id, price, regular_price, on_sale, currency, product_url)
     SELECT $1, f.id, $3, $4, $5, 'GBP', $6 FROM fascias f WHERE f.code = $2
     ON CONFLICT (product_id, fascia_id) DO UPDATE SET
       price = EXCLUDED.price, regular_price = EXCLUDED.regular_price, on_sale = EXCLUDED.on_sale,
       product_url = EXCLUDED.product_url, imported_at = now()`,
    [id, own.fasciaCode, own.price, own.wasPrice, own.wasPrice != null, own.url],
  );
  return id;
}

export type CompetitorStatus = 'found' | 'checking' | 'not_found' | 'blocked' | 'error' | 'not_checked';

export interface LookupCompetitor {
  slug: string;
  name: string;
  status: CompetitorStatus;
  price: number | null;
  wasPrice: number | null;
  onSale: boolean;
  inStock: boolean | null;
  url: string | null;
  title: string | null;
  seenAt: string | null;
  /** How the match was made: 'barcode' or 'reference'. */
  matchedOn: string | null;
  note: string | null;
}

export interface LookupResult {
  product: {
    id: number;
    sku: string;
    name: string;
    brand: string;
    mpn: string | null;
    gtin: string | null;
    url: string | null;
    imageUrl: string | null;
    siteName: string | null;
    price: number | null;
    wasPrice: number | null;
  };
  running: boolean;
  checkedAt: string | null;
  competitors: LookupCompetitor[];
}

export async function getLookup(productId: number, runId?: number | null): Promise<LookupResult | null> {
  const { rows: products } = await query<{
    id: number;
    internal_sku: string;
    product_name: string;
    brand: string;
    mpn: string | null;
    gtin: string | null;
    ean_mpn: string | null;
    our_product_url: string | null;
    image_url: string | null;
    site_name: string | null;
    price: string | null;
    regular_price: string | null;
    product_url: string | null;
  }>(
    `SELECT p.*, f.name AS site_name, fp.price, fp.regular_price, fp.product_url
     FROM products p
     LEFT JOIN LATERAL (
       SELECT * FROM fascia_prices WHERE product_id = p.id ORDER BY imported_at DESC LIMIT 1
     ) fp ON TRUE
     LEFT JOIN fascias f ON f.id = fp.fascia_id
     WHERE p.id = $1`,
    [productId],
  );
  const product = products[0];
  if (!product) return null;

  const { rows: runs } = await query<{ id: number; status: string; started_at: string; finished_at: string | null }>(
    // A product checked as part of a list belongs to that list's run, which
    // names no single product; otherwise its own most recent check.
    runId != null
      ? `SELECT id, status, started_at, finished_at FROM scrape_runs WHERE id = $1`
      : `SELECT id, status, started_at, finished_at FROM scrape_runs
         WHERE product_id = $1 ORDER BY id DESC LIMIT 1`,
    runId != null ? [runId] : [productId],
  );
  const run = runs[0] ?? null;
  const running = run?.status === 'running';

  const { rows: found } = await query<{
    competitor_id: number;
    competitor_url: string;
    competitor_title: string | null;
    evidence: { notes?: string[] } | null;
    price: string | null;
    was_price: string | null;
    promo: boolean | null;
    in_stock: boolean | null;
    observed_at: string | null;
    source_url: string | null;
  }>(
    `SELECT m.competitor_id, m.competitor_url, m.competitor_title, m.evidence,
            po.price, po.was_price, po.promo, po.in_stock, po.observed_at, po.source_url
     FROM product_matches m
     LEFT JOIN LATERAL (
       SELECT * FROM price_observations WHERE match_id = m.id ORDER BY observed_at DESC LIMIT 1
     ) po ON TRUE
     WHERE m.product_id = $1 AND m.status = 'confirmed' AND m.flagged_at IS NULL`,
    [productId],
  );
  const foundBy = new Map(found.map((row) => [Number(row.competitor_id), row]));

  const { rows: items } = run
    ? await query<{ competitor_id: number; status: string; error_kind: string | null; error: string | null }>(
        `SELECT DISTINCT ON (competitor_id) competitor_id, status, error_kind, error
         FROM scrape_run_items
         WHERE run_id = $1 AND product_id = $2
         ORDER BY competitor_id, id DESC`,
        [run.id, productId],
      )
    : { rows: [] };
  const itemBy = new Map(items.map((row) => [Number(row.competitor_id), row]));

  const competitors = (await listCompetitors(true)).map((competitor): LookupCompetitor => {
    const base: LookupCompetitor = {
      slug: competitor.slug,
      name: competitor.display_name,
      status: 'not_checked',
      price: null,
      wasPrice: null,
      onSale: false,
      inStock: null,
      url: null,
      title: null,
      seenAt: null,
      matchedOn: null,
      note: null,
    };

    const match = foundBy.get(Number(competitor.id));
    if (match) {
      const viaReference = (match.evidence?.notes ?? []).some((note) => /reference/i.test(note));
      return {
        ...base,
        status: match.price != null ? 'found' : running ? 'checking' : 'error',
        price: match.price != null ? Number(match.price) : null,
        wasPrice: match.was_price != null ? Number(match.was_price) : null,
        onSale: Boolean(match.promo),
        inStock: match.in_stock,
        url: match.source_url ?? match.competitor_url,
        title: match.competitor_title,
        seenAt: match.observed_at,
        matchedOn: viaReference ? 'reference' : 'barcode',
        note: match.price == null && !running ? 'Matched, but the price could not be read this time.' : null,
      };
    }

    const item = itemBy.get(Number(competitor.id));
    if (!item) return { ...base, status: run ? (running ? 'checking' : 'not_found') : 'not_checked' };
    if (item.error_kind === 'blocked' || item.error_kind === 'robots_disallowed') {
      return { ...base, status: 'blocked', note: 'This retailer turned the check away.' };
    }
    if (item.status === 'error') {
      return { ...base, status: running ? 'checking' : 'error', note: running ? null : 'The check failed this time.' };
    }
    return { ...base, status: running ? 'checking' : 'not_found' };
  });

  return {
    product: {
      id: Number(product.id),
      sku: product.internal_sku,
      name: product.product_name,
      brand: product.brand,
      mpn: product.mpn ?? (product.ean_mpn && !/^[0-9]{12,14}$/.test(product.ean_mpn) ? product.ean_mpn : null),
      gtin: product.gtin,
      url: product.product_url ?? product.our_product_url,
      imageUrl: product.image_url,
      siteName: product.site_name,
      price: product.price != null ? Number(product.price) : null,
      wasPrice: product.regular_price != null ? Number(product.regular_price) : null,
    },
    running,
    checkedAt: run?.finished_at ?? run?.started_at ?? null,
    competitors,
  };
}

export async function recentLookups(limit = 12): Promise<
  { productId: number; sku: string; name: string; brand: string; lookedUpAt: string; found: number }[]
> {
  const { rows } = await query<{
    id: number;
    internal_sku: string;
    product_name: string;
    brand: string;
    looked_up_at: string;
    found: number;
  }>(
    `SELECT p.id, p.internal_sku, p.product_name, p.brand, p.looked_up_at,
            (SELECT count(*)::int FROM product_matches m
              WHERE m.product_id = p.id AND m.status = 'confirmed' AND m.flagged_at IS NULL) AS found
     FROM products p WHERE p.looked_up_at IS NOT NULL
     ORDER BY p.looked_up_at DESC LIMIT $1`,
    [limit],
  );
  return rows.map((row) => ({
    productId: Number(row.id),
    sku: row.internal_sku,
    name: row.product_name,
    brand: row.brand,
    lookedUpAt: row.looked_up_at,
    found: row.found,
  }));
}
