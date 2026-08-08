import { withTransaction } from '../db/pool.js';
import { countFilled, parseTabularFile } from './parseTabular.js';
import {
  ANY_STORE,
  selectFasciaPrice,
  type FasciaDefinition,
  type LoadsheetRow,
} from './priceSelection.js';

export interface LoadsheetImportResult {
  totalRows: number;
  /** Rows for another sales org, or a store that is not one of our fascias. */
  rowsNotOurs: number;
  /** Rows we kept and fed into price selection. */
  rowsConsidered: number;
  productsPriced: number;
  pricesWritten: number;
  /** SKUs priced in the file that are not in the catalogue. */
  unknownSkus: string[];
  unknownSkuCount: number;
  failed: number;
  errors: { row: number; code: string | null; error: string }[];
  columnMapping: Record<string, string>;
  fascias: { code: string; name: string; priced: number; missing: number }[];
  warnings: {
    /** Rows carrying no usable validity dates — see the note on Excel mangling. */
    noValidityDates: number;
    /** A 'sale' priced at or above the regular price; the regular was used. */
    saleNotCheaper: { sku: string; fascia: string }[];
    /** Org-wide sale vs fascia-specific regular: the live site may disagree. */
    precedenceAmbiguous: { sku: string; fascia: string }[];
  };
  /** Catalogue products with no price at any enabled fascia. */
  productsWithoutAnyPrice: number;
}

/** Loadsheet column aliases, so a slightly different export still lands. */
const COLUMN_ALIASES: Record<string, string[]> = {
  code: ['p_code', 'code', 'sku', 'material', 'product code', 'internal_sku'],
  kschl: ['p_kschl', 'kschl', 'condition type', 'condition'],
  vkorg: ['p_vkorg', 'vkorg', 'sales org', 'sales organisation', 'sales organization'],
  werks: ['p_werks', 'werks', 'plant', 'store', 'store code', 'site'],
  price: ['p_price', 'price', 'amount', 'value', 'rate'],
  salePrice: ['p_saleprice', 'saleprice', 'sale price', 'is sale'],
  startTime: ['p_starttime', 'starttime', 'valid from', 'datab', 'start date', 'valid_from'],
  endTime: ['p_endtime', 'endtime', 'valid to', 'datbi', 'end date', 'valid_to'],
};

function normaliseHeader(header: string): string {
  return header.trim().toLowerCase().replace(/[\s_-]+/g, ' ');
}

function mapColumns(headers: string[], fillCounts: Map<string, number>): Record<string, string> {
  const mapping: Record<string, string> = {};
  for (const [field, aliases] of Object.entries(COLUMN_ALIASES)) {
    // Both sides must be normalised: the header "p_code" becomes "p code", so
    // comparing it against the raw alias "p_code" would never match.
    const normalisedAliases = aliases.map(normaliseHeader);
    const match = headers
      .filter(Boolean)
      .map((header) => ({
        header,
        rank: normalisedAliases.indexOf(normaliseHeader(header)),
        filled: fillCounts.get(header) ?? 0,
      }))
      .filter((candidate) => candidate.rank !== -1)
      .sort((a, b) => a.rank - b.rank || b.filled - a.filled)[0];
    if (match) mapping[field] = match.header;
  }
  return mapping;
}

/**
 * Parse a loadsheet date/time cell.
 *
 * Returns null for anything that carries no date — notably `00:00.0`, which is
 * what Excel leaves behind when a datetime column is formatted as a time. That
 * is treated as "unknown", not "expired", so a mangled export still imports;
 * the count is reported so the damage is visible rather than silent.
 */
