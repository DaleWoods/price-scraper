import { gunzipSync } from 'node:zlib';
import { checkRobots, inspectRobots } from './robots.js';
import { logger } from '../lib/logger.js';

/**
 * Sitemap discovery.
 *
 * Where a retailer disallows /search — which nearly all of them do, because
 * internal search is expensive to serve and worthless to index — the sitemap is
 * the route they publish *for* crawlers, and it generally lists the same product
 * pages. So this is the sanctioned way to the data, not a way around the block.
 *
 * Every fetch still goes through robots.txt: a sitemap being declared does not
 * exempt its contents from the rules.
 */

const FETCH_TIMEOUT_MS = 30_000;
/** Sitemaps are text; anything vastly larger is not one. */
const MAX_SITEMAP_BYTES = 50 * 1024 * 1024;

export interface SitemapUrl {
  loc: string;
  lastmod: string | null;
}

export interface SitemapFetch {
  url: string;
  ok: boolean;
  error: string | null;
  /** True when this was an index pointing at further sitemaps. */
  isIndex: boolean;
  urlCount: number;
  childSitemaps: string[];
}

/** Pull <loc> values out of a sitemap or sitemap index. */
export function parseSitemapXml(xml: string): {
  isIndex: boolean;
  urls: SitemapUrl[];
  children: string[];
} {
  const isIndex = /<sitemapindex[\s>]/i.test(xml);
  const entries = xml.match(/<(url|sitemap)\b[\s\S]*?<\/\1>/gi) ?? [];

  const urls: SitemapUrl[] = [];
  const children: string[] = [];

  for (const entry of entries) {
    const loc = entry.match(/<loc>\s*([\s\S]*?)\s*<\/loc>/i)?.[1];
    if (!loc) continue;
    const decoded = decodeXmlEntities(loc.trim());
    if (!decoded) continue;

    if (/^<sitemap[\s>]/i.test(entry)) {
      children.push(decoded);
    } else {
      const lastmod = entry.match(/<lastmod>\s*([\s\S]*?)\s*<\/lastmod>/i)?.[1] ?? null;
      urls.push({ loc: decoded, lastmod: lastmod?.trim() || null });
    }
  }

  return { isIndex, urls, children };
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

async function fetchSitemapBody(url: string, userAgent: string): Promise<string> {
  const response = await fetch(url, {
    headers: { 'user-agent': userAgent, accept: 'application/xml,text/xml,*/*' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    redirect: 'follow',
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);

  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > MAX_SITEMAP_BYTES) {
    throw new Error(`sitemap is ${Math.round(bytes.length / 1024 / 1024)}MB, refusing to parse`);
  }

  // Gzipped sitemaps are common and are often served without an encoding
  // header, so sniff the magic number rather than trusting the response.
  const gzipped = bytes[0] === 0x1f && bytes[1] === 0x8b;
  return (gzipped ? gunzipSync(bytes) : bytes).toString('utf8');
}

export interface SitemapSurvey {
  origin: string;
  /** Sitemaps declared in robots.txt, plus the conventional path as a fallback. */
  declared: string[];
  fetched: SitemapFetch[];
  /** Distinct page URLs found, capped. */
  sampleUrls: string[];
  totalUrls: number;
  error: string | null;
}

/**
 * Survey what a site's sitemaps contain, without following every child.
 *
 * Answers "is there a usable route to product pages here" — the question a run
 * reporting 'blocked' cannot. Bounded: it reads the index and a few children
 * rather than the whole tree, which for a large retailer is millions of URLs.
 */
export async function surveySitemaps(
  origin: string,
  userAgent: string,
  options: { maxChildren?: number; sampleSize?: number } = {},
): Promise<SitemapSurvey> {
  const maxChildren = options.maxChildren ?? 3;
  const sampleSize = options.sampleSize ?? 10;

  const survey: SitemapSurvey = {
    origin,
    declared: [],
    fetched: [],
    sampleUrls: [],
    totalUrls: 0,
    error: null,
  };

  try {
    const inspection = await inspectRobots(origin, userAgent, []);
    survey.declared = inspection.sitemaps.length
      ? inspection.sitemaps
      : // Nothing declared: the conventional location is still worth one try.
        [`${origin}/sitemap.xml`];

    if (inspection.status === 'unreachable') {
      survey.error =
        `robots.txt could not be read (${inspection.failureDetail ?? 'unknown'}), ` +
        'so no sitemap can be used without checking permission first';
      return survey;
    }

    const queue = [...survey.declared];
    const seen = new Set<string>();
    const collected: string[] = [];
    let childrenFollowed = 0;

    while (queue.length > 0) {
      const url = queue.shift()!;
      if (seen.has(url)) continue;
      seen.add(url);

      // A declared sitemap is still subject to robots.txt.
      const decision = await checkRobots(url, userAgent);
      if (!decision.allowed) {
        survey.fetched.push({
          url,
          ok: false,
          error: decision.reason,
          isIndex: false,
          urlCount: 0,
          childSitemaps: [],
        });
        continue;
      }

      try {
        const body = await fetchSitemapBody(url, userAgent);
        const { isIndex, urls, children } = parseSitemapXml(body);

        survey.fetched.push({
          url,
          ok: true,
          error: null,
          isIndex,
          urlCount: urls.length,
          childSitemaps: children.slice(0, 50),
        });

        survey.totalUrls += urls.length;
        for (const entry of urls) {
          if (collected.length < sampleSize) collected.push(entry.loc);
        }

        for (const child of children) {
          if (childrenFollowed >= maxChildren) break;
          childrenFollowed += 1;
          queue.push(child);
        }
      } catch (err) {
        const message = (err as Error).message;
        logger.warn('sitemap', `${url}: ${message}`);
        survey.fetched.push({
          url,
          ok: false,
          error: message,
          isIndex: false,
          urlCount: 0,
          childSitemaps: [],
        });
      }
    }

    survey.sampleUrls = collected;
  } catch (err) {
    survey.error = (err as Error).message;
  }

  return survey;
}
