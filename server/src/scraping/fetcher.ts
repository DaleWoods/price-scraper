import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import type { Competitor } from '../domain/types.js';
import { getBrowser } from './browser.js';
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

function userAgentFor(competitor: Competitor): string {
  return competitor.config.userAgent ?? env.scraperUserAgent;
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

  const userAgent = userAgentFor(competitor);
  const decision = await checkRobots(url, userAgent);
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
        competitor.config.rendering === 'http'
          ? httpFetch(url, userAgent)
          : browserFetch(url, userAgent),
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

  assertUsableStatus(response.status, url);
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

  try {
    const page = await context.newPage();
    page.setDefaultTimeout(env.requestTimeoutMs);

    page.on('response', (response) => {
      if (response.url() === url || response.frame() === page.mainFrame()) {
        if (mainFrameStatus === null) mainFrameStatus = response.status();
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
    assertUsableStatus(response.status(), url);

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
    if (mainFrameStatus !== null) assertUsableStatus(mainFrameStatus, url);

    const message = (err as Error).message;
    const kind = /timeout/i.test(message) ? 'timeout' : 'navigation_failed';
    throw new ScrapeError(kind, `Browser fetch failed for ${url}: ${message}`, { url, cause: err });
  } finally {
    await context.close().catch(() => undefined);
  }
}

function assertUsableStatus(status: number, url: string): void {
  if (status === 404 || status === 410) {
    // A previously-matched listing that 404s is a real signal, not noise (Spec §5.5).
    throw new ScrapeError('not_found', `Listing no longer exists (HTTP ${status}): ${url}`, {
      url,
      retryable: false,
    });
  }
  if (isBlockingStatus(status)) {
    throw new ScrapeError(
      'blocked',
      `Site returned HTTP ${status} for ${url}. Treating as an active block — not retrying and not working around it.`,
      { url, retryable: false },
    );
  }
  if (status >= 400) {
    throw new ScrapeError('http_error', `HTTP ${status} for ${url}`, { url });
  }
}
