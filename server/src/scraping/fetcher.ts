import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import type { Competitor } from '../domain/types.js';
import { getBrowser } from './browser.js';
import { describeBlock, diagnoseBlock } from './blockDiagnosis.js';
import { ScrapeError, isBlockingStatus } from './errors.js';
import { withRateLimit } from './rateLimiter.js';
import { checkRobots } from './robots.js';

export interface FetchedPage {
  url: string;
  /** Final URL after redirects — used to spot redirects to a search/404 page. */
  finalUrl: string;
  html: string;
  status: number;
  renderedWith: 'http' | 'browser';
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * A current desktop Chrome string, used only by the browser path and only when
 * a competitor is explicitly set to `identity: 'browser'`.
 *
 * This is not a disguise: on that path the fetch really is Chromium, driven by
 * Playwright, at the same request rate as before. What it stops announcing is
 * that a person is not the one clicking. Some retail edge rules reject any
 * non-browser user agent outright, which is why the option exists — but the
 * default stays the honest self-identifying string, because a named crawler
 * with a real contact address is the version a retailer can whitelist, and
 * being whitelisted beats being tolerated.
 */
const BROWSER_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/140.0.0.0 Safari/537.36';

function userAgentFor(competitor: Competitor, transport: 'http' | 'browser'): string {
  if (competitor.config.userAgent) return competitor.config.userAgent;
  if (competitor.config.identity === 'browser' && transport === 'browser') {
    return BROWSER_USER_AGENT;
  }
  return env.scraperUserAgent;
}

export interface FetchPageOptions {
  /**
   * Override the competitor's configured retry count for this call only.
   *
   * Discovery uses this to fetch an unproven candidate URL once rather than
   * the competitor's usual attempts — retrying a guess that might not even be
   * the right product wastes minutes better spent on the next candidate, and
   * three candidates each retrying three times at the full timeout can hold
   * up a whole competitor for the better part of ten minutes.
   */
  maxAttempts?: number;
}

/**
 * Fetch a page for a competitor, honouring robots.txt, per-domain rate limits and
 * retry-with-backoff. Uses a plain HTTP fetch where the competitor's config allows
 * it and falls back to Playwright only where JS rendering is needed (Spec §5.4).
 */
export async function fetchPage(
  competitor: Competitor,
  url: string,
  options: FetchPageOptions = {},
): Promise<FetchedPage> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ScrapeError('invalid_url', `Not a valid URL: ${url}`, { url });
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new ScrapeError('invalid_url', `Unsupported protocol ${parsed.protocol}`, { url });
  }

  // robots.txt is always evaluated against our own identity, never a browser
  // string. A rule written for us must still apply when we happen to be
  // driving Chromium — choosing the identity that gets past a Disallow would
  // be exactly the circumvention this app does not do.
  const decision = await checkRobots(url, env.scraperUserAgent);
  if (!decision.allowed) {
    throw new ScrapeError('robots_disallowed', decision.reason, { url, retryable: false });
  }

  const rateLimit = {
    ...competitor.config.rateLimit,
    // A site-declared Crawl-delay always wins if it's longer than ours.
    minDelayMs: Math.max(competitor.config.rateLimit?.minDelayMs ?? 0, decision.crawlDelayMs ?? 0),
  };

  const attempts = Math.max(1, options.maxAttempts ?? competitor.config.retry?.attempts ?? 3);
  const backoffMs = competitor.config.retry?.backoffMs ?? 2000;

  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await withRateLimit(url, rateLimit, () =>
        // 'auto' resolves to the browser here, deliberately. Only the caller
        // that also extracts can tell whether a cheap HTTP response was
        // actually usable, so 'auto' is resolved in fetchAndExtract.ts; a bare
        // fetchPage has no such signal and takes the option that always works.
        competitor.config.rendering === 'http'
          ? httpFetch(url, userAgentFor(competitor, 'http'))
          : browserFetch(url, userAgentFor(competitor, 'browser')),
      );
    } catch (err) {
      lastError = err;
      const retryable = err instanceof ScrapeError ? err.retryable : true;
      if (!retryable || attempt === attempts) break;

      const delay = backoffMs * 2 ** (attempt - 1);
      logger.warn(
        'fetch',
        `attempt ${attempt}/${attempts} failed for ${url} (${(err as Error).message}); retrying in ${delay}ms`,
      );
      await sleep(delay);
    }
  }

  throw lastError instanceof ScrapeError
    ? lastError
    : new ScrapeError('unknown', `Fetch failed for ${url}: ${(lastError as Error)?.message}`, {
        url,
        cause: lastError,
      });
}

