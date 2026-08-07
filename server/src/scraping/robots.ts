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
      const entry: CachedRobots = { robots: null, fetchedAt: Date.now(), unavailable: false };
      cache.set(origin, entry);
      return entry;
    }
    if (!response.ok) {
      const entry: CachedRobots = { robots: null, fetchedAt: Date.now(), unavailable: true };
      cache.set(origin, entry);
      return entry;
    }

    const body = await response.text();
    const entry: CachedRobots = {
      robots: robotsParser(robotsUrl, body),
      fetchedAt: Date.now(),
      unavailable: false,
    };
    cache.set(origin, entry);
    return entry;
  } catch (err) {
    logger.warn('robots', `could not fetch ${robotsUrl}: ${(err as Error).message}`);
    const entry: CachedRobots = { robots: null, fetchedAt: Date.now(), unavailable: true };
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

  const { robots, unavailable } = await loadRobots(origin, userAgent);

  if (unavailable) {
    return {
      allowed: false,
      reason: `robots.txt for ${origin} could not be retrieved — skipping rather than assuming permission`,
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
