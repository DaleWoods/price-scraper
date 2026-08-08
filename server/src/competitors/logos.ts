import { query } from '../db/pool.js';

/** Logos are small; anything larger is not a favicon and is refused. */
const MAX_LOGO_BYTES = 512 * 1024;
const FETCH_TIMEOUT_MS = 15_000;

export interface LogoRefreshResult {
  slug: string;
  displayName: string;
  status: 'fetched' | 'unchanged' | 'failed';
  source?: string;
  bytes?: number;
  error?: string;
}

/**
 * Icon declarations in the page head, best first.
 *
 * apple-touch-icon is preferred because it is required to be a square PNG of at
 * least 120px, whereas /favicon.ico is often a 16px relic that looks like mud
 * next to text.
 */
const ICON_REL_PATTERNS: { pattern: RegExp; rank: number }[] = [
  { pattern: /apple-touch-icon(-precomposed)?/i, rank: 0 },
  { pattern: /^icon$/i, rank: 1 },
  { pattern: /shortcut icon/i, rank: 2 },
  { pattern: /mask-icon/i, rank: 3 },
];

/**
 * Resolve an icon href against the page URL, or null if it is not usable.
 *
 * `new URL()` alone is not enough of a check: a malformed value like
 * "ht tp://broken" does not throw, it silently resolves to a path relative to
 * the site, producing a candidate that can only ever 404.
 */
