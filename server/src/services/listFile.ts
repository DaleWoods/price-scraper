import { parseTabularFile } from '../import/parseTabular.js';

/** Column names that hold an identifier, in any common spelling. Mirrors web/src/skuList.ts. */
const IDENTIFIER_COLUMNS =
  /^(id|sku|item ?code|product ?code|internal ?sku|gtin|ean|barcode|upc|mpn|ref|reference|reference ?number|manufacturer ?ref(erence)?)$/i;

/** Columns holding our own SKU, where a 7-digit number has lost its leading zero. */
const SKU_COLUMNS = /^(id|sku|item ?code|product ?code|internal ?sku)$/i;

/**
 * The values to check from an uploaded spreadsheet (Excel or CSV), by the same
 * rules the page uses for a CSV: the columns named like an identifier, or the
 * first column when none is.
 *
 * Read here rather than in the browser because an Excel file is a compressed
 * binary, not text. The page read one as text and sent 210 lines of gibberish,
 * which the database then refused — the first real 210-product list failed
 * with nothing more than "Internal server error".
 *
 * Excel turns a SKU typed as a number into one: 06019628 becomes 6019628. Our
 * SKUs are eight digits, so in a SKU column a seven-digit number gets its
 * leading zero back.
 */
export async function valuesFromFile(buffer: Buffer, filename: string): Promise<string[]> {
  const { headers, rows } = await parseTabularFile(buffer, filename);
  const normalise = (name: string) => name.replace(/[_-]/g, ' ').trim();
  let columns = headers.filter((header) => header && IDENTIFIER_COLUMNS.test(normalise(header)));

  const seen = new Set<string>();
  const out: string[] = [];
  const add = (raw: string | undefined, column: string) => {
    let value = (raw ?? '').trim();
    if (!value) return;
    if (SKU_COLUMNS.test(normalise(column)) && /^[0-9]{7}$/.test(value)) value = `0${value}`;
    if (seen.has(value)) return;
    seen.add(value);
    out.push(value);
  };

  if (columns.length === 0) {
    // No identifier heading: the first column, with its heading counted as a
    // value — a list typed straight into column A has no heading at all.
    const first = headers[0];
    if (!first) return [];
    add(first, '');
    columns = [first];
  }
  for (const row of rows) for (const column of columns) add(row.values[column], column);
  return out;
}

/**
 * True when values look like gibberish rather than a list: control characters
 * or the replacement character, which is what a binary file read as text turns
 * into.
 */
export function looksLikeBinary(values: string[]): boolean {
  // eslint-disable-next-line no-control-regex
  return values.some((value) => /[\u0000-\u0008\u000e-\u001f�]/.test(value));
}
