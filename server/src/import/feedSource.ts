import { gunzipSync } from 'node:zlib';
import { Client as FtpClient } from 'basic-ftp';
import SftpClient from 'ssh2-sftp-client';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, open, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
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
  /** Save the file to `localPath` as it arrives, never holding it in memory. */
  download(directory: string, name: string, localPath: string): Promise<void>;
  close(): Promise<void>;
}

/** A connection refused for a reason someone must act on, with the words to say so. */
export class FeedCertificateError extends Error {}

/** "AA:BB:…" or "aabb…", either way, compared on the hex digits alone. */
export function normaliseFingerprint(value: string): string {
  return value.replace(/[^0-9a-f]/gi, '').toUpperCase();
}

/**
 * FTPS to a server whose certificate is self-signed.
 *
 * The feed server (acapps.net) presents a certificate it signed itself, so
 * ordinary verification fails — correctly — and the connection was refused.
 * Turning verification off would send the password to whatever answered.
 * Instead the certificate is pinned: its SHA-256 fingerprint is set once as
 * FEED_FTP_TLS_FINGERPRINT, and the password is only sent once the server has
 * proved it holds exactly that certificate. Until the setting exists, the
 * connection stops before logging in and reports the fingerprint it saw, so it
 * can be checked against FileZilla's certificate prompt and copied in.
 *
 * A certificate that does verify normally (one issued by a real authority) is
 * accepted without a pin.
 */
async function connectFtpsPinned(client: FtpClient, config: FeedSourceConfig): Promise<void> {
  await client.connect(config.host, config.port ?? 21);
  await client.useTLS({ rejectUnauthorized: false, servername: config.host });

  const socket = client.ftp.socket as import('node:tls').TLSSocket;
  const trusted = socket.authorized === true;
  const seen = socket.getPeerCertificate?.()?.fingerprint256 ?? '';
  const pinned = env.feedFtpTlsFingerprint;

  if (!trusted) {
    if (!pinned) {
      client.close();
      throw new FeedCertificateError(
        `The feed server's certificate is self-signed, so it has to be approved once before the password is ` +
          `sent. Its SHA-256 fingerprint is ${seen}. If that matches the fingerprint FileZilla shows for ` +
          `${config.host}, add it in Render as FEED_FTP_TLS_FINGERPRINT and collect again.`,
      );
    }
    if (normaliseFingerprint(seen) !== normaliseFingerprint(pinned)) {
      client.close();
      throw new FeedCertificateError(
        `The feed server presented a different certificate from the one approved (FEED_FTP_TLS_FINGERPRINT), ` +
          `so the password was not sent. It now presents ${seen}. If the server's certificate has genuinely been ` +
          `renewed, check the new fingerprint in FileZilla and update the setting.`,
      );
    }
  }

  await loginWithRetry(client, config);
  await client.useDefaultSettings();
}

/**
 * Log in, with the password cleaned of anything pasted around it.
 *
 * The first real collection was refused with "530 Login incorrect". A password
 * pasted into a settings page often carries a space or line break at either
 * end, invisible in the box. A line break cannot be sent over FTP at all, and
 * an FTP password starting or ending with a space is vanishingly rare, so both
 * are removed. A refusal after that is explained in words rather than as a
 * bare FTP code.
 */
async function loginWithRetry(client: FtpClient, config: FeedSourceConfig): Promise<void> {
  const user = (config.user ?? '').trim();
  const password = (config.password ?? '').trim();
  try {
    await client.login(user, password);
  } catch (err) {
    if (!/\b530\b/.test((err as Error).message)) throw err;
    throw new FeedCertificateError(
      `The FTP server (${config.host}) refused the username or password (530 Login incorrect). ` +
        `Check FEED_FTP_USER is exactly "${user}" as in FileZilla, and retype FEED_FTP_PASSWORD in Render ` +
        `rather than pasting it.`,
    );
  }
}

async function connectFtp(config: FeedSourceConfig): Promise<Connection> {
  const client = new FtpClient(env.requestTimeoutMs);
  // The library logs the full command stream, credentials included, when
  // verbose. It must stay off.
  client.ftp.verbose = false;

  if (config.protocol === 'ftps') {
    await connectFtpsPinned(client, config);
  } else {
    await client.access({
      host: config.host,
      port: config.port,
      user: config.user,
      password: config.password,
      secure: false,
    });
  }

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
    async download(directory, name, localPath) {
      await client.downloadTo(localPath, `${directory.replace(/\/$/, '')}/${name}`);
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
    async download(directory, name, localPath) {
      await client.get(`${directory.replace(/\/$/, '')}/${name}`, createWriteStream(localPath));
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
  /** Where the file was saved; the caller deletes it once imported. */
  path: string;
  filename: string;
}

/** Decompress a gzipped file on disk in place, streaming; leaves a plain file alone. */
async function gunzipFileIfNeeded(filePath: string, name: string): Promise<void> {
  const handle = await open(filePath, 'r');
  const magic = Buffer.alloc(2);
  try {
    await handle.read(magic, 0, 2, 0);
  } finally {
    await handle.close();
  }
  if (magic[0] !== 0x1f || magic[1] !== 0x8b) return;
  logger.info('feed-source', `${name} is gzipped; decompressing`);
  const plain = `${filePath}.plain`;
  await pipeline(createReadStream(filePath), createGunzip(), createWriteStream(plain));
  await rename(plain, filePath);
}

/** Delete a downloaded feed and the folder it was saved in. */
export async function discardFeed(feed: FetchedFeed): Promise<void> {
  await rm(path.dirname(feed.path), { recursive: true, force: true }).catch(() => undefined);
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
  options: {
    /**
     * Asked before each download. True skips the file: the Goldsmiths feed is
     * 388 MB, and fetching it only to find it was imported yesterday is a
     * waste of minutes and bandwidth.
     */
    skip?: (fasciaCode: string, signature: string) => Promise<boolean>;
  } = {},
): Promise<
  {
    fasciaCode: string;
    pattern: string;
    feed: FetchedFeed | null;
    error: string | null;
    skipped?: { filename: string; signature: string };
  }[]
> {
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

        const signature = fileSignature(file);
        if (await options.skip?.(fasciaCode, signature)) {
          results.push({
            fasciaCode,
            pattern,
            feed: null,
            error: null,
            skipped: { filename: unzippedName(file.name), signature },
          });
          continue;
        }

        // Saved to disk, not memory: a whole feed held in memory is what does
        // not fit on the server. Each file gets its own folder, deleted once
        // imported (see discardFeed).
        const folder = await mkdtemp(path.join(tmpdir(), 'feed-'));
        const localPath = path.join(folder, 'feed');
        await connection.download(config.directory, file.name, localPath);
        await gunzipFileIfNeeded(localPath, file.name);
        results.push({
          fasciaCode,
          pattern,
          feed: { file, signature, path: localPath, filename: unzippedName(file.name) },
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
