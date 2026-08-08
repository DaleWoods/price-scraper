import { withTransaction } from '../db/pool.js';
import type { SpecAttributes } from '../domain/types.js';
import { canonicalAttributeName } from '../matching/attributes.js';
import { countFilled, parseTabularFile } from './parseTabular.js';

export interface ImportRowError {
  row: number;
  internalSku: string | null;
  errors: string[];
}

export interface ImportResult {
  totalRows: number;
  created: number;
  updated: number;
  failed: number;
  duplicateSkusCollapsed: number;
  errors: ImportRowError[];
  /** Spec columns that were imported as extensible attributes. */
  specColumnsDetected: string[];
  /** Which source column (or derivation) supplied each core field. */
  columnMapping: Record<string, string>;
  /** Columns deliberately skipped, with the reason — so nothing vanishes silently. */
  ignoredColumns: { column: string; reason: string }[];
  /** How many imported products still have no price of ours. */
  awaitingPrice: number;
  priceColumnFound: boolean;
}

/**
 * Header aliases for the known fields, in PRIORITY ORDER — the earlier alias wins
 * when several columns could serve the same field. Anything unmatched becomes a
 * spec attribute, so the import accepts an open set rather than a fixed list
 * (Spec §5.1).
 *
 * Two orderings here are deliberate and load-bearing for real SAP exports:
 *   - `page title` outranks `name`, because the master export repeats the
 *     collection name in `Name` for every variant ("Cosmograph Daytona" 66 times)
 *     while the page title is unique per product and carries size and metal.
 *   - `description` is NOT a name alias: in these exports it holds marketing HTML.
 */
const FIELD_ALIASES: Record<string, string[]> = {
  internal_sku: ['internal_sku', 'sku', 'internal sku', 'product code', 'productcode', 'item code', 'item number'],
  brand: ['brand', 'brand name'],
  product_name: ['product_name', 'product name', 'page title', 'title', 'name'],
  ean_mpn: ['ean_mpn', 'ean', 'gtin', 'ean/mpn', 'ean mpn', 'barcode', 'mpn', 'reference number', 'reference'],
  our_price: ['our_price', 'price', 'our price', 'rrp', 'selling price', 'retail price'],
  currency: ['currency', 'currency code', 'ccy'],
  category: ['category', 'categories', 'product category', 'product type'],
  our_product_url: ['our_product_url', 'url', 'product url', 'our url', 'link'],
  /**
   * Held separately rather than treated as the brand. In SAP master loadsheets
   * "Manufacturer Name" carries the collection ("Cosmograph Daytona"), not the
   * marque — and brand is a GATE attribute, so getting it wrong rejects every
   * candidate. Used as the brand only when nothing better is available; otherwise
   * it is stored as the `model` spec attribute, which is itself a watch gate.
   */
  manufacturer: ['manufacturer', 'manufacturer name'],
};

/** Product-type keywords, most specific first (winder before watch, engagement before ring). */
const CATEGORY_KEYWORDS: [RegExp, string][] = [
  [/watch\s*winder|winder/i, 'watch winders'],
  [/watch(es)?\b|timepiece/i, 'watches'],
  [/engagement|eternity|bridal|\brings?\b/i, 'rings'],
  [/necklace|pendant/i, 'necklaces'],
  [/bracelet|bangle/i, 'bracelets'],
  [/earring|\bstuds?\b/i, 'earrings'],
  [/cufflink|accessor/i, 'accessories'],
  [/\bgift/i, 'gifts'],
  [/jewellery|jewelry/i, 'jewellery'],
];

/** Type nouns stripped when deriving a brand from a category path. */
const CATEGORY_SUFFIX =
  /\s+(watch\s*winders?|watches|watch|jewellery|jewelry|rings?|necklaces?|bracelets?|earrings?|pendants?|gifts?|accessories)$/i;

/**
 * Columns that are site configuration or marketing copy rather than product
 * attributes. Left alone they become spec attributes: the HTML description alone
 * is a few hundred characters per row, and none of them says anything about which
 * physical product this is.
 */
const NON_ATTRIBUTE_COLUMNS: RegExp[] = [
  /^description/i,
  /^meta[\s_]/i,
  /on\s*site$/i,
  /^display\b/i,
  /^allow\s+purchase/i,
  /^is\s+virtual/i,
  /^use\s+png/i,
  /^exclude\s+from/i,
  /^see\s+more\s+styles/i,
  /^you\s+may\s+also\s+like/i,
  /^variant\s+child/i,
  /^special\s+brand/i,
  /^catalogue\s+version/i,
  /^approved/i,
  /^unit\b/i,
  /^type\b/i,
];