export function parseLoadsheetDate(raw: string | undefined): Date | null {
  const value = (raw ?? '').trim();
  if (!value) return null;
  // Time-only leftovers such as "00:00.0" or "00:00:00".
  if (/^\d{1,2}:\d{2}(:\d{2})?(\.\d+)?$/.test(value)) return null;

  // SAP frequently exports DD.MM.YYYY; treat it explicitly rather than letting
  // Date guess (which would read 01.09.2018 as a US month/day).
  const dotted = value.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})/);
  if (dotted) {
    return new Date(Date.UTC(+dotted[3]!, +dotted[2]! - 1, +dotted[1]!));
  }
  const slashed = value.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (slashed) {
    return new Date(Date.UTC(+slashed[3]!, +slashed[2]! - 1, +slashed[1]!));
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function parsePrice(raw: string): number | null {
  const cleaned = (raw ?? '').replace(/[£$€\s,]/g, '');
  if (!cleaned) return null;
  const value = Number.parseFloat(cleaned);
  if (!Number.isFinite(value) || value < 0) return null;
  return Math.round(value * 100) / 100;
}

/**
 * Import a SAP price loadsheet, resolving one selling price per fascia.
 *
 * Prices are taken as gross (VAT inclusive) and stored unchanged, so they are
 * directly comparable with the competitor website prices we scrape.
 */
export async function importLoadsheet(
  buffer: Buffer,
  filename: string,
  asOf: Date = new Date(),
): Promise<LoadsheetImportResult> {
  const table = await parseTabularFile(buffer, filename);
  const { headers, rows } = table;
  if (headers.length === 0) {
    throw new Error('The uploaded file appears to be empty — no header row was found.');
  }

  const columnMapping = mapColumns(headers, countFilled(table));
  const required = ['code', 'kschl', 'vkorg', 'werks', 'price'];
  const missing = required.filter((field) => !columnMapping[field]);
  if (missing.length > 0) {
    throw new Error(
      `The loadsheet is missing ${missing.join(', ')}. Columns found: ` +
        `${headers.filter(Boolean).join(', ')}. Expected the SAP export shape ` +
        '(p_code, p_kschl, p_vkorg, p_werks, p_price, p_starttime, p_endtime).',
    );
  }

  const fasciaRows = await withTransaction(async (client) =>
    client.query<{ id: number; code: string; name: string; sales_org: string; currency: string }>(
      'SELECT id, code, name, sales_org, currency FROM fascias WHERE enabled ORDER BY code',
    ),
  );
  const fascias = fasciaRows.rows;
  if (fascias.length === 0) {
    throw new Error('No fascias are configured, so there is nothing to price.');
  }
  const salesOrgs = new Set(fascias.map((fascia) => fascia.sales_org));
  const ourStores = new Set([...fascias.map((fascia) => fascia.code), ANY_STORE]);

  const errors: LoadsheetImportResult['errors'] = [];
  const byProduct = new Map<string, LoadsheetRow[]>();
  let rowsNotOurs = 0;

  for (const { rowNumber, values } of rows) {
    const code = (values[columnMapping.code!] ?? '').trim();
    const kschl = (values[columnMapping.kschl!] ?? '').trim().toUpperCase();
    const vkorg = (values[columnMapping.vkorg!] ?? '').trim().toUpperCase();
    const werks = (values[columnMapping.werks!] ?? '').trim();
    const rawPrice = (values[columnMapping.price!] ?? '').trim();

    if (!code) {
      errors.push({ row: rowNumber, code: null, error: 'product code is missing' });
      continue;
    }

    // Discard other countries and other people's stores before validating the
    // price — a malformed row we were never going to use is not an error.
    if (!salesOrgs.has(vkorg) || !ourStores.has(werks)) {
      rowsNotOurs += 1;
      continue;
    }

    const price = parsePrice(rawPrice);
    if (price == null) {
      errors.push({ row: rowNumber, code, error: `price "${rawPrice}" is not a valid amount` });
      continue;
    }

    const list = byProduct.get(code) ?? [];
    list.push({
      rowNumber,
      code,
      kschl,
      vkorg,
      werks,
      price,
      validFrom: parseLoadsheetDate(values[columnMapping.startTime ?? '']),
      validTo: parseLoadsheetDate(values[columnMapping.endTime ?? '']),
    });
    byProduct.set(code, list);
  }

  const rowsConsidered = [...byProduct.values()].reduce((n, list) => n + list.length, 0);
  const unknownSkus: string[] = [];
  const saleNotCheaper: { sku: string; fascia: string }[] = [];
  const precedenceAmbiguous: { sku: string; fascia: string }[] = [];
  const perFascia = new Map<string, { priced: number; missing: number }>(
    fascias.map((fascia) => [fascia.code, { priced: 0, missing: 0 }]),
  );
  let noValidityDates = 0;
  let pricesWritten = 0;
  let productsPriced = 0;

  await withTransaction(async (client) => {
    for (const [code, productRows] of byProduct) {
      const { rows: found } = await client.query<{ id: number }>(
        'SELECT id FROM products WHERE internal_sku = $1',
        [code],
      );
      const product = found[0];
      if (!product) {
        unknownSkus.push(code);
        continue;
      }

      let pricedThisProduct = false;
      for (const fascia of fascias) {
        const definition: FasciaDefinition = {
          code: fascia.code,
          name: fascia.name,
          salesOrg: fascia.sales_org,
        };
        const selected = selectFasciaPrice(productRows, definition, asOf);
        const counters = perFascia.get(fascia.code)!;

        if (!selected) {
          counters.missing += 1;
          continue;
        }

        if (selected.warnings.includes('no_validity_dates')) noValidityDates += 1;
        if (selected.warnings.includes('sale_not_cheaper')) {
          saleNotCheaper.push({ sku: code, fascia: fascia.name });
        }
        if (selected.warnings.includes('precedence_ambiguous')) {
          precedenceAmbiguous.push({ sku: code, fascia: fascia.name });
        }

        await client.query(
          `INSERT INTO fascia_prices
             (product_id, fascia_id, price, regular_price, on_sale, currency,
              source_kschl, source_werks, valid_from, valid_to, imported_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now())
           ON CONFLICT (product_id, fascia_id) DO UPDATE SET
             price         = EXCLUDED.price,
             regular_price = EXCLUDED.regular_price,
             on_sale       = EXCLUDED.on_sale,
             currency      = EXCLUDED.currency,
             source_kschl  = EXCLUDED.source_kschl,
             source_werks  = EXCLUDED.source_werks,
             valid_from    = EXCLUDED.valid_from,
             valid_to      = EXCLUDED.valid_to,
             imported_at   = now()`,
          [
            product.id,
            fascia.id,
            selected.price,
            selected.regularPrice,
            selected.onSale,
            fascia.currency,
            selected.sourceKschl,
            selected.sourceWerks,
            selected.validFrom,
            selected.validTo,
          ],
        );

        counters.priced += 1;
        pricesWritten += 1;
        pricedThisProduct = true;
      }
      if (pricedThisProduct) productsPriced += 1;
    }
  });

  const { rows: without } = await withTransaction(async (client) =>
    client.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM products p
       WHERE NOT EXISTS (SELECT 1 FROM fascia_prices fp WHERE fp.product_id = p.id)`,
    ),
  );

  return {
    totalRows: rows.length,
    rowsNotOurs,
    rowsConsidered,
    productsPriced,
    pricesWritten,
    unknownSkus: unknownSkus.slice(0, 100),
    unknownSkuCount: unknownSkus.length,
    failed: errors.length,
    errors: errors.slice(0, 200),
    columnMapping,
    fascias: fascias.map((fascia) => ({
      code: fascia.code,
      name: fascia.name,
      priced: perFascia.get(fascia.code)?.priced ?? 0,
      missing: perFascia.get(fascia.code)?.missing ?? 0,
    })),
    warnings: {
      noValidityDates,
      saleNotCheaper: saleNotCheaper.slice(0, 50),
      precedenceAmbiguous: precedenceAmbiguous.slice(0, 50),
    },
    productsWithoutAnyPrice: without[0]?.count ?? 0,
  };
}
