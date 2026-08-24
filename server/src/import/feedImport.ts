import { withTransaction } from '../db/pool.js';
import { canonicalAttributeName } from '../matching/attributes.js';
import { parseTabularFile } from './parseTabular.js';

/**
 * Google Shopping feed import.
 *
 * One feed per fascia, carrying both product content and the price that fascia
 * actually shows. This is a better source than the SAP exports it replaces: the
 * prices are the ones on the website rather than condition records needing
 * precedence rules applied, and every row carries the live product URL.
 */

export interface FeedImportResult {
  totalRows: number;
  /** Blank padding rows and stray repeated header rows, skipped silently. */
  skippedBlank: number;
  skippedHeaderRepeat: number;
  productsCreated: number;
  productsUpdated: number;
  pricesWritten: number;
  onSale: number;
  /** Cheaper sale prices whose effective window has not opened, or has closed. */
  saleNotYetActive: number;
  /** Rows whose price could not be read, or which had no usable SKU. */
  failed: number;
  errors: { row: number; id: string | null; error: string }[];
  /** Identifiers Excel destroyed into scientific notation, so unusable for matching. */
  damagedGtin: number;
  damagedMpn: number;
  /** Products carrying a usable EAN/MPN — the strongest matching key. */
  withUsableIdentifier: number;
  /** price_visible=FALSE: no price shown to customers, so none recorded. */
  priceHidden: number;
  /** availability is not an in-stock value: no price recorded, same as price_visible=FALSE. */
  outOfStock: number;
  availability: Record<string, number>;
  fascia: { code: string; name: string };
  /** Prices this fascia no longer lists, removed because the feed is authoritative. */
  stalePricesRemoved: number;
  /** Products no longer in any fascia's latest feed, so no longer scanned. */
  productsDelisted: number;
  /** Products the feed brought back after a previous absence. */
  productsRelisted: number;
  feedImportId: number;
}

/**
 * Excel turns long numeric identifiers into scientific notation ("7.32E+11"),
 * destroying them. Such a value must never be stored as an EAN: it would not
 * match the real barcode, and could collide with another mangled one.
 */
export function isDamagedIdentifier(value: string): boolean {
  return /^\d(\.\d+)?E\+\d+$/i.test(value.trim());
}

/**
 * Google's availability values are usually underscored ("out_of_stock"); this
 * feed's exports space them ("out of stock"). Either reads fine once
 * normalised. A value that isn't recognised at all is treated as in stock
 * rather than silently dropping every row of a feed that doesn't populate the
 * column — the same fail-open choice already made for a blank field.
 */
export function isInStock(rawAvailability: string): boolean {
  const value = rawAvailability.trim().toLowerCase().replace(/[\s_-]+/g, '_');
  if (!value) return true;
  const outOfStockValues = new Set(['out_of_stock', 'preorder', 'backorder']);
  return !outOfStockValues.has(value);
}

/**
 * Is a feed sale window open right now?
 *
 * Google states the window as two ISO timestamps separated by a slash. A sale
 * that has not started, or has finished, must not be applied — otherwise a
 * scheduled promotion becomes today's price and we report ourselves cheaper
 * than we are. An empty or unparseable window means "no restriction", matching
 * Google's own treatment of an absent field.
 */
export function isSaleWindowOpen(raw: string | undefined, now: Date = new Date()): boolean {
  const value = (raw ?? '').trim();
  if (!value) return true;

  const [from, to] = value.split('/').map((part) => part.trim());
  const start = from ? new Date(from) : null;
  const end = to ? new Date(to) : null;

  if (start && !Number.isNaN(start.getTime()) && now < start) return false;
  if (end && !Number.isNaN(end.getTime()) && now > end) return false;
  return true;
}