function normaliseHeader(header: string): string {
  return header.trim().toLowerCase().replace(/[\s_-]+/g, ' ');
}

/**
 * Mangled headers from a double-encoded export ("Name ÃƒÆ’Ã†â€™Ãƒâ€ …").
 * These are locale duplicates of a column we already have; importing them
 * produces spec attributes with unreadable keys.
 */
function isMojibake(header: string): boolean {
  const suspicious = (header.match(/[ÃÂâ€ƒ†¢šœ¬]/g) ?? []).length;
  return suspicious > 6 || header.includes('�');
}

export interface HeaderPlan {
  /** header -> target field or `spec:<name>` */
  map: Map<string, string>;
  ignored: { column: string; reason: string }[];
  mapping: Record<string, string>;
}

/**
 * Decide what each source column becomes.
 *
 * Where several columns claim the same field, a column that actually holds data
 * beats one that does not — that is what picks MPN over an EAN column present but
 * empty in every row, which is exactly the shape these exports arrive in.
 */
export function planHeaders(headers: string[], fillCounts: Map<string, number>): HeaderPlan {
  const ignored: { column: string; reason: string }[] = [];
  const candidates = new Map<string, { header: string; priority: number; filled: number }[]>();
  const usable: string[] = [];

  for (const header of headers) {
    if (!header || !header.trim()) continue;

    const filled = fillCounts.get(header) ?? 0;
    if (isMojibake(header)) {
      ignored.push({ column: header.slice(0, 40) + '…', reason: 'unreadable header (double-encoded locale duplicate)' });
      continue;
    }
    if (filled === 0) {
      ignored.push({ column: header, reason: 'empty in every row' });
      continue;
    }

    const normalised = normaliseHeader(header);

    // Skip site configuration and marketing copy, but only where the column is
    // not a field we actually need — a column called "Description" must still be
    // eligible if it is the only product name on offer.
    const isKnownField = Object.values(FIELD_ALIASES).some((aliases) =>
      aliases.some((alias) => normaliseHeader(alias) === normalised),
    );
    if (!isKnownField && NON_ATTRIBUTE_COLUMNS.some((pattern) => pattern.test(normalised))) {
      ignored.push({ column: header, reason: 'site configuration or marketing copy, not a product attribute' });
      continue;
    }

    usable.push(header);
    for (const [field, aliases] of Object.entries(FIELD_ALIASES)) {
      const priority = aliases.findIndex((alias) => normaliseHeader(alias) === normalised);
      if (priority === -1) continue;
      const list = candidates.get(field) ?? [];
      list.push({ header, priority, filled });
      candidates.set(field, list);
    }
  }

  const map = new Map<string, string>();
  const mapping: Record<string, string> = {};
  const claimedHeaders = new Set<string>();

  for (const [field, list] of candidates) {
    list.sort((a, b) => a.priority - b.priority || b.filled - a.filled);
    const winner = list[0];
    if (!winner) continue;

    map.set(winner.header, field);
    mapping[field] = winner.header;
    claimedHeaders.add(winner.header);

    // Runners-up keep their data, as spec attributes rather than being dropped.
    for (const loser of list.slice(1)) {
      if (claimedHeaders.has(loser.header)) continue;
      map.set(loser.header, `spec:${canonicalAttributeName(loser.header)}`);
      claimedHeaders.add(loser.header);
    }
  }

  for (const header of usable) {
    if (!claimedHeaders.has(header)) map.set(header, `spec:${canonicalAttributeName(header)}`);
  }

  return { map, ignored, mapping };
}

/** "Rolex Watches, Rolex Cosmograph Daytona" -> "Rolex" */
export function deriveBrandFromCategory(raw: string): string | null {
  const first = raw.split(/[,>|/]/)[0]?.trim();
  if (!first) return null;
  const stripped = first.replace(CATEGORY_SUFFIX, '').trim();
  return stripped || null;
}

/** "Rolex Watches, Rolex Cosmograph Daytona" -> "watches" */
export function deriveCategory(raw: string): string | null {
  for (const [pattern, canonical] of CATEGORY_KEYWORDS) {
    if (pattern.test(raw)) return canonical;
  }
  return raw.split(/[,>|/]/)[0]?.trim().toLowerCase() || null;
}

