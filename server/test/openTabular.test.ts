import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { openTabular } from '../src/import/parseTabular.ts';

async function readAll(text: string, filename = 'feed.tsv') {
  const table = await openTabular(Buffer.from(text), filename);
  const rows = [];
  for await (const row of table.rows) rows.push(row);
  return { table, rows };
}

/**
 * The first real collection failed on all three feeds with "Invalid Closing
 * Quote": product text uses quote marks as inches and around names, and the
 * tab-separated feeds were being read as if quotes wrapped values.
 */
describe('reading a tab-separated feed', () => {
  it('reads quote marks in product text as text', async () => {
    const { rows } = await readAll(
      'id\ttitle\tprice\n' +
        '1\t9ct Gold 18" Chain\t100.00 GBP\n' +
        '2\t"Love" Heart Pendant\t50.00 GBP\n' +
        '3\tSilver 7.5" "Belcher" Bracelet\t30.00 GBP\n',
    );
    assert.deepEqual(
      rows.map((row) => [row.values.id, row.values.title, row.values.price]),
      [
        ['1', '9ct Gold 18" Chain', '100.00 GBP'],
        ['2', '"Love" Heart Pendant', '50.00 GBP'],
        ['3', 'Silver 7.5" "Belcher" Bracelet', '30.00 GBP'],
      ],
    );
  });

  it('takes the quotes off a value wrapped in them', async () => {
    const { rows } = await readAll('id\ttitle\tprice\n"4"\t"Ring, ""Eternity"" 18ct"\t"200.00 GBP"\n');
    assert.deepEqual(rows[0]?.values, { id: '4', title: 'Ring, "Eternity" 18ct', price: '200.00 GBP' });
  });

  it('joins a quoted value broken over lines back into one row', async () => {
    const { rows } = await readAll(
      'id\tdescription\tprice\n' +
        '5\t"First line\nsecond line\nthird"\t10.00 GBP\n' +
        '6\tPlain\t20.00 GBP\n',
    );
    assert.deepEqual(
      rows.map((row) => [row.values.id, row.values.description, row.values.price]),
      [
        ['5', 'First line\nsecond line\nthird', '10.00 GBP'],
        ['6', 'Plain', '20.00 GBP'],
      ],
    );
    assert.equal(rows[0]?.rowNumber, 2);
    assert.equal(rows[1]?.rowNumber, 5);
  });

  it('reports how far through the file it is', async () => {
    const text = 'id\tprice\n' + Array.from({ length: 2000 }, (_, i) => `${i}\t1.00 GBP`).join('\n') + '\n';
    const { table, rows } = await readAll(text);
    assert.equal(rows.length, 2000);
    assert.equal(table.totalBytes, Buffer.byteLength(text));
    assert.equal(table.bytesRead(), table.totalBytes);
  });

  it('still reads quoted values in a comma-separated file', async () => {
    const { rows } = await readAll('id,title,price\n7,"Ring, gold",5.00 GBP\n', 'feed.csv');
    assert.deepEqual(rows[0]?.values, { id: '7', title: 'Ring, gold', price: '5.00 GBP' });
  });
});