/** "1900.0 GBP" -> { amount: 1900, currency: 'GBP' } */
export function parseFeedPrice(raw: string): { amount: number; currency: string | null } | null {
  const value = (raw ?? '').trim();
  if (!value) return null;

  const match = value.match(/^([\d.,]+)\s*([A-Z]{3})?$/i);
  if (!match) return null;

  const amount = Number.parseFloat((match[1] ?? '').replace(/,/g, ''));
  if (!Number.isFinite(amount) || amount < 0) return null;

  return { amount: Math.round(amount * 100) / 100, currency: match[2]?.toUpperCase() ?? null };
}

/**
 * Rows written per statement. Large enough that the round trips stop mattering,
 * small enough to stay well inside Postgres' 65535 bound on bind parameters
 * (the widest statement here binds 7 per row).
 */
const WRITE_CHUNK = 500;

function* chunked<T>(items: T[], size: number): Generator<T[]> {
  for (let i = 0; i < items.length; i += size) yield items.slice(i, i + size);
}

/** Columns that are content or plumbing rather than product attributes. */
const NON_SPEC_COLUMNS = new Set([
  'id',
  'title',
  'description',
  'google_product_category',
  'product_type',
  'link',
  'imagelink',
  'additional_image_link',
  'condition',
  'availability',
  'delivery_time',
  'price',
  'sale_price',
  'sale_price_effective_date',
  'price_visible',
  'brand',
  'gtin',
  'mpn',
  'offers',
  'item_group_id',
]);