/**
 * Pull matchable attributes out of a product name. These exports carry no spec
 * columns, but the page title is highly structured — "Rolex Cosmograph Daytona
 * Oyster, 40 mm, Oystersteel and yellow gold M116503-0001" yields case size and
 * case material, which are High-weight attributes for watches (Appendix A).
 */
export function specsFromText(text: string): SpecAttributes {
  const specs: SpecAttributes = {};
  if (!text) return specs;

  const size = text.match(/(\d{2}(?:\.\d)?)\s*mm\b/i);
  if (size?.[1]) specs.case_size = `${size[1]}mm`;

  const metal = text.match(
    /\b(oystersteel|stainless steel|everose gold|rose gold|yellow gold|white gold|sterling silver|platinum|titanium|ceramic|steel)\b/i,
  );
  if (metal?.[1]) specs.case_material = metal[1];

  // "18ct White Gold … 0.75ct" contains two carat figures meaning different
  // things: metal purity and stone weight. Only the stone weight belongs in
  // carat_weight — it is a High-weight ring attribute, so taking the purity by
  // mistake actively breaks matching. Purity is excluded by the metal that
  // follows it, and a decimal figure wins when both survive.
  const carats = [
    ...text.matchAll(
      /\b(\d+(?:\.\d+)?)\s*(?:ct|carat)\b(?!\s*(?:white|yellow|rose|red)?\s*(?:gold|silver|platinum))/gi,
    ),
  ].map((m) => m[0]);
  const stoneWeight = carats.find((c) => c.includes('.')) ?? carats[0];
  if (stoneWeight) specs.carat_weight = stoneWeight;

  return specs;
}

interface ValidProduct {
  internal_sku: string;
  brand: string;
  product_name: string;
  ean_mpn: string | null;
  our_price: number | null;
  currency: string;
  category: string | null;
  our_product_url: string | null;
  specs: SpecAttributes;
}

function parseMoney(raw: string): number | null {
  const cleaned = raw.replace(/[£$€\s,]/g, '');
  if (!cleaned) return null;
  const value = Number.parseFloat(cleaned);
  return Number.isFinite(value) && value >= 0 ? Math.round(value * 100) / 100 : null;
}

/**
 * Import a master-catalogue export (Spec §5.1): validate required fields,
 * de-duplicate on SKU, update existing records rather than duplicating, and
 * report the rows that failed validation.
 *
 * There is no per-website split anywhere — this is one master export.
 *
 * Price is optional. The master catalogue carries product content; prices arrive
 * separately, so a product with no price imports as a fully matchable record and
 * the comparison view reports it as awaiting a price rather than guessing.
 */
