import robotsParserImport from 'robots-parser';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';

interface RobotsTxt {
  isAllowed(url: string, userAgent?: string): boolean | undefined;
  getCrawlDelay(userAgent?: string): number | undefined;
  getSitemaps(): string[];
}

// robots-parser is CommonJS (`module.exports = fn`) but ships typings that declare
// an ES default export, so the two disagree under NodeNext resolution. Bridge the
// mismatch once here rather than at every call site.
const robotsParser = robotsParserImport as unknown as (url: string, contents: string) => RobotsTxt;

interface CachedRobots {
  robots: RobotsTxt | null;
  fetchedAt: number;
  /** True when robots.txt could not be retrieved at all. */
  unavailable: boolean;
  /** Why it could not be retrieved — an HTTP status, or the network error. */
  failureDetail: string | null;
  /** The raw file, kept so the diagnostic can show the actual rules. */
  body: string | null;
}

const CACHE_TTL_MS = 60 * 60 * 1000;
const cache = new Map<string, CachedRobots>();

async function loadRobots(origin: string, userAgent: string): Promise<CachedRobots> {
  const cached = cache.get(origin);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached;

  const robotsUrl = `${origin}/robots.txt`;
  try {
    const response = await fetch(robotsUrl, {
      headers: { 'user-agent': userAgent, accept: 'text/plain' },
      signal: AbortSignal.timeout(15_000),
    });

    // 404/410 means no robots.txt is published, which permits crawling.
    // 401/403/429 are access denials, NOT an absent file — assuming permission
    // there would be exactly backwards, so they fall through to unavailable.
    if (response.status === 404 || response.status === 410) {
      const entry: CachedRobots = {
        robots: null,
        fetchedAt: Date.now(),
        unavailable: false,
        failureDetail: null,
        body: null,
      };
      cache.set(origin, entry);
      return entry;
    }
    if (!response.ok) {
      const entry: CachedRobots = {
        robots: null,
        fetchedAt: Date.now(),
        unavailable: true,
        // The status distinguishes a site refusing us (403, often bot
        // protection) from one that is merely broken (5xx) — very different
        // signals about whether the source is viable at all.
        failureDetail: `HTTP ${response.status}`,
        body: null,
      };
      cache.set(origin, entry);
      return entry;
    }

    const body = await response.text();
    const entry: CachedRobots = {
      robots: robotsParser(robotsUrl, body),
      fetchedAt: Date.now(),
      unavailable: false,
      failureDetail: null,
      body,
    };
    cache.set(origin, entry);
    return entry;
  } catch (err) {
    const detail = (err as Error).message;
    logger.warn('robots', `could not fetch ${robotsUrl}: ${detail}`);
    const entry: CachedRobots = {
      robots: null,
      fetchedAt: Date.now(),
      unavailable: true,
      failureDetail: detail,
      body: null,
    };
    cache.set(origin, entry);
    return entry;
  }
}

export interface RobotsDecision {
  allowed: boolean;
  reason: string;
  /** Site-declared Crawl-delay in ms, if any — we honour it when longer than ours. */
  crawlDelayMs: number | null;
}

/**
 * Spec §9: respect robots.txt. If robots.txt cannot be read at all we fail
 * closed and skip the URL rather than guessing — a scrape that can't verify
 * permission doesn't run.
 */
export async function checkRobots(url: string, userAgent: string): Promise<RobotsDecision> {
  if (!env.respectRobotsTxt) {
    return { allowed: true, reason: 'robots.txt checking disabled by configuration', crawlDelayMs: null };
  }

  let origin: string;
  try {
    origin = new URL(url).origin;
  } catch {
    return { allowed: false, reason: `Invalid URL: ${url}`, crawlDelayMs: null };
  }

  const { robots, unavailable, failureDetail } = await loadRobots(origin, userAgent);

  if (unavailable) {
    return {
      allowed: false,
      reason:
        `robots.txt for ${origin} could not be retrieved` +
        `${failureDetail ? ` (${failureDetail})` : ''} — skipping rather than assuming permission`,
      crawlDelayMs: null,
    };
  }
  if (!robots) {
    return { allowed: true, reason: 'No robots.txt published', crawlDelayMs: null };
  }

  const allowed = robots.isAllowed(url, userAgent);
  const crawlDelay = robots.getCrawlDelay(userAgent);

  return {
    // isAllowed() returns undefined when it cannot decide; treat that as allowed,
    // since an unparseable rule set is not a disallow.
    allowed: allowed !== false,
    reason: allowed === false ? `Disallowed by ${origin}/robots.txt` : 'Allowed by robots.txt',
    crawlDelayMs: typeof crawlDelay === 'number' ? crawlDelay * 1000 : null,
  };
}

export function clearRobotsCache(): void {
  cache.clear();
}

export interface RobotsInspection {
  origin: string;
  /** 'ok' when rules were read, 'absent' when none is published, 'unreachable' otherwise. */
  status: 'ok' | 'absent' | 'unreachable';
  failureDetail: string | null;
  /** The URL the scraper would actually request, and whether it is permitted. */
  probe: { url: string; allowed: boolean }[];
  crawlDelaySeconds: number | null;
  /**
   * Sitemaps the site declares. These matter: a sitemap is published *for*
   * crawlers, so where search is disallowed it is usually the sanctioned route
   * to the same product URLs.
   */
  sitemaps: string[];
  /** Disallow rules that apply to us, for seeing what is actually restricted. */
  disallowRules: string[];
}

/**
 * Read a site's robots.txt and report what it permits, without scraping
 * anything. Answers "is this source usable at all, and by what route" — which a
 * run that simply reports 'blocked' cannot.
 */
export async function inspectRobots(
  origin: string,
  userAgent: string,
  probeUrls: string[],
): Promise<RobotsInspection> {
  const { robots, unavailable, failureDetail, body } = await loadRobots(origin, userAgent);

  const status: RobotsInspection['status'] = unavailable
    ? 'unreachable'
    : robots
      ? 'ok'
      : 'absent';

  const probe = probeUrls.map((url) => ({
    url,
    // No rules published means nothing is forbidden.
    allowed: unavailable ? false : !robots || robots.isAllowed(url, userAgent) !== false,
  }));

  const crawlDelay = robots?.getCrawlDelay(userAgent);

  return {
    origin,
    status,
    failureDetail,
    probe,
    crawlDelaySeconds: typeof crawlDelay === 'number' ? crawlDelay : null,
    sitemaps: robots?.getSitemaps() ?? [],
    disallowRules: body ? extractDisallowRules(body, userAgent) : [],
  };
}

/**
 * Pull the Disallow paths that apply to us out of the raw file.
 *
 * Read directly rather than via the parser, which exposes decisions but not the
 * rules behind them — and here the point is to show a person what the site
 * actually restricts.
 */
export function extractDisallowRules(body: string, userAgent: string): string[] {
  const agent = userAgent.toLowerCase();
  const rules: string[] = [];
  let applies = false;

  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;

    const [rawKey, ...rest] = line.split(':');
    const key = (rawKey ?? '').trim().toLowerCase();
    const value = rest.join(':').trim();

    if (key === 'user-agent') {
      const target = value.toLowerCase();
      applies = target === '*' || agent.includes(target);
      continue;
    }
    if (applies && key === 'disallow' && value) rules.push(value);
  }

  return [...new Set(rules)];
}
