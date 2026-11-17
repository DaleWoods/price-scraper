import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import ExcelJS from 'exceljs';
import { looksLikeBinary, valuesFromFile } from '../src/services/listFile.ts';

async function workbook(rows: unknown[][]): Promise<Buffer> {
  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet('Sheet1');
  for (const row of rows) sheet.addRow(row);
  return Buffer.from(await book.xlsx.writeBuffer());
}

/**
 * The first real list uploaded was an Excel file of 210 SKUs. The page read it
 * as text and sent gibberish, and the check failed with "Internal server
 * error". Excel files are now read on the server.
 */
describe('reading a list from a spreadsheet', () => {
  it('reads the SKU column of an Excel file', async () => {
    const buffer = await workbook([['SKU'], ['17611061'], ['17611060'], ['17611061']]);
    assert.deepEqual(await valuesFromFile(buffer, 'Book3.xlsx'), ['17611061', '17611060']);
  });

  it('gives a SKU back the leading zero Excel took off it', async () => {
    const buffer = await workbook([['SKU'], [6019628], ['17611061']]);
    assert.deepEqual(await valuesFromFile(buffer, 'Book3.xlsx'), ['06019628', '17611061']);
  });

  it('reads only identifier columns when there are others', async () => {
    const buffer = await workbook([
      ['Title', 'SKU', 'Price'],
      ['Omega Seamaster', '17331581', '5600'],
    ]);
    assert.deepEqual(await valuesFromFile(buffer, 'list.xlsx'), ['17331581']);
  });

  it('takes the first column, heading and all, when nothing is headed like an identifier', async () => {
    const buffer = await workbook([['17331581'], ['17771125']]);
    assert.deepEqual(await valuesFromFile(buffer, 'list.xlsx'), ['17331581', '17771125']);
  });

  it('reads a CSV the same way', async () => {
    assert.deepEqual(await valuesFromFile(Buffer.from('sku,title\n17331581,Omega\n'), 'list.csv'), ['17331581']);
  });

  it('recognises a binary file read as text', async () => {
    const buffer = await workbook([['SKU'], ['17611061']]);
    const asText = buffer.toString('utf8').split('\n');
    assert.equal(looksLikeBinary(asText), true);
    assert.equal(looksLikeBinary(['17611061', 'CA0080-54E']), false);
  });
});