function resolveIconHref(href: string, baseUrl: string): string | null {
  const trimmed = href.trim();
  if (!trimmed || /[\s<>"]/.test(trimmed)) return null;

  try {
    const url = new URL(trimmed, baseUrl);
    // Only over the network — data: and javascript: are not ours to fetch.
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null;
  } catch {
    return null;
  }
}

/** Pull candidate icon URLs out of a page's HTML, best-ranked first. */
export function discoverIconUrls(html: string, baseUrl: string): string[] {
  const found: { url: string; rank: number; size: number }[] = [];
  const linkTags = html.match(/<link\b[^>]*>/gi) ?? [];

  for (const tag of linkTags) {
    const rel = tag.match(/\brel\s*=\s*["']([^"']+)["']/i)?.[1];
    const href = tag.match(/\bhref\s*=\s*["']([^"']+)["']/i)?.[1];
    if (!rel || !href) continue;

    const match = ICON_REL_PATTERNS.find(({ pattern }) => pattern.test(rel.trim()));
    if (!match) continue;

    // "180x180" — bigger is better within a rel type.
    const size = Number.parseInt(tag.match(/\bsizes\s*=\s*["'](\d+)/i)?.[1] ?? '0', 10) || 0;

    const resolved = resolveIconHref(href, baseUrl);
    if (resolved) found.push({ url: resolved, rank: match.rank, size });
  }

  found.sort((a, b) => a.rank - b.rank || b.size - a.size);

  const ordered = found.map((candidate) => candidate.url);
  // Always worth a try as a last resort, even when the head declared nothing.
  try {
    ordered.push(new URL('/favicon.ico', baseUrl).toString());
  } catch {
    /* base URL is unusable; the caller reports the failure */
  }

  return [...new Set(ordered)];
}

async function fetchWithTimeout(url: string): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        // Identify honestly rather than impersonating a browser.
        'user-agent': 'PriceMonitor/0.1 (+logo fetch)',
        accept: 'image/avif,image/webp,image/png,image/svg+xml,image/*,*/*;q=0.5',
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

/** True when the bytes actually look like an image we can render. */
function isRenderableImage(contentType: string | null, bytes: Buffer): boolean {
  if (bytes.length === 0 || bytes.length > MAX_LOGO_BYTES) return false;

  const type = (contentType ?? '').toLowerCase();
  if (type.startsWith('image/')) return true;

  // Some servers send favicons as application/octet-stream; sniff the magic
  // numbers rather than discarding a perfectly good icon.
  const header = bytes.subarray(0, 8);
  const isPng = header.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const isGif = header.subarray(0, 3).toString('latin1') === 'GIF';
  const isJpeg = header[0] === 0xff && header[1] === 0xd8;
  const isIco = header[0] === 0x00 && header[1] === 0x00 && (header[2] === 0x01 || header[2] === 0x02);
  const isSvg = bytes.subarray(0, 512).toString('utf8').trimStart().startsWith('<svg');
  return isPng || isGif || isJpeg || isIco || isSvg;
}

function contentTypeFor(declared: string | null, bytes: Buffer): string {
  const type = (declared ?? '').split(';')[0]?.trim().toLowerCase();
  if (type && type.startsWith('image/')) return type;
  if (bytes.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))) return 'image/png';
  if (bytes.subarray(0, 3).toString('latin1') === 'GIF') return 'image/gif';
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg';
  if (bytes.subarray(0, 512).toString('utf8').trimStart().startsWith('<svg')) return 'image/svg+xml';
  return 'image/x-icon';
}

/**
 * Fetch and cache one competitor's logo.
 *
 * An explicit `logo_url` (set in the competitor's JSON definition) is tried
 * first; otherwise the site's head is read for icon declarations, falling back
 * to /favicon.ico.
 */
export async function refreshCompetitorLogo(competitor: {
  slug: string;
  display_name: string;
  base_url: string;
  logo_url: string | null;
}): Promise<LogoRefreshResult> {
  const base = { slug: competitor.slug, displayName: competitor.display_name };
  const candidates: string[] = [];

  if (competitor.logo_url) {
    candidates.push(competitor.logo_url);
  } else {
    try {
      const page = await fetchWithTimeout(competitor.base_url);
      const html = page.ok ? await page.text() : '';
      candidates.push(...discoverIconUrls(html, competitor.base_url));
    } catch {
      // Unreachable site: still worth trying the conventional path directly.
      try {
        candidates.push(new URL('/favicon.ico', competitor.base_url).toString());
      } catch {
        /* handled by the empty-candidates check below */
      }
    }
  }

  let lastError = 'no icon candidates found';

  for (const url of candidates) {
    try {
      const response = await fetchWithTimeout(url);
      if (!response.ok) {
        lastError = `${url} returned HTTP ${response.status}`;
        continue;
      }

      const bytes = Buffer.from(await response.arrayBuffer());
      const declared = response.headers.get('content-type');
      if (!isRenderableImage(declared, bytes)) {
        lastError = `${url} did not return a usable image`;
        continue;
      }

      await query(
        `UPDATE competitors
         SET logo_data = $2, logo_content_type = $3, logo_url = $4,
             logo_fetched_at = now(), logo_error = NULL, updated_at = now()
         WHERE slug = $1`,
        [competitor.slug, bytes, contentTypeFor(declared, bytes), url],
      );

      return { ...base, status: 'fetched', source: url, bytes: bytes.length };
    } catch (err) {
      lastError = `${url}: ${(err as Error).message}`;
    }
  }

  await query('UPDATE competitors SET logo_error = $2, updated_at = now() WHERE slug = $1', [
    competitor.slug,
    lastError,
  ]);

  return { ...base, status: 'failed', error: lastError };
}

/** Refresh every competitor's logo, sequentially so we stay polite. */
export async function refreshAllLogos(force = false): Promise<LogoRefreshResult[]> {
  const { rows } = await query<{
    slug: string;
    display_name: string;
    base_url: string;
    logo_url: string | null;
    has_logo: boolean;
  }>(
    `SELECT slug, display_name, base_url, logo_url, (logo_data IS NOT NULL) AS has_logo
     FROM competitors ORDER BY display_name`,
  );

  const results: LogoRefreshResult[] = [];
  for (const row of rows) {
    if (row.has_logo && !force) {
      results.push({ slug: row.slug, displayName: row.display_name, status: 'unchanged' });
      continue;
    }
    results.push(await refreshCompetitorLogo(row));
  }
  return results;
}
