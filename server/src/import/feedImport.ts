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

  // Record the import first so every row written can be stamped with it. That
  // stamp is what lets a later import tell its own rows from an earlier one's.
  const { rows: importRows } = await withTransaction(async (client) =>
    client.query<{ id: number }>(
      'INSERT INTO feed_imports (fascia_id, filename, rows_read) VALUES ($1, $2, $3) RETURNING id',
      [fascia.id, filename, rows.length],
    ),
  );
  const feedImportId = importRows[0]!.id;

  const result: FeedImportResult = {
    totalRows: rows.length,
    stalePricesRemoved: 0,
    productsDelisted: 0,
    productsRelisted: 0,
    feedImportId,
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
    availability: {},
    fascia: { code: fascia.code, name: fascia.name },
  };

  await withTransaction(async (client) => {
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

      const { rows: upserted } = await client.query<{ id: number; existed: boolean }>(
        `INSERT INTO products
           (internal_sku, brand, product_name, ean_mpn, category, our_product_url, specs)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (internal_sku) DO UPDATE SET
           brand           = EXCLUDED.brand,
           product_name    = EXCLUDED.product_name,
           ean_mpn         = COALESCE(EXCLUDED.ean_mpn, products.ean_mpn),
           category        = EXCLUDED.category,
           our_product_url = EXCLUDED.our_product_url,
           specs           = products.specs || EXCLUDED.specs,
           updated_at      = now()
         RETURNING id, (xmax <> 0) AS existed`,
        [
          sku,
          get('brand') || 'Unknown',
          title,
          identifier,
          get('product_type') || null,
          get('link') || null,
          JSON.stringify(specs),
        ],
      );
      const product = upserted[0]!;
      if (product.existed) result.productsUpdated += 1;
      else result.productsCreated += 1;

      // A product whose price is not shown on the website has no price to
      // compare, so none is recorded for it.
      if (get('price_visible').toUpperCase() === 'FALSE') {
        result.priceHidden += 1;
        continue;
      }

      const regular = parseFeedPrice(get('price'));
      if (!regular) {
        result.failed += 1;
        result.errors.push({
          row: rowNumber,
          id: sku,
          error: `price "${get('price')}" could not be read`,
        });
        continue;
      }

      const sale = parseFeedPrice(get('sale_price'));
      // A sale counts only when it is genuinely cheaper AND its window is open:
      // the feed carries scheduled promotions that are not live yet.
      const windowOpen = isSaleWindowOpen(get('sale_price_effective_date'));
      if (sale !== null && sale.amount < regular.amount && !windowOpen) {
        result.saleNotYetActive += 1;
      }
      const useSale = sale !== null && sale.amount < regular.amount && windowOpen;
      if (useSale) result.onSale += 1;

      await client.query(
        `INSERT INTO fascia_prices
           (product_id, fascia_id, price, regular_price, on_sale, currency,
            imported_at, feed_import_id)
         VALUES ($1, $2, $3, $4, $5, $6, now(), $7)
         ON CONFLICT (product_id, fascia_id) DO UPDATE SET
           feed_import_id = EXCLUDED.feed_import_id,
           price         = EXCLUDED.price,
           regular_price = EXCLUDED.regular_price,
           on_sale       = EXCLUDED.on_sale,
           currency      = EXCLUDED.currency,
           imported_at   = now()`,
        [
          product.id,
          fascia.id,
          useSale ? sale!.amount : regular.amount,
          useSale ? regular.amount : null,
          useSale,
          regular.currency ?? fascia.currency,
          feedImportId,
        ],
      );
      result.pricesWritten += 1;
    }
  });

  // The feed is authoritative for its fascia, so anything it did not mention is
  // no longer sold there. Done after the loop so a failure part-way through
  // cannot delist products the feed actually contained.
  await withTransaction(async (client) => {
    const { rowCount: stale } = await client.query(
      `DELETE FROM fascia_prices
       WHERE fascia_id = $1 AND (feed_import_id IS DISTINCT FROM $2)`,
      [fascia.id, feedImportId],
    );
    result.stalePricesRemoved = stale ?? 0;

    // A product with no price at any fascia is not currently sold by us.
    const { rowCount: delisted } = await client.query(
      `UPDATE products p SET delisted_at = now(), updated_at = now()
       WHERE p.delisted_at IS NULL
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