export async function importFeed(
  buffer: Buffer,
  filename: string,
  fasciaCode: string,
): Promise<FeedImportResult> {
  const { headers, rows } = await parseTabularFile(buffer, filename);
  if (headers.length === 0) {
    throw new Error('The uploaded feed appears to be empty — no header row was found.');
  }
  if (!headers.includes('id') || !headers.includes('price')) {
    throw new Error(
      `This does not look like a Google feed: expected "id" and "price" columns. ` +
        `Found: ${headers.filter(Boolean).slice(0, 15).join(', ')}`,
    );
  }

  const fasciaRows = await withTransaction(async (client) =>
    client.query<{ id: number; code: string; name: string; currency: string }>(
      'SELECT id, code, name, currency FROM fascias WHERE code = $1',
      [fasciaCode],
    ),
  );
  const fascia = fasciaRows.rows[0];
  if (!fascia) throw new Error(`No fascia configured with code "${fasciaCode}".`);

  const result: FeedImportResult = {
    totalRows: rows.length,
    stalePricesRemoved: 0,
    productsDelisted: 0,
    productsRelisted: 0,
    feedImportId: 0,
    skippedBlank: 0,
    skippedHeaderRepeat: 0,
    productsCreated: 0,
    productsUpdated: 0,
    pricesWritten: 0,
    onSale: 0,
    saleNotYetActive: 0,
    failed: 0,
    errors: [],
    damagedGtin: 0,
    damagedMpn: 0,
    withUsableIdentifier: 0,
    priceHidden: 0,
    outOfStock: 0,
    availability: {},
    fascia: { code: fascia.code, name: fascia.name },
  };

  /** One product's worth of parsed feed row, ready to write. */
  interface ParsedProduct {
    sku: string;
    brand: string;
    title: string;
    identifier: string | null;
    category: string | null;
    link: string | null;
    specs: string;
    price: { amount: number; regular: number | null; onSale: boolean; currency: string } | null;
  }

  const parsed: ParsedProduct[] = [];

  for (const { rowNumber, values } of rows) {
    const get = (key: string) => (values[key] ?? '').trim();
    const sku = get('id');

    if (!sku) {
      result.skippedBlank += 1;
      continue;
    }
    // The export repeats its own header part-way through the file.
    if (sku === 'id') {
      result.skippedHeaderRepeat += 1;
      continue;
    }

    const title = get('title');
    if (!title) {
      result.failed += 1;
      result.errors.push({ row: rowNumber, id: sku, error: 'title is missing' });
      continue;
    }

    // Prefer GTIN — a real barcode is the strongest match — but only when it
    // survived export intact.
    const rawGtin = get('gtin');
    const rawMpn = get('mpn');
    if (rawGtin && isDamagedIdentifier(rawGtin)) result.damagedGtin += 1;
    if (rawMpn && isDamagedIdentifier(rawMpn)) result.damagedMpn += 1;

    const identifier =
      rawGtin && !isDamagedIdentifier(rawGtin)
        ? rawGtin
        : rawMpn && !isDamagedIdentifier(rawMpn)
          ? rawMpn
          : null;
    if (identifier) result.withUsableIdentifier += 1;

    const availability = get('availability') || 'unknown';
    result.availability[availability] = (result.availability[availability] ?? 0) + 1;

    const specs: Record<string, string> = {};
    for (const header of headers) {
      if (!header || NON_SPEC_COLUMNS.has(header)) continue;
      const value = get(header);
      if (value) specs[canonicalAttributeName(header)] = value;
    }
    // Kept as an attribute so ring-size variants of one product stay linked.
    const groupId = get('item_group_id');
    if (groupId) specs.item_group_id = groupId;

    let price: ParsedProduct['price'] = null;
    if (get('price_visible').toUpperCase() === 'FALSE') {
      // Not shown to customers, so there is nothing to compare.
      result.priceHidden += 1;
    } else if (!isInStock(availability)) {
      // Not currently sellable, so a competitor being cheaper on it is not
      // useful information — treated the same as a hidden price. Delisted
      // like any other product the feed has stopped pricing (Spec: the feed
      // is authoritative for what a fascia sells).
      result.outOfStock += 1;
    } else {
      const regular = parseFeedPrice(get('price'));
      if (!regular) {
        result.failed += 1;
        result.errors.push({
          row: rowNumber,
          id: sku,
          error: `price "${get('price')}" could not be read`,
        });
      } else {
        const sale = parseFeedPrice(get('sale_price'));
        // A sale counts only when genuinely cheaper AND its window is open: the
        // feed carries scheduled promotions that are not live yet.
        const cheaper = sale !== null && sale.amount < regular.amount;
        const windowOpen = isSaleWindowOpen(get('sale_price_effective_date'));
        if (cheaper && !windowOpen) result.saleNotYetActive += 1;
        const useSale = cheaper && windowOpen;
        if (useSale) result.onSale += 1;

        price = {
          amount: useSale ? sale!.amount : regular.amount,
          regular: useSale ? regular.amount : null,
          onSale: useSale,
          currency: regular.currency ?? fascia.currency,
        };
      }
    }

    parsed.push({
      sku,
      brand: get('brand') || 'Unknown',
      title,
      identifier,
      category: get('product_type') || null,
      link: get('link') || null,
      specs: JSON.stringify(specs),
      price,
    });
  }

  // One transaction for the whole write: the import record, the rows it writes
  // and the cleanup that follows all land together or not at all. Recording the
  // import separately used to leave an orphan row behind a failed load.
  await withTransaction(async (client) => {
    const { rows: importRows } = await client.query<{ id: number }>(
      'INSERT INTO feed_imports (fascia_id, filename, rows_read) VALUES ($1, $2, $3) RETURNING id',
      [fascia.id, filename, rows.length],
    );
    const feedImportId = importRows[0]!.id;
    result.feedImportId = feedImportId;

    // Written in chunks rather than a row at a time: a feed is tens of thousands
    // of rows, and a round trip each would dominate the import.
    const skuToId = new Map<string, number>();

    for (const chunk of chunked(parsed, WRITE_CHUNK)) {
      const values: unknown[] = [];
      const tuples = chunk.map((product, index) => {
        const base = index * 7;
        values.push(
          product.sku,
          product.brand,
          product.title,
          product.identifier,
          product.category,
          product.link,
          product.specs,
        );
        return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}::jsonb)`;
      });

      const { rows: upserted } = await client.query<{
        id: number;
        internal_sku: string;
        existed: boolean;
      }>(
        `INSERT INTO products
           (internal_sku, brand, product_name, ean_mpn, category, our_product_url, specs)
         VALUES ${tuples.join(', ')}
         ON CONFLICT (internal_sku) DO UPDATE SET
           brand           = EXCLUDED.brand,
           product_name    = EXCLUDED.product_name,
           ean_mpn         = COALESCE(EXCLUDED.ean_mpn, products.ean_mpn),
           category        = EXCLUDED.category,
           our_product_url = EXCLUDED.our_product_url,
           specs           = products.specs || EXCLUDED.specs,
           updated_at      = now()
         RETURNING id, internal_sku, (xmax <> 0) AS existed`,
        values,
      );

      for (const product of upserted) {
        skuToId.set(product.internal_sku, product.id);
        if (product.existed) result.productsUpdated += 1;
        else result.productsCreated += 1;
      }
    }

    const priced = parsed.filter((product) => product.price !== null);
    for (const chunk of chunked(priced, WRITE_CHUNK)) {
      const values: unknown[] = [];
      const tuples: string[] = [];
      for (const product of chunk) {
        const productId = skuToId.get(product.sku);
        if (productId === undefined) continue;
        const base = values.length;
        values.push(
          productId,
          fascia.id,
          product.price!.amount,
          product.price!.regular,
          product.price!.onSale,
          product.price!.currency,
          feedImportId,
        );
        tuples.push(
          `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, now(), $${base + 7})`,
        );
      }
      if (tuples.length === 0) continue;

      await client.query(
        `INSERT INTO fascia_prices
           (product_id, fascia_id, price, regular_price, on_sale, currency,
            imported_at, feed_import_id)
         VALUES ${tuples.join(', ')}
         ON CONFLICT (product_id, fascia_id) DO UPDATE SET
           feed_import_id = EXCLUDED.feed_import_id,
           price          = EXCLUDED.price,
           regular_price  = EXCLUDED.regular_price,
           on_sale        = EXCLUDED.on_sale,
           currency       = EXCLUDED.currency,
           imported_at    = now()`,
        values,
      );
      result.pricesWritten += tuples.length;
    }

    // The feed is authoritative for its fascia, so anything it did not mention
    // is no longer sold there. Done after the writes so a failure part-way
    // through cannot delist products the feed actually contained.
    // Hand-added products are exempt. They are test fixtures with no feed to
    // appear in, so applying the feed's authority to them would delete the very
    // thing you are testing with.
    const { rowCount: stale } = await client.query(
      `DELETE FROM fascia_prices fp
       USING products p
       WHERE fp.product_id = p.id
         AND fp.fascia_id = $1
         AND fp.feed_import_id IS DISTINCT FROM $2
         AND p.source <> 'manual'`,
      [fascia.id, feedImportId],
    );
    result.stalePricesRemoved = stale ?? 0;

    // A product with no price at any fascia is not currently sold by us.
    const { rowCount: delisted } = await client.query(
      `UPDATE products p SET delisted_at = now(), updated_at = now()
       WHERE p.delisted_at IS NULL
         AND p.source <> 'manual'
         AND NOT EXISTS (SELECT 1 FROM fascia_prices fp WHERE fp.product_id = p.id)`,
    );
    result.productsDelisted = delisted ?? 0;

    // And one that has a price again is back on sale.
    const { rowCount: relisted } = await client.query(
      `UPDATE products p SET delisted_at = NULL, updated_at = now()
       WHERE p.delisted_at IS NOT NULL
         AND EXISTS (SELECT 1 FROM fascia_prices fp WHERE fp.product_id = p.id)`,
    );
    result.productsRelisted = relisted ?? 0;

    await client.query(
      `UPDATE feed_imports
       SET products_seen = $2, prices_written = $3, delisted = $4
       WHERE id = $1`,
      [
        feedImportId,
        result.productsCreated + result.productsUpdated,
        result.pricesWritten,
        result.productsDelisted,
      ],
    );
  });

  result.errors = result.errors.slice(0, 200);
  return result;
}