async function httpFetch(url: string, userAgent: string): Promise<FetchedPage> {
  let response: Response;
  try {
    response = await fetch(url, {
      headers: {
        'user-agent': userAgent,
        accept: 'text/html,application/xhtml+xml',
        'accept-language': 'en-GB,en;q=0.9',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(env.requestTimeoutMs),
    });
  } catch (err) {
    const message = (err as Error).message;
    const kind = /timeout|abort/i.test(message) ? 'timeout' : 'navigation_failed';
    throw new ScrapeError(kind, `HTTP fetch failed for ${url}: ${message}`, { url, cause: err });
  }

  if (response.status >= 400) {
    // Read the body before throwing. A refusal usually says who refused us and
    // why — a Cloudflare ray id, a Retry-After, an "enable JavaScript" page —
    // and discarding it leaves every failure looking identically like
    // "blocked", which is the least useful thing we could record.
    const body = await response.text().catch(() => '');
    assertUsableStatus(response.status, url, { headers: response.headers, html: body });
  }

  return {
    url,
    finalUrl: response.url || url,
    html: await response.text(),
    status: response.status,
    renderedWith: 'http',
  };
}

async function browserFetch(url: string, userAgent: string): Promise<FetchedPage> {
  const browser = await getBrowser();
  const context = await browser.newContext({
    userAgent,
    locale: 'en-GB',
    viewport: { width: 1440, height: 900 },
    extraHTTPHeaders: { 'accept-language': 'en-GB,en;q=0.9' },
  });

  // Chromium reports some error statuses as a navigation failure rather than a
  // response, so the main-frame status is recorded as it arrives. Without this a
  // 404 on a previously-matched listing would be misreported as a network fault,
  // losing a signal the team needs (Spec §5.5).
  let mainFrameStatus: number | null = null;
  // Kept alongside the status so a block can still be classified from the
  // catch branch, where the response object is long out of scope.
  let mainFrameHeaders: Record<string, string> | null = null;
  let pageRef: import('playwright').Page | null = null;

  try {
    const page = await context.newPage();
    pageRef = page;
    page.setDefaultTimeout(env.requestTimeoutMs);

    page.on('response', (response) => {
      if (response.url() === url || response.frame() === page.mainFrame()) {
        if (mainFrameStatus === null) {
          mainFrameStatus = response.status();
          mainFrameHeaders = response.headers();
        }
      }
    });

    // Images and fonts add nothing to price extraction and cost the competitor
    // bandwidth — decline them (Spec §9: don't degrade their site).
    await page.route('**/*', (route) => {
      const type = route.request().resourceType();
      if (type === 'image' || type === 'font' || type === 'media') return route.abort();
      return route.continue();
    });

    const response = await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: env.requestTimeoutMs,
    });
    if (!response) {
      throw new ScrapeError('navigation_failed', `No response navigating to ${url}`, { url });
    }
    if (response.status() >= 400) {
      assertUsableStatus(response.status(), url, {
        headers: response.headers(),
        html: await page.content().catch(() => ''),
      });
    }

    // Prices are frequently injected after hydration; settling the network is
    // best-effort and a timeout here is not itself a failure.
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => undefined);

    return {
      url,
      finalUrl: page.url(),
      html: await page.content(),
      status: response.status(),
      renderedWith: 'browser',
    };
  } catch (err) {
    if (err instanceof ScrapeError) throw err;

    // Prefer the observed HTTP status over the generic navigation error, so a
    // 404 or an active block is reported as what it actually is.
    if (mainFrameStatus !== null) {
      assertUsableStatus(mainFrameStatus, url, {
        headers: mainFrameHeaders,
        html: pageRef ? await pageRef.content().catch(() => '') : '',
      });
    }

    const message = (err as Error).message;
    const kind = /timeout/i.test(message) ? 'timeout' : 'navigation_failed';
    throw new ScrapeError(kind, `Browser fetch failed for ${url}: ${message}`, { url, cause: err });
  } finally {
    await context.close().catch(() => undefined);
  }
}

/** What the response told us about itself, when we managed to read it. */
interface ResponseEvidence {
  headers?: Headers | Record<string, string> | null;
  html?: string;
}

function assertUsableStatus(status: number, url: string, evidence: ResponseEvidence = {}): void {
  if (status === 404 || status === 410) {
    // A previously-matched listing that 404s is a real signal, not noise (Spec §5.5).
    throw new ScrapeError('not_found', `Listing no longer exists (HTTP ${status}): ${url}`, {
      url,
      retryable: false,
    });
  }
  if (isBlockingStatus(status)) {
    const diagnosis = diagnoseBlock({
      status,
      headers: evidence.headers ?? null,
      html: evidence.html ?? '',
    });
    throw new ScrapeError('blocked', `${url}: ${describeBlock(diagnosis)}`, {
      url,
      retryable: false,
      diagnosis,
    });
  }
  if (status >= 400) {
    throw new ScrapeError('http_error', `HTTP ${status} for ${url}`, { url });
  }
}
