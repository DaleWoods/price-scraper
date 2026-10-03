import { gunzipSync } from 'node:zlib';
import { Client as FtpClient } from 'basic-ftp';
import SftpClient from 'ssh2-sftp-client';
import { Writable } from 'node:stream';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';

/**
 * Collect the daily Google feeds from the FTP location they are already
 * delivered to, instead of waiting for someone to upload them by hand.
 *
 * This is worth more than the convenience suggests. The feeds that reached us
 * through a person had been opened in Excel on the way, which turns a 13-digit
 * GTIN into "7.32E+11" — in the first Goldsmiths feed that destroyed 263 of
 * 266 of them. An EAN is the strongest matching key there is, and the only one
 * that survives a competitor using different SKUs to us, so losing it costs
 * far more than it looks. Taking the file off the server untouched keeps it.
 *
 * Both FTP(S) and SFTP are supported because "FTP" is used colloquially for
 * both, and discovering which one a business actually runs after shipping
 * support for the other is a rebuild rather than a setting.
 */

export type FeedProtocol = 'ftp' | 'ftps' | 'sftp';

export interface RemoteFile {
  name: string;
  /** Bytes, as the server reports them. */
  size: number;
  /** Epoch milliseconds, or 0 where the server does not say. */
  modifiedAt: number;
}

export interface FeedSourceConfig {
  protocol: FeedProtocol;
  host: string;
  port: number;
  user: string;
  password: string;
  directory: string;
}

/** Is a remote feed location configured at all? */
export function isFeedSourceConfigured(): boolean {
  return Boolean(env.feedFtpHost && env.feedFtpUser && env.feedFtpPassword);
}

export function feedSourceConfig(): FeedSourceConfig {
  if (!isFeedSourceConfigured()) {
    throw new Error(
      'No feed FTP location is configured. Set FEED_FTP_HOST, FEED_FTP_USER and FEED_FTP_PASSWORD.',
    );
  }
  const protocol = env.feedFtpProtocol;
  return {
    protocol,
    host: env.feedFtpHost!,
    port: env.feedFtpPort ?? (protocol === 'sftp' ? 22 : 21),
    user: env.feedFtpUser!,
    password: env.feedFtpPassword!,
    directory: env.feedFtpDirectory,
  };
}

/**
 * Turn a filename pattern into an anchored regex.
 *
 * Only `*` is meaningful, which covers every real case ("goldsmiths_*.csv")
 * without asking whoever configures this to think in regular expressions, and
 * without a stray `.` or `+` in a filename silently matching the wrong file.
 * A pattern may not contain a path separator: the directory is configured
 * once, and letting a pattern walk out of it is how a config value becomes a
 * path traversal.
 */
export function patternToRegExp(pattern: string): RegExp {
  if (pattern.includes('/') || pattern.includes('\\')) {
    throw new Error(`Feed pattern "${pattern}" must be a filename, not a path`);
  }
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, (char) =>
    char === '*' ? '\u0000' : `\\${char}`,
  );
  return new RegExp(`^${escaped.split('\u0000').join('.*')}$`, 'i');
}

/**
 * The newest file matching a pattern.
 *
 * Modified time decides, falling back to the name in descending order. The
 * fallback matters more than it sounds: plenty of FTP servers report a useless
 * timestamp, and feeds are very often named with the date in them, so the
 * newest name is the right answer exactly when the timestamp is not.
 */
export function newestMatching(files: RemoteFile[], pattern: string): RemoteFile | null {
  const regexp = patternToRegExp(pattern);
  const matches = files.filter((file) => regexp.test(file.name));
  if (matches.length === 0) return null;

  matches.sort((a, b) => {
    if (b.modifiedAt !== a.modifiedAt) return b.modifiedAt - a.modifiedAt;
    return b.name.localeCompare(a.name);
  });
  return matches[0]!;
}

/**
 * A file we have already imported should not be imported again.
 *
 * Name alone is not enough — these feeds are frequently published under the
 * same filename every day — so the signature carries the size and modified
 * time too. Re-importing the identical file is not harmless: the feed is
 * authoritative, so it would rewrite prices and churn the delist/relist
 * counters for no new information.
 */
export function fileSignature(file: RemoteFile): string {
  return `${file.name}:${file.size}:${file.modifiedAt}`;
}

interface Connection {
  list(directory: string): Promise<RemoteFile[]>;
  download(directory: string, name: string): Promise<Buffer>;
  close(): Promise<void>;
}

