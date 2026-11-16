/** Column names that hold an identifier, in any common spelling. */
const IDENTIFIER_COLUMNS = /^(id|sku|item ?code|product ?code|internal ?sku|gtin|ean|barcode|upc|mpn|ref|reference|reference ?number|manufacturer ?ref(erence)?)$/i;

/**
 * Reads an uploaded list into the values to look up.
 *
 * A plain list — one value per line, or separated by commas or tabs — is taken
 * whole. A spreadsheet export with a header row (a Google feed, a buying
 * report) is read by column instead: only the columns named like an identifier
 * (id, sku, gtin, ean, barcode, mpn, reference…) are used. Without that, every
 * title and price in the file would be looked up as though it were a SKU and
 * reported back as "not found".
 */
export function parseSkuList(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (raw: string | undefined) => {
    const value = (raw ?? '').trim().replace(/^"(.*)"$/, '$1').trim();
    if (!value || seen.has(value)) return;
    seen.add(value);
    out.push(value);
  };

  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== '');
  const delimiter = lines[0]?.includes('\t') ? '\t' : ',';
  const header = (lines[0] ?? '').split(delimiter).map((cell) => cell.trim().replace(/^"(.*)"$/, '$1'));
  const columns = header
    .map((name, index) => (IDENTIFIER_COLUMNS.test(name.replace(/[_-]/g, ' ').trim()) ? index : -1))
    .filter((index) => index >= 0);

  if (header.length > 1 && columns.length > 0) {
    for (const line of lines.slice(1)) {
      const cells = line.split(delimiter);
      for (const index of columns) add(cells[index]);
    }
    return out;
  }

  for (const raw of text.split(/[\r\n,\t]+/)) add(raw);
  // A single-column file with a heading: drop the heading.
  if (out.length > 1 && IDENTIFIER_COLUMNS.test((out[0] ?? '').replace(/[_-]/g, ' '))) out.shift();
  return out;
}
