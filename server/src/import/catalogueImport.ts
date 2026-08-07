import { parse as parseCsv } from 'csv-parse/sync';
import ExcelJS from 'exceljs';
import { withTransaction } from '../db/pool.js';
import type { SpecAttributes } from '../domain/types.js';
import { canonicalAttributeName } from '../matching/attributes.js';

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
}

/**
 * Header aliases for the required/known fields. Everything not matched here is
 * treated as a spec attribute, so the import accepts an open/extensible set
 * rather than a fixed list (Spec §5.1).
 */
const FIELD_ALIASES: Record<string, string[]> = {
  internal_sku: ['internal_sku', 'sku', 'internal sku', 'product code', 'productcode', 'item code'],
  brand: ['brand', 'brand name', 'manufacturer'],
  product_name: ['product_name', 'product name', 'name', 'title', 'description'],
  ean_mpn: ['ean_mpn', 'ean', 'mpn', 'gtin', 'ean/mpn', 'ean mpn', 'barcode'],
  our_price: ['our_price', 'price', 'our price', 'rrp', 'selling price', 'retail price'],
  currency: ['currency', 'currency code', 'ccy'],
  category: ['category', 'product category', 'product type'],
  our_product_url: ['our_product_url', 'url', 'product url', 'our url', 'link'],
};

const KNOWN_FIELDS = new Set(Object.keys(FIELD_ALIASES));

function normaliseHeader(header: string): string {
  return header.trim().toLowerCase().replace(/[\s_-]+/g, ' ');
}

/** Map each source column onto a known field, or mark it as a spec attribute. */
function buildHeaderMap(headers: string[]): Map<string, string> {
  const map = new Map<string, string>();
  const claimed = new Set<string>();

  for (const header of headers) {
    if (!header || !header.trim()) continue;
    const normalised = normaliseHeader(header);

    let matchedField: string | null = null;
    for (const [field, aliases] of Object.entries(FIELD_ALIASES)) {
      if (claimed.has(field)) continue;
      if (aliases.some((alias) => normaliseHeader(alias) === normalised)) {
        matchedField = field;
        break;
      }
    }

    if (matchedField) {
      claimed.add(matchedField);
      map.set(header, matchedField);
    } else {
      map.set(header, `spec:${canonicalAttributeName(header)}`);
    }
  }

  return map;
}

interface ParsedRow {
  rowNumber: number;
  values: Record<string, string>;
}

function parseCsvBuffer(buffer: Buffer): { headers: string[]; rows: ParsedRow[] } {
  // Strip a UTF-8 BOM — Excel writes one and it corrupts the first header.
  const text = buffer.toString('utf8').replace(/^﻿/, '');
  const records = parseCsv(text, {
    columns: false,
    skip_empty_lines: true,
    relax_column_count: true,
    trim: true,
  }) as string[][];

  const headerRow = records[0];
  if (!headerRow) return { headers: [], rows: [] };

  const rows: ParsedRow[] = [];
  for (let i = 1; i < records.length; i += 1) {
    const record = records[i];
    if (!record || record.every((cell) => !cell?.trim())) continue;

    const values: Record<string, string> = {};
    headerRow.forEach((header, index) => {
      if (header) values[header] = (record[index] ?? '').trim();
    });
    rows.push({ rowNumber: i + 1, values });
  }

  return { headers: headerRow, rows };
}

async function parseExcelBuffer(buffer: Buffer): Promise<{ headers: string[]; rows: ParsedRow[] }> {
  const workbook = new ExcelJS.Workbook();
  // ExcelJS types want an ArrayBuffer-ish input; a Node Buffer works at runtime.
  await workbook.xlsx.load(buffer as unknown as ArrayBuffer);

  const sheet = workbook.worksheets[0];
  if (!sheet) return { headers: [], rows: [] };

  const cellText = (value: ExcelJS.CellValue): string => {
    if (value == null) return '';
    if (typeof value === 'object') {
      const rich = value as { text?: string; result?: unknown; richText?: { text: string }[] };
      if (Array.isArray(rich.richText)) return rich.richText.map((part) => part.text).join('');
      if (rich.text != null) return String(rich.text);
      if (rich.result != null) return String(rich.result);
      if (value instanceof Date) return value.toISOString();
    }
    return String(value);
  };

  const headers: string[] = [];
  sheet.getRow(1).eachCell({ includeEmpty: false }, (cell, colNumber) => {
    headers[colNumber - 1] = cellText(cell.value).trim();
  });

  const rows: ParsedRow[] = [];
  sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber === 1) return;

    const values: Record<string, string> = {};
    let hasContent = false;
    headers.forEach((header, index) => {
      if (!header) return;
      const text = cellText(row.getCell(index + 1).value).trim();
      values[header] = text;
      if (text) hasContent = true;
    });
    if (hasContent) rows.push({ rowNumber, values });
  });

  return { headers: headers.filter(Boolean), rows };
}

interface ValidProduct {
  internal_sku: string;
  brand: string;
  product_name: string;
  ean_mpn: string | null;
  our_price: number;
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
 */
export async function importCatalogue(
  buffer: Buffer,
  filename: string,
): Promise<ImportResult> {
  const isExcel = /\.(xlsx|xlsm|xltx)$/i.test(filename);
  const { headers, rows } = isExcel ? await parseExcelBuffer(buffer) : parseCsvBuffer(buffer);

  if (headers.length === 0) {
    throw new Error('The uploaded file appears to be empty — no header row was found.');
  }

  const headerMap = buildHeaderMap(headers);
  const mappedFields = new Set(headerMap.values());
  const missingRequired = ['internal_sku', 'brand', 'product_name', 'our_price'].filter(
    (field) => !mappedFields.has(field),
  );
  if (missingRequired.length > 0) {
    throw new Error(
      `The file is missing required column(s): ${missingRequired.join(', ')}. ` +
        `Columns found: ${headers.join(', ')}`,
    );
  }

  const specColumns = [...headerMap.values()]
    .filter((field) => field.startsWith('spec:'))
    .map((field) => field.slice(5));

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
    if (!internalSku) rowErrors.push('internal_sku is required');
    if (!fields.brand) rowErrors.push('brand is required');
    if (!fields.product_name) rowErrors.push('product_name is required');

    const price = fields.our_price ? parseMoney(fields.our_price) : null;
    if (fields.our_price == null || fields.our_price === '') rowErrors.push('our_price is required');
    else if (price == null) rowErrors.push(`our_price "${fields.our_price}" is not a valid amount`);

    const url = fields.our_product_url ?? null;
    if (url && !/^https?:\/\//i.test(url)) rowErrors.push(`our_product_url "${url}" is not a valid URL`);

    if (rowErrors.length > 0) {
      errors.push({ row: rowNumber, internalSku: internalSku || null, errors: rowErrors });
      continue;
    }

    if (bySku.has(internalSku)) duplicateSkusCollapsed += 1;

    bySku.set(internalSku, {
      internal_sku: internalSku,
      brand: fields.brand!,
      product_name: fields.product_name!,
      ean_mpn: fields.ean_mpn ?? null,
      our_price: price!,
      currency: (fields.currency ?? 'GBP').toUpperCase().slice(0, 8),
      category: fields.category ?? null,
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
             our_price       = EXCLUDED.our_price,
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

  return {
    totalRows: rows.length,
    created,
    updated,
    failed: errors.length,
    duplicateSkusCollapsed,
    errors: errors.slice(0, 200),
    specColumnsDetected: [...new Set(specColumns)],
  };
}