async function connectFtp(config: FeedSourceConfig): Promise<Connection> {
  const client = new FtpClient(env.requestTimeoutMs);
  // The library logs the full command stream, credentials included, when
  // verbose. It must stay off.
  client.ftp.verbose = false;

  await client.access({
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    secure: config.protocol === 'ftps',
  });

  return {
    async list(directory) {
      const entries = await client.list(directory);
      return entries
        .filter((entry) => entry.isFile)
        .map((entry) => ({
          name: entry.name,
          size: entry.size,
          modifiedAt: entry.modifiedAt ? entry.modifiedAt.getTime() : 0,
        }));
    },
    async download(directory, name) {
      const chunks: Buffer[] = [];
      const sink = new Writable({
        write(chunk, _encoding, callback) {
          chunks.push(Buffer.from(chunk));
          callback();
        },
      });
      await client.downloadTo(sink, `${directory.replace(/\/$/, '')}/${name}`);
      return Buffer.concat(chunks);
    },
    async close() {
      client.close();
    },
  };
}

async function connectSftp(config: FeedSourceConfig): Promise<Connection> {
  const client = new SftpClient();
  await client.connect({
    host: config.host,
    port: config.port,
    username: config.user,
    password: config.password,
    readyTimeout: env.requestTimeoutMs,
  });

  return {
    async list(directory) {
      const entries = await client.list(directory);
      return entries
        .filter((entry) => entry.type === '-')
        .map((entry) => ({
          name: entry.name,
          size: entry.size,
          modifiedAt: entry.modifyTime ?? 0,
        }));
    },
    async download(directory, name) {
      const data = await client.get(`${directory.replace(/\/$/, '')}/${name}`);
      return Buffer.isBuffer(data) ? data : Buffer.from(data as unknown as string);
    },
    async close() {
      await client.end();
    },
  };
}

async function connect(config: FeedSourceConfig): Promise<Connection> {
  return config.protocol === 'sftp' ? connectSftp(config) : connectFtp(config);
}

/** Decompress if the file is gzipped — feeds very often are. */
export function maybeGunzip(buffer: Buffer, name: string): Buffer {
  const isGzip = buffer.length > 2 && buffer[0] === 0x1f && buffer[1] === 0x8b;
  if (!isGzip) return buffer;
  logger.info('feed-source', `${name} is gzipped; decompressing`);
  return gunzipSync(buffer);
}

/** The filename after decompression, so the parser sees the real format. */
export function unzippedName(name: string): string {
  return name.replace(/\.gz$/i, '');
}

export interface FetchedFeed {
  file: RemoteFile;
  signature: string;
  buffer: Buffer;
  filename: string;
}

/**
 * List the configured directory. Used by Admin to show what is actually there
 * before anything is imported, which is how a wrong pattern gets spotted
 * without a failed import to explain it.
 */
export async function listFeedDirectory(): Promise<RemoteFile[]> {
  const config = feedSourceConfig();
  const connection = await connect(config);
  try {
    return await connection.list(config.directory);
  } finally {
    await connection.close().catch(() => undefined);
  }
}

/** Fetch the newest file matching each pattern, in one connection. */
export async function fetchNewestFeeds(
  patterns: { fasciaCode: string; pattern: string }[],
): Promise<{ fasciaCode: string; pattern: string; feed: FetchedFeed | null; error: string | null }[]> {
  const config = feedSourceConfig();
  const connection = await connect(config);
  const results: Awaited<ReturnType<typeof fetchNewestFeeds>> = [];

  try {
    const files = await connection.list(config.directory);
    logger.info(
      'feed-source',
      `${config.protocol}://${config.host}${config.directory} has ${files.length} file(s)`,
    );

    for (const { fasciaCode, pattern } of patterns) {
      try {
        const file = newestMatching(files, pattern);
        if (!file) {
          results.push({
            fasciaCode,
            pattern,
            feed: null,
            error: `No file matching "${pattern}" in ${config.directory}`,
          });
          continue;
        }

        const raw = await connection.download(config.directory, file.name);
        results.push({
          fasciaCode,
          pattern,
          feed: {
            file,
            signature: fileSignature(file),
            buffer: maybeGunzip(raw, file.name),
            filename: unzippedName(file.name),
          },
          error: null,
        });
      } catch (err) {
        // One fascia failing must not cost the others — a feed that is late or
        // half-written is a normal morning, not a reason to import nothing.
        results.push({ fasciaCode, pattern, feed: null, error: (err as Error).message });
      }
    }
  } finally {
    await connection.close().catch(() => undefined);
  }

  return results;
}
