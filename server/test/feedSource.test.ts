import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { describe, it } from 'node:test';
import {
  fileSignature,
  maybeGunzip,
  newestMatching,
  patternToRegExp,
  unzippedName,
  type RemoteFile,
} from '../src/import/feedSource.js';

const file = (name: string, modifiedAt = 0, size = 100): RemoteFile => ({
  name,
  size,
  modifiedAt,
});

/**
 * Picking the wrong file here is silent and expensive: a feed is authoritative
 * for its site, so importing last week's would rewrite today's prices and
 * delist everything added since. These tests are about that choice.
 */
describe('feed file selection', () => {
  describe('patternToRegExp', () => {
    it('treats * as a wildcard and everything else literally', () => {
      const re = patternToRegExp('goldsmiths_*.csv');
      assert.ok(re.test('goldsmiths_2026-10-03.csv'));
      assert.ok(re.test('goldsmiths_.csv'));
      assert.ok(!re.test('mappin_2026-10-03.csv'));
    });

    it('does not let a dot in the pattern match any character', () => {
      // The trap: a naive glob-to-regex leaves "." meaning "any character", so
      // "feed.csv" would also match "feedxcsv" — and, worse, "goldsmiths.csv"
      // would match "goldsmithsXcsv" from an unrelated system.
      const re = patternToRegExp('feed.csv');
      assert.ok(re.test('feed.csv'));
      assert.ok(!re.test('feedxcsv'));
    });

    it('anchors, so a pattern cannot match a longer name by accident', () => {
      const re = patternToRegExp('wos.csv');
      assert.ok(!re.test('old_wos.csv'));
      assert.ok(!re.test('wos.csv.bak'));
    });

    it('matches case-insensitively, because FTP servers vary', () => {
      assert.ok(patternToRegExp('Goldsmiths_*.CSV').test('goldsmiths_01.csv'));
    });

    it('refuses a pattern containing a path, rather than walking out of the directory', () => {
      assert.throws(() => patternToRegExp('../../etc/passwd'), /must be a filename/);
      assert.throws(() => patternToRegExp('sub/dir/feed.csv'), /must be a filename/);
    });
  });

  describe('newestMatching', () => {
    it('picks the most recently modified match', () => {
      const chosen = newestMatching(
        [file('gs_old.csv', 1000), file('gs_new.csv', 5000), file('gs_mid.csv', 3000)],
        'gs_*.csv',
      );
      assert.equal(chosen?.name, 'gs_new.csv');
    });

    it('ignores files that do not match, however new they are', () => {
      const chosen = newestMatching(
        [file('mappin_today.csv', 9999), file('gs_yesterday.csv', 1)],
        'gs_*.csv',
      );
      assert.equal(chosen?.name, 'gs_yesterday.csv');
    });

    it('falls back to the name when the server reports no timestamp', () => {
      // Plenty of FTP servers report nothing useful here, and feeds are very
      // often dated in the filename — so the newest name is the right answer
      // exactly when the timestamp is missing.
      const chosen = newestMatching(
        [file('gs_2026-10-01.csv', 0), file('gs_2026-10-03.csv', 0), file('gs_2026-10-02.csv', 0)],
        'gs_*.csv',
      );
      assert.equal(chosen?.name, 'gs_2026-10-03.csv');
    });

    it('returns null when nothing matches, rather than guessing', () => {
      assert.equal(newestMatching([file('readme.txt')], 'gs_*.csv'), null);
      assert.equal(newestMatching([], 'gs_*.csv'), null);
    });
  });

  describe('fileSignature', () => {
    it('changes when the file changes, though the name has not', () => {
      // The case this exists for: these feeds are republished under the same
      // filename every single day.
      const monday = fileSignature(file('feed.csv', 1000, 500));
      const tuesday = fileSignature(file('feed.csv', 2000, 520));
      assert.notEqual(monday, tuesday);
    });

    it('is stable for the same file, so a re-run imports nothing', () => {
      assert.equal(fileSignature(file('feed.csv', 1000, 500)), fileSignature(file('feed.csv', 1000, 500)));
    });

    it('notices a file rewritten to the same size at a new time', () => {
      assert.notEqual(
        fileSignature(file('feed.csv', 1000, 500)),
        fileSignature(file('feed.csv', 9000, 500)),
      );
    });
  });

  describe('gzip handling', () => {
    it('decompresses a gzipped feed', () => {
      const original = Buffer.from('id,price\nABC,10.00\n');
      assert.deepEqual(maybeGunzip(gzipSync(original), 'feed.csv.gz'), original);
    });

    it('leaves a plain file alone', () => {
      const plain = Buffer.from('id,price\nABC,10.00\n');
      assert.deepEqual(maybeGunzip(plain, 'feed.csv'), plain);
    });

    it('detects gzip by its magic bytes, not the extension', () => {
      // A server serving a .gz already decompressed, or a gzipped file named
      // without the suffix, are both common. The bytes are the truth.
      const plain = Buffer.from('id,price\n');
      assert.deepEqual(maybeGunzip(plain, 'feed.csv.gz'), plain);
      const zipped = gzipSync(plain);
      assert.deepEqual(maybeGunzip(zipped, 'feed.csv'), plain);
    });

    it('strips .gz so the parser sees the real format', () => {
      // parseTabularFile decides by extension as well as content; leaving .gz
      // on would have it reasoning about the wrong format.
      assert.equal(unzippedName('goldsmiths.csv.gz'), 'goldsmiths.csv');
      assert.equal(unzippedName('goldsmiths.csv'), 'goldsmiths.csv');
      assert.equal(unzippedName('goldsmiths.CSV.GZ'), 'goldsmiths.CSV');
    });
  });
});
