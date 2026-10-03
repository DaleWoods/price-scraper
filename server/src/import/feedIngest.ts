import { query } from '../db/pool.js';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { importFeed, type FeedImportResult } from './feedImport.js';
import { fetchNewestFeeds, isFeedSourceConfigured } from './feedSource.js';

/**
 * Collect today's feeds and import them, one per fascia.
 *
 * This is the unattended path: the same import that runs behind the upload
 * form, fed from the FTP location the feeds already land in. It is safe to run
 * repeatedly — a file already imported is recognised and skipped — so it can
 * be triggered on a schedule, by hand, or both, without anyone having to
 * reason about whether it has run today.
 */

export interface FascialIngestOutcome {
  fasciaCode: string;
  pattern: string;
  filename: string | null;
  status: 'imported' | 'unchanged' | 'missing' | 'failed';
  message: string;
  result: FeedImportResult | null;
}

export interface IngestReport {
  configured: boolean;
  startedAt: string;
  finishedAt: string;
  outcomes: FascialIngestOutcome[];
}

/** Has this exact file already been imported for this fascia? */
async function alreadyImported(fasciaCode: string, signature: string): Promise<boolean> {
  const { rows } = await query<{ exists: boolean }>(
    `SELECT TRUE AS exists
     FROM feed_imports fi
     JOIN fascias f ON f.id = fi.fascia_id
     WHERE f.code = $1 AND fi.source_signature = $2
     LIMIT 1`,
    [fasciaCode, signature],
  );
  return rows.length > 0;
}

/**
 * Claim this signature for the import just recorded.
 *
 * Any earlier import holding it releases it first. Without that release a
 * forced re-import is impossible: the unique index rejects the second claim,
 * the import fails after the data has already been written, and the run
 * reports a failure for work that actually succeeded.
 *
 * The earlier row is kept — it is the audit trail of what was imported and
 * when — it simply stops being the holder of the signature. The index still
 * does its real job, which is making sure only one import claims a given file
 * at a time, so two schedulers racing cannot both import it.
 */
async function recordSignature(
  feedImportId: number,
  fasciaCode: string,
  signature: string,
): Promise<void> {
  await query(
    `UPDATE feed_imports SET source_signature = NULL
     WHERE source_signature = $2
       AND id <> $1
       AND fascia_id = (SELECT id FROM fascias WHERE code = $3)`,
    [feedImportId, signature, fasciaCode],
  );
  await query('UPDATE feed_imports SET source_signature = $2 WHERE id = $1', [
    feedImportId,
    signature,
  ]);
}

export async function ingestFeedsFromSource(
  options: { force?: boolean } = {},
): Promise<IngestReport> {
  const startedAt = new Date().toISOString();

  if (!isFeedSourceConfigured()) {
    return {
      configured: false,
      startedAt,
      finishedAt: new Date().toISOString(),
      outcomes: [],
    };
  }

  const patterns = env.feedPatterns;
  if (patterns.length === 0) {
    return {
      configured: true,
      startedAt,
      finishedAt: new Date().toISOString(),
      outcomes: [
        {
          fasciaCode: '—',
          pattern: '—',
          filename: null,
          status: 'failed',
          message:
            'A feed location is configured but no filename patterns are. Set ' +
            'FEED_FTP_PATTERN_<fascia code>, e.g. FEED_FTP_PATTERN_197=goldsmiths_*.csv',
          result: null,
        },
      ],
    };
  }

  const fetched = await fetchNewestFeeds(patterns);
  const outcomes: FascialIngestOutcome[] = [];

  for (const entry of fetched) {
    if (entry.error || !entry.feed) {
      outcomes.push({
        fasciaCode: entry.fasciaCode,
        pattern: entry.pattern,
        filename: null,
        status: 'missing',
        message: entry.error ?? 'No file found',
        result: null,
      });
      continue;
    }

    const { feed } = entry;

    if (!options.force && (await alreadyImported(entry.fasciaCode, feed.signature))) {
      outcomes.push({
        fasciaCode: entry.fasciaCode,
        pattern: entry.pattern,
        filename: feed.filename,
        status: 'unchanged',
        message: `${feed.filename} has already been imported — nothing has changed since.`,
        result: null,
      });
      continue;
    }

    try {
      const result = await importFeed(feed.buffer, feed.filename, entry.fasciaCode);
      await recordSignature(result.feedImportId, entry.fasciaCode, feed.signature);

      outcomes.push({
        fasciaCode: entry.fasciaCode,
        pattern: entry.pattern,
        filename: feed.filename,
        status: 'imported',
        message:
          `${result.productsCreated} new, ${result.productsUpdated} updated, ` +
          `${result.pricesWritten} priced, ${result.productsDelisted} delisted. ` +
          `${result.withUsableIdentifier} carry a usable EAN/MPN` +
          (result.damagedGtin > 0
            ? `, but ${result.damagedGtin} GTIN(s) arrived damaged — this feed has been through Excel.`
            : '.'),
        result,
      });

      logger.info(
        'feed-ingest',
        `[${entry.fasciaCode}] imported ${feed.filename}: ${result.pricesWritten} price(s), ` +
          `${result.withUsableIdentifier} with a usable identifier`,
      );
    } catch (err) {
      // Deliberately caught per fascia. One malformed feed must not stop the
      // other two sites being updated — a partial refresh beats none.
      outcomes.push({
        fasciaCode: entry.fasciaCode,
        pattern: entry.pattern,
        filename: feed.filename,
        status: 'failed',
        message: (err as Error).message,
        result: null,
      });
      logger.error(
        'feed-ingest',
        `[${entry.fasciaCode}] ${feed.filename} failed: ${(err as Error).message}`,
      );
    }
  }

  return {
    configured: true,
    startedAt,
    finishedAt: new Date().toISOString(),
    outcomes,
  };
}