export async function importCatalogue(buffer: Buffer, filename: string): Promise<ImportResult> {
  const table = await parseTabularFile(buffer, filename);
  const { headers, rows } = table;

  if (headers.length === 0) {
    throw new Error('The uploaded file appears to be empty — no header row was found.');
  }

  const fillCounts = countFilled(table);

  const { map: headerMap, ignored, mapping } = planHeaders(headers, fillCounts);
  const mappedFields = new Set(headerMap.values());

  // Brand can be derived from a category path, so it is only missing when there
  // is nothing at all to derive it from.
  const canDeriveBrand = mappedFields.has('category') || mappedFields.has('manufacturer');
  const missingRequired: string[] = [];
  if (!mappedFields.has('internal_sku')) missingRequired.push('SKU');
  if (!mappedFields.has('product_name')) missingRequired.push('product name');
  if (!mappedFields.has('brand') && !canDeriveBrand) missingRequired.push('brand (or a category/manufacturer column to derive it from)');

  if (missingRequired.length > 0) {
    const readable = headers.filter((h) => h && !isMojibake(h)).map((h) => h.trim());
    throw new Error(
      `The file is missing required column(s): ${missingRequired.join(', ')}. ` +
        `Recognisable columns found: ${readable.slice(0, 25).join(', ')}` +
        (readable.length > 25 ? `, and ${readable.length - 25} more.` : '.'),
    );
  }

  const specColumns = [...headerMap.values()].filter((f) => f.startsWith('spec:')).map((f) => f.slice(5));
  const priceColumnFound = mappedFields.has('our_price');

  const errors: ImportRowError[] = [];
  // Keyed by SKU so a repeated SKU inside one file collapses to a single record
  // (last row wins) instead of failing the whole import.
  const bySku = new Map<string, ValidProduct>();
  let duplicateSkusCollapsed = 0;

  for (const { rowNumber, values } of rows) {
    const fields: Record<string, string> = {};
    const specs: SpecAttributes = {};

    for (const [header, target] of headerMap) {
      const value = (values[header] ?? '').trim();
      if (!value) continue;
      if (target.startsWith('spec:')) specs[target.slice(5)] = value;
      else fields[target] = value;
    }

    const rowErrors: string[] = [];
    const internalSku = fields.internal_sku ?? '';
    if (!internalSku) rowErrors.push('SKU is required');

    const productName = fields.product_name ?? '';
    if (!productName) rowErrors.push('product name is required');

    // Brand precedence: an explicit column, then the category path, then the
    // manufacturer column. Whatever is not used as the brand is kept as `model`,
    // which is a gate attribute for watches in its own right.
    let brand = fields.brand ?? '';
    if (!brand && fields.category) brand = deriveBrandFromCategory(fields.category) ?? '';
    if (!brand && fields.manufacturer) brand = fields.manufacturer;
    if (!brand) rowErrors.push('brand could not be determined');

    if (fields.manufacturer && fields.manufacturer !== brand) {
      specs.model ??= fields.manufacturer;
    }

    let price: number | null = null;
    if (priceColumnFound && fields.our_price) {
      price = parseMoney(fields.our_price);
      if (price == null) rowErrors.push(`price "${fields.our_price}" is not a valid amount`);
    }

    const url = fields.our_product_url ?? null;
    if (url && !/^https?:\/\//i.test(url)) rowErrors.push(`product URL "${url}" is not a valid URL`);

    if (rowErrors.length > 0) {
      errors.push({ row: rowNumber, internalSku: internalSku || null, errors: rowErrors });
      continue;
    }

    // Only fill from the name where the export gave us nothing better.
    for (const [key, value] of Object.entries(specsFromText(productName))) {
      specs[key] ??= value;
    }

    if (bySku.has(internalSku)) duplicateSkusCollapsed += 1;

    bySku.set(internalSku, {
      internal_sku: internalSku,
      brand,
      product_name: productName,
      ean_mpn: fields.ean_mpn ?? null,
      our_price: price,
      currency: (fields.currency ?? 'GBP').toUpperCase().slice(0, 8),
      category: fields.category ? deriveCategory(fields.category) : null,
      our_product_url: url,
      specs,
    });
  }

  let created = 0;
  let updated = 0;

  if (bySku.size > 0) {
    await withTransaction(async (client) => {
      for (const product of bySku.values()) {
        const { rows: result } = await client.query<{ existed: boolean }>(
          `INSERT INTO products
             (internal_sku, brand, product_name, ean_mpn, our_price, currency, category, our_product_url, specs)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
           ON CONFLICT (internal_sku) DO UPDATE SET
             brand           = EXCLUDED.brand,
             product_name    = EXCLUDED.product_name,
             ean_mpn         = EXCLUDED.ean_mpn,
             -- A content-only export must never wipe a price loaded separately.
             our_price       = COALESCE(EXCLUDED.our_price, products.our_price),
             currency        = EXCLUDED.currency,
             category        = EXCLUDED.category,
             our_product_url = EXCLUDED.our_product_url,
             -- Merge specs so a partial export never drops attributes we already hold.
             specs           = products.specs || EXCLUDED.specs,
             updated_at      = now()
           RETURNING (xmax <> 0) AS existed`,
          [
            product.internal_sku,
            product.brand,
            product.product_name,
            product.ean_mpn,
            product.our_price,
            product.currency,
            product.category,
            product.our_product_url,
            JSON.stringify(product.specs),
          ],
        );
        if (result[0]?.existed) updated += 1;
        else created += 1;
      }
    });
  }

  const { rows: awaiting } = await withTransaction(async (client) =>
    client.query<{ count: number }>('SELECT count(*)::int AS count FROM products WHERE our_price IS NULL'),
  );

  return {
    totalRows: rows.length,
    created,
    updated,
    failed: errors.length,
    duplicateSkusCollapsed,
    errors: errors.slice(0, 200),
    specColumnsDetected: [...new Set(specColumns)],
    columnMapping: mapping,
    ignoredColumns: ignored,
    awaitingPrice: awaiting[0]?.count ?? 0,
    priceColumnFound,
  };
}
