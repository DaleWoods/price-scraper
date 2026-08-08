import { parse as parseCsv } from 'csv-parse/sync';
import ExcelJS from 'exceljs';

export interface ParsedRow {
  rowNumber: number;
  values: Record<string, string>;
}

export interface ParsedTable {
  headers: string[];
  rows: ParsedRow[];
}

/**
 * Work out the delimiter from the header line rather than assuming a comma.
 *
 * Exports saved as ".xls" from older tools are frequently tab-separated text,
 * and a European locale export may use semicolons.
 */
export function detectDelimiter(text: string): string {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? '';
  const counts = [',', '\t', ';', '|'].map((delimiter) => ({
    delimiter,
    count: firstLine.split(delimiter).length - 1,
  }));
  counts.sort((a, b) => b.count - a.count);
  return counts[0] && counts[0].count > 0 ? counts[0].delimiter : ',';
}

export function parseCsvBuffer(buffer: Buffer): { headers: string[]; rows: ParsedRow[] } {
  // Strip a UTF-8 BOM — Excel writes one and it corrupts the first header.
  const text = buffer.toString('utf8').replace(/^﻿/, '');
  const records = parseCsv(text, {
    columns: false,
    delimiter: detectDelimiter(text),
    skip_empty_lines: true,
    relax_column_count: true,
    relax_quotes: true,
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

export async function parseExcelBuffer(buffer: Buffer): Promise<{ headers: string[]; rows: ParsedRow[] }> {
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


export type TabularFormat = 'xlsx' | 'legacy-xls' | 'html' | 'text';

/**
 * Identify a file from its contents rather than its extension.
 *
 * Extensions lie constantly in this domain: exports land as ".xls" that are
 * really tab-separated text, or an HTML table, or a plain .xlsx renamed. The
 * magic bytes are the only reliable signal.
 */
export function detectFormat(buffer: Buffer): TabularFormat {
  const header = buffer.subarray(0, 8);
  // Zip container — every modern Office format.
  if (header.subarray(0, 2).toString('latin1') === 'PK') return 'xlsx';
  // OLE2 compound document — the genuine legacy binary .xls.
  if (header.equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))) {
    return 'legacy-xls';
  }
  const start = buffer.subarray(0, 512).toString('utf8').trimStart().toLowerCase();
  if (start.startsWith('<html') || start.startsWith('<?xml') || start.startsWith('<table')) {
    return 'html';
  }
  return 'text';
}

/** Parse an uploaded CSV or Excel file into headers plus trimmed string rows. */
export async function parseTabularFile(buffer: Buffer, filename: string): Promise<ParsedTable> {
  switch (detectFormat(buffer)) {
    case 'xlsx':
      return parseExcelBuffer(buffer);
    case 'legacy-xls':
      throw new Error(
        `"${filename}" is a legacy binary Excel file (Excel 97-2003). Open it and ` +
          'use File → Save As to save it as .xlsx or .csv, then upload that. ' +
          'The format cannot be read directly.',
      );
    case 'html':
      throw new Error(
        `"${filename}" is an HTML table saved with a spreadsheet extension, not a ` +
          'real workbook. Open it in Excel and save as .xlsx or .csv, then upload that.',
      );
    default:
      return parseCsvBuffer(buffer);
  }
}

/**
 * Reduce a column heading to something comparable.
 *
 * Export tools decorate headings: hybris Backoffice marks mandatory and unique
 * columns ("Article Number*^") and appends locale qualifiers ("Identifier[en]").
 * Those decorations are not part of the column's meaning, so they are stripped
 * before matching — otherwise a perfectly ordinary SKU column goes unrecognised.
 */
export function normaliseHeader(header: string): string {
  return header
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/[*^†‡§¶#~]/g, ' ')
    .toLowerCase()
    .replace(/[\s_-]+/g, ' ')
    .trim();
}

/** How many rows actually hold a value in each column. */
export function countFilled(table: ParsedTable): Map<string, number> {
  const counts = new Map<string, number>();
  for (const header of table.headers) {
    if (!header) continue;
    counts.set(
      header,
      table.rows.reduce((n, row) => n + ((row.values[header] ?? '').trim() ? 1 : 0), 0),
    );
  }
  return counts;
}
