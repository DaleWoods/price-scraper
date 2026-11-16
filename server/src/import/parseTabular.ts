import { createReadStream } from 'node:fs';
import { open, readFile, stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { parse as parseCsvStream } from 'csv-parse';
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

/** Rows read one at a time, for files too large to hold in memory. */
export interface StreamedTable {
  headers: string[];
  rows: AsyncIterable<ParsedRow>;
  /** Size of the whole file, for showing how far through it the reading is. */
  totalBytes: number;
  /** How much of the file has been read so far. */
  bytesRead(): number;
}

/**
 * Open a feed for reading row by row: an uploaded file (a Buffer) or one saved
 * to disk by the FTP collector (a path).
 *
 * The Goldsmiths feed on the FTP server is 388 MB. Read whole, as text, then
 * parsed into rows, it needs well over a gigabyte — more than the server has —
 * so a text feed is parsed as it streams and only the current row is held.
 * An Excel workbook cannot be streamed this way; it is read whole as before,
 * which is fine for the hand-uploaded files that ever arrive as one.
 */
export async function openTabular(source: Buffer | { path: string }, filename: string): Promise<StreamedTable> {
  const head = Buffer.isBuffer(source) ? source.subarray(0, 64 * 1024) : await readHead(source.path, 64 * 1024);

  if (detectFormat(head) !== 'text') {
    const buffer = Buffer.isBuffer(source) ? source : await readFile(source.path);
    const table = await parseTabularFile(buffer, filename);
    let done = 0;
    return {
      headers: table.headers,
      totalBytes: buffer.length,
      bytesRead: () => (table.rows.length === 0 ? buffer.length : Math.round((done / table.rows.length) * buffer.length)),
      rows: (async function* () {
        for (const row of table.rows) {
          done += 1;
          yield row;
        }
      })(),
    };
  }

  const firstLineText = head.toString('utf8').replace(/^﻿/, '');
  const delimiter = detectDelimiter(firstLineText);
  const input = Buffer.isBuffer(source) ? Readable.from([source]) : createReadStream(source.path);
  // A tab-separated feed is read without quoting. Product text is full of
  // quote marks used as inches and in names (12" chain, "Love" pendant); read
  // as CSV-style quoting they stop the whole import at the first one. A value
  // that really was wrapped in quotes has them taken off below, and a value
  // with a line break in it is joined back together.
  const tabbed = delimiter === '\t';
  const parser = input.pipe(
    parseCsvStream({
      bom: true,
      delimiter,
      quote: tabbed ? false : '"',
      columns: false,
      skip_empty_lines: true,
      relax_column_count: true,
      relax_quotes: true,
      trim: true,
    }),
  );
  const iterator = parser[Symbol.asyncIterator]() as AsyncIterator<string[]>;
  const totalBytes = Buffer.isBuffer(source) ? source.length : (await stat(source.path)).size;

  const first = await iterator.next();
  const headers = first.done ? [] : (first.value as string[]);

  return {
    headers,
    totalBytes,
    bytesRead: () => Math.min(totalBytes, parser.info.bytes),
    rows: (async function* () {
      let lineNumber = 1;
      let pending: { record: string[]; rowNumber: number } | null = null;
      // Joining lines only ever happens to a row short of columns whose last
      // value opened a quote and did not close it. "Love" pendant, in a full
      // row, is left alone.
      const brokenOff = (cells: string[]): boolean =>
        cells.length < headers.length && opensQuote(cells[cells.length - 1] ?? '');
      for (;;) {
        const next = await iterator.next();
        if (next.done && !pending) return;
        let record: string[];
        let rowNumber: number;
        if (next.done) {
          // Whatever was still being joined when the file ended: kept as it is.
          ({ record, rowNumber } = pending!);
          pending = null;
        } else {
          lineNumber += 1;
          rowNumber = lineNumber;
          record = next.value as string[];
        }

        if (tabbed) {
          if (pending) {
            const joined: string[] = [...pending.record];
            joined[joined.length - 1] = `${joined[joined.length - 1] ?? ''}\n${record[0] ?? ''}`;
            joined.push(...record.slice(1));
            if (brokenOff(joined) && lineNumber - pending.rowNumber < 50) {
              pending = { record: joined, rowNumber: pending.rowNumber };
              continue;
            }
            rowNumber = pending.rowNumber;
            record = joined;
            pending = null;
          } else if (brokenOff(record) && !next.done) {
            pending = { record, rowNumber };
            continue;
          }
          record = record.map(unquote);
        }
        if (record.every((cell) => !cell?.trim())) continue;
        const values: Record<string, string> = {};
        headers.forEach((header, index) => {
          if (header) values[header] = (record[index] ?? '').trim();
        });
        yield { rowNumber, values };
      }
    })(),
  };
}

/** A value that starts with a quote that is not closed by the end of the line. */
function opensQuote(cell: string): boolean {
  return cell.startsWith('"') && (cell.length === 1 || !cell.endsWith('"'));
}

/** "Value" → Value, with "" inside turned back into ". Anything else as it is. */
export function unquote(cell: string): string {
  if (cell.length >= 2 && cell.startsWith('"') && cell.endsWith('"')) {
    return cell.slice(1, -1).replace(/""/g, '"').trim();
  }
  return cell;
}

async function readHead(path: string, bytes: number): Promise<Buffer> {
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}
