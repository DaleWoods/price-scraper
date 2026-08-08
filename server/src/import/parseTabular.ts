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

export function parseCsvBuffer(buffer: Buffer): { headers: string[]; rows: ParsedRow[] } {
  // Strip a UTF-8 BOM — Excel writes one and it corrupts the first header.
  const text = buffer.toString('utf8').replace(/^﻿/, '');
  const records = parseCsv(text, {
    columns: false,
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


/** Parse an uploaded CSV or Excel file into headers plus trimmed string rows. */
export async function parseTabularFile(buffer: Buffer, filename: string): Promise<ParsedTable> {
  const isExcel = /\.(xlsx|xlsm|xltx)$/i.test(filename);
  return isExcel ? parseExcelBuffer(buffer) : parseCsvBuffer(buffer);
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
