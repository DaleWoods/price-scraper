import { withTransaction } from '../db/pool.js';
import { countFilled, parseTabularFile } from './parseTabular.js';

export interface PriceImportResult {
  totalRows: number;
  /** Rows whose SKU matched a catalogue product and whose price was written. */
  updated: number;
  /** Rows whose SKU is not in the catalogue — reported, never invented. */
  unknownSkus: string[];
  unknownSkuCount: number;
  /** Rows rejected for a missing SKU or an unreadable price. */
  failed: number;
  errors: { row: number; sku: string | null; error: string }[];
  duplicateSkusCollapsed: number;
  columnMapping: { sku: string; price: string; currency: string | null };
  /** Catalogue products still without a price after this file was applied. */
  stillAwaitingPrice: number;
}

/**
 * Header aliases in priority order. The exact template is not known yet, so this
 * accepts the shapes a price extract usually arrives in rather than demanding
 * one. Adding a variant is one string here.
 */
const SKU_ALIASES = [
  'internal_sku',
  'sku',
  'internal sku',
  'product code',
  'productcode',
  'item code',
  'item number',
  'article',
  'article number',
];

const PRICE_ALIASES = [
  'our_price',
  'our price',
  'price',
  'retail price',
  'selling price',
  'rrp',
  'current price',
  'unit price',
  'gbp',
  'gbp price',
  'amount',
];

const CURRENCY_ALIASES = ['currency', 'currency code', 'ccy'];

function normaliseHeader(header: string): string {
  return header.trim().toLowerCase().replace(/[\s_-]+/g, ' ');
}

/** Pick the best column for a role: best alias rank first, then the one with data. */
function pickColumn(
  headers: string[],
  aliases: string[],
  fillCounts: Map<string, number>,
): string | null {
  const candidates = headers
    .filter(Boolean)
    .map((header) => ({
      header,
      priority: aliases.indexOf(normaliseHeader(header)),
      filled: fillCounts.get(header) ?? 0,
    }))
    .filter((candidate) => candidate.priority !== -1 && candidate.filled > 0)
    .sort((a, b) => a.priority - b.priority || b.filled - a.filled);

  return candidates[0]?.header ?? null;
}

export function parsePriceValue(raw: string): number | null {
  const cleaned = raw.replace(/[£$€\s,]/g, '');
  if (!cleaned) return null;
  const value = Number.parseFloat(cleaned);
  if (!Number.isFinite(value) || value < 0) return null;
  return Math.round(value * 100) / 100;
}

/**
 * Apply a price file to the catalogue, joined on SKU.
 *
 * Prices arrive separately from product content, so this only ever UPDATES
 * existing products. A price for a SKU that is not in the catalogue is reported
 * rather than inserted: a row with a price but no brand, name or category would
 * be unmatchable, and would quietly inflate the product count.
 */
export async function importPrices(buffer: Buffer, filename: string): Promise<PriceImportResult> {
  const table = await parseTabularFile(buffer, filename);
  const { headers, rows } = table;

  if (headers.length === 0) {
    throw new Error('The uploaded file appears to be empty — no header row was found.');
  }

  const fillCounts = countFilled(table);
  const skuColumn = pickColumn(headers, SKU_ALIASES, fillCounts);
  const priceColumn = pickColumn(headers, PRICE_ALIASES, fillCounts);
  const currencyColumn = pickColumn(headers, CURRENCY_ALIASES, fillCounts);

  const missing: string[] = [];
  if (!skuColumn) missing.push('a SKU column');
  if (!priceColumn) missing.push('a price column');
  if (missing.length > 0) {
    throw new Error(
      `The price file needs ${missing.join(' and ')}. Columns found: ` +
        `${headers.filter(Boolean).slice(0, 20).join(', ')}. ` +
        'Recognised SKU headers include SKU, Product Code, Item Code; ' +
        'recognised price headers include Price, Our Price, Retail Price, RRP.',
    );
  }

  const errors: PriceImportResult['errors'] = [];
  // Last value wins for a repeated SKU, matching the catalogue import's behaviour.
  const bySku = new Map<string, { price: number; currency: string | null }>();
  let duplicateSkusCollapsed = 0;

  for (const { rowNumber, values } of rows) {
    const sku = (values[skuColumn!] ?? '').trim();
    const rawPrice = (values[priceColumn!] ?? '').trim();

    if (!sku) {
      errors.push({ row: rowNumber, sku: null, error: 'SKU is missing' });
      continue;
    }
    if (!rawPrice) {
      errors.push({ row: rowNumber, sku, error: 'price is blank' });
      continue;
    }

    const price = parsePriceValue(rawPrice);
    if (price == null) {
      errors.push({ row: rowNumber, sku, error: `price "${rawPrice}" is not a valid amount` });
      continue;
    }

    if (bySku.has(sku)) duplicateSkusCollapsed += 1;
    const currency = currencyColumn ? (values[currencyColumn] ?? '').trim() : '';
    bySku.set(sku, { price, currency: currency ? currency.toUpperCase().slice(0, 8) : null });
  }

  const unknownSkus: string[] = [];
  let updated = 0;

  if (bySku.size > 0) {
    await withTransaction(async (client) => {
      for (const [sku, { price, currency }] of bySku) {
        const { rowCount } = await client.query(
          `UPDATE products
           SET our_price  = $2,
               currency   = COALESCE($3, currency),
               updated_at = now()
           WHERE internal_sku = $1`,
          [sku, price, currency],
        );
        if (rowCount && rowCount > 0) updated += 1;
        else unknownSkus.push(sku);
      }
    });
  }

  const { rows: remaining } = await withTransaction(async (client) =>
    client.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM products WHERE our_price IS NULL',
    ),
  );

  return {
    totalRows: rows.length,
    updated,
    unknownSkus: unknownSkus.slice(0, 100),
    unknownSkuCount: unknownSkus.length,
    failed: errors.length,
    errors: errors.slice(0, 200),
    duplicateSkusCollapsed,
    columnMapping: { sku: skuColumn!, price: priceColumn!, currency: currencyColumn },
    stillAwaitingPrice: remaining[0]?.count ?? 0,
  };
}
