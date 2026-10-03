import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { mkdtempSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import FtpSrv from 'ftp-srv';

/**
 * End-to-end against a real FTP server.
 *
 * The file-selection logic has its own tests; this covers the part that cannot
 * be reasoned about — actually connecting, listing and downloading — because a
 * wrong path join or a stream never flushed produces an empty buffer that
 * looks exactly like an empty feed.
 *
 * Env is set before importing anything that reads it: the config module
 * snapshots process.env at import time, so a later assignment would be
 * invisible.
 */
const DATABASE_URL = process.env.DATABASE_URL;

describe('feed ingest over FTP', { skip: !DATABASE_URL && 'DATABASE_URL not set' }, () => {
  let server: FtpSrv;
  let root: string;
  let port = 0;

  let ingestFeedsFromSource: typeof import('../src/import/feedIngest.ts').ingestFeedsFromSource;
  let listFeedDirectory: typeof import('../src/import/feedSource.ts').listFeedDirectory;
  let query: typeof import('../src/db/pool.ts').query;
  let closePool: typeof import('../src/db/pool.ts').closePool;

  const SKU_PREFIX = 'tst-ftp-';

  /** A minimal but genuine Google feed, with an intact 13-digit GTIN. */
  function feedCsv(sku: string, price: string, gtin: string): string {
    return (
      'id,title,brand,gtin,link,product_type,price,availability\n' +
      `${sku},Ingest Test Watch,TestBrand,${gtin},https://example.com/p/1,Watches,${price} GBP,in stock\n`
    );
  }

  before(async () => {
    root = mkdtempSync(join(tmpdir(), 'feed-ftp-'));

    server = new FtpSrv({ url: 'ftp://127.0.0.1:0', anonymous: false, pasv_url: '127.0.0.1' });
    server.on('login', (_data, resolve) => resolve({ root }));
    await server.listen();
    port = (server.server as unknown as { address(): { port: number } }).address().port;

    process.env.FEED_FTP_PROTOCOL = 'ftp';
    process.env.FEED_FTP_HOST = '127.0.0.1';
    process.env.FEED_FTP_PORT = String(port);
    process.env.FEED_FTP_USER = 'tester';
    process.env.FEED_FTP_PASSWORD = 'tester';
    process.env.FEED_FTP_DIRECTORY = '/';
    process.env.FEED_FTP_PATTERN_197 = 'goldsmiths_*.csv';

    ({ ingestFeedsFromSource } = await import('../src/import/feedIngest.ts'));
    ({ listFeedDirectory } = await import('../src/import/feedSource.ts'));
    ({ query, closePool } = await import('../src/db/pool.ts'));

    await cleanup();
  });

  async function cleanup(): Promise<void> {
    await query(
      `DELETE FROM fascia_prices WHERE product_id IN (SELECT id FROM products WHERE internal_sku LIKE $1)`,
      [`${SKU_PREFIX}%`],
    );
    await query('DELETE FROM products WHERE internal_sku LIKE $1', [`${SKU_PREFIX}%`]);
    await query(
      `DELETE FROM feed_imports WHERE filename LIKE 'goldsmiths_%' OR filename LIKE 'wos_%'`,
    );
  }

  after(async () => {
    await cleanup();
    await server?.close();
    await closePool();
  });

  function publish(name: string, contents: string | Buffer, modifiedAt?: Date): void {
    const path = join(root, name);
    writeFileSync(path, contents);
    if (modifiedAt) utimesSync(path, modifiedAt, modifiedAt);
  }

  it('lists what is actually in the directory', async () => {
    publish('goldsmiths_2026-10-01.csv', feedCsv(`${SKU_PREFIX}a`, '100.00', '7020000000001'));
    const files = await listFeedDirectory();
    assert.ok(files.some((file) => file.name === 'goldsmiths_2026-10-01.csv'));
  });

  it('downloads and imports the newest matching feed', async () => {
    publish(
      'goldsmiths_2026-10-02.csv',
      feedCsv(`${SKU_PREFIX}b`, '250.00', '7020000000002'),
      new Date(Date.now()),
    );

    const report = await ingestFeedsFromSource();
    const outcome = report.outcomes.find((entry) => entry.fasciaCode === '197');

    assert.equal(outcome?.status, 'imported');
    assert.equal(outcome?.filename, 'goldsmiths_2026-10-02.csv');
    assert.equal(outcome?.result?.pricesWritten, 1);

    // The whole point of collecting the file from the server: the GTIN is
    // intact rather than mangled into scientific notation by Excel.
    assert.equal(outcome?.result?.withUsableIdentifier, 1);
    assert.equal(outcome?.result?.damagedGtin, 0);

    const { rows } = await query<{ ean_mpn: string | null }>(
      'SELECT ean_mpn FROM products WHERE internal_sku = $1',
      [`${SKU_PREFIX}b`],
    );
    assert.equal(rows[0]?.ean_mpn, '7020000000002');
  });

  it('does not import the same file twice', async () => {
    // A feed is authoritative, so a needless re-import rewrites prices and
    // churns the delist counters for no new information.
    const report = await ingestFeedsFromSource();
    const outcome = report.outcomes.find((entry) => entry.fasciaCode === '197');
    assert.equal(outcome?.status, 'unchanged');
    assert.equal(outcome?.result, null);
  });

  it('imports again when forced, for a re-run by hand', async () => {
    const report = await ingestFeedsFromSource({ force: true });
    assert.equal(report.outcomes.find((entry) => entry.fasciaCode === '197')?.status, 'imported');
  });

  it('picks up a genuinely new file published under the same name', async () => {
    // The ordinary daily case: same filename, new contents.
    publish(
      'goldsmiths_2026-10-02.csv',
      feedCsv(`${SKU_PREFIX}c`, '999.00', '7020000000003') +
        `${SKU_PREFIX}d,Second Watch,TestBrand,7020000000004,https://example.com/p/2,Watches,50.00 GBP,in stock\n`,
    );

    const report = await ingestFeedsFromSource();
    const outcome = report.outcomes.find((entry) => entry.fasciaCode === '197');
    assert.equal(outcome?.status, 'imported', 'a changed file must not read as unchanged');
    assert.equal(outcome?.result?.pricesWritten, 2);
  });

  it('handles a gzipped feed', async () => {
    publish(
      'goldsmiths_2026-10-04.csv.gz',
      gzipSync(Buffer.from(feedCsv(`${SKU_PREFIX}e`, '75.00', '7020000000005'))),
      new Date(Date.now() + 60_000),
    );
    process.env.FEED_FTP_PATTERN_197 = 'goldsmiths_*';

    const report = await ingestFeedsFromSource();
    const outcome = report.outcomes.find((entry) => entry.fasciaCode === '197');
    assert.equal(outcome?.status, 'imported');
    assert.equal(outcome?.filename, 'goldsmiths_2026-10-04.csv', '.gz must be stripped for parsing');
    assert.equal(outcome?.result?.pricesWritten, 1);

    process.env.FEED_FTP_PATTERN_197 = 'goldsmiths_*.csv';
  });

  it('reports a pattern that matches nothing without failing the others', async () => {
    process.env.FEED_FTP_PATTERN_470 = 'wos_*.csv';
    try {
      const report = await ingestFeedsFromSource({ force: true });

      const missing = report.outcomes.find((entry) => entry.fasciaCode === '470');
      assert.equal(missing?.status, 'missing');
      assert.match(missing?.message ?? '', /No file matching/);

      // One site having no feed yet must not cost the others their refresh.
      assert.equal(report.outcomes.find((entry) => entry.fasciaCode === '197')?.status, 'imported');
    } finally {
      delete process.env.FEED_FTP_PATTERN_470;
    }
  });
});
