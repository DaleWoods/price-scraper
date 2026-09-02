import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import type { BlockDiagnosis } from './blockDiagnosis.js';
import { ScrapeError } from './errors.js';
import type { FetchedPage } from './fetcher.js';

/**
 * An optional paid backend for competitors that refuse us directly.
 *
 * The app works without one and that is the default: unset the provider and
 * every request goes out from this host, free, exactly as before. What this
 * module adds is a third rung on the ladder — plain HTTP, then a real browser,
 * then, only for a competitor that has actually blocked us, a commercial
 * unblocking service.
 *
 * Two things keep this from becoming an open invoice.
 *
 * It is only ever reached from a *block*, never from a slow page or a bad
 * selector, and not even from every block: the diagnosis decides. Retrying a
 * rate limit through a paid backend is paying to avoid slowing down, and
 * retrying a legal block or a login wall pays for a request that cannot
 * succeed. Both are refused here rather than left to a caller to remember.
 *
 * And a run may make at most `UNBLOCKER_MAX_CALLS_PER_RUN` paid calls. Past
 * that the run carries on unblocked rather than failing, because a partial
 * scan is worth more than a stopped one and far more than a surprise bill.
 */

export type UnblockerProvider = 'zyte' | 'brightdata' | 'scrapingbee' | 'scraperapi';

export function isUnblockerConfigured(): boolean {
  return env.unblockerProvider !== null && env.unblockerApiKey !== null;
}

/** For Admin, so "we have no unblocker" is visible rather than inferred. */
export function unblockerStatus(): {
  configured: boolean;
  provider: string | null;
  maxCallsPerRun: number;
} {
  return {
    configured: isUnblockerConfigured(),
    provider: isUnblockerConfigured() ? env.unblockerProvider : null,
    maxCallsPerRun: env.unblockerMaxCallsPerRun,
  };
}

/**
 * Whether paying for this particular refusal could plausibly work.
 *
 * `vendorWouldHelp` is set by the diagnosis: true for the walls a commercial
 * backend exists to get past, false for the ones where the answer is ours
 * (slow down, identify ourselves) or where no backend helps at all (a legal
 * block, a login). Spending on the second group is pure waste, so the decision
 * lives with the diagnosis rather than being restated at each call site.
 */
export function isWorthUnblocking(diagnosis: BlockDiagnosis | undefined): boolean {
  return diagnosis?.vendorWouldHelp === true;
}

/**
 * Per-run budget.
 *
 * Deliberately per-run rather than global: a run is the unit a person starts
 * and watches, so a ceiling they can reason about belongs there. Counting
 * across runs would make the limit depend on history nobody can see.
 */
export class UnblockerBudget {
  private used = 0;

  constructor(private readonly max: number = env.unblockerMaxCallsPerRun) {}

  get spent(): number {
    return this.used;
  }

  get exhausted(): boolean {
    return this.used >= this.max;
  }

  /** Claim one call. False means the ceiling is reached and we go without. */
  take(): boolean {
    if (this.exhausted) return false;
    this.used += 1;
    return true;
  }
}

export interface ProviderRequest {
  url: string;
  init: RequestInit;
  /** Providers differ on whether the body is the page or a JSON envelope. */
  readBody: (response: Response) => Promise<string>;
}

const asText = (response: Response): Promise<string> => response.text();

/**
 * Build the call for one provider.
 *
 * Each has its own shape and they are not interchangeable, which is precisely
 * why this is one function rather than scattered through the fetcher: swapping
 * provider should be an env change, and a provider that turns out not to work
 * should be removable without touching anything that scrapes.
 *
 * Exported so the request shapes can be tested without a subscription. A wrong
 * auth header or a mis-encoded target URL is the kind of mistake that only
 * shows up once you are being billed for the failures.
 */
export function buildRequest(
  provider: UnblockerProvider,
  apiKey: string,
  url: string,
  userAgent: string,
): ProviderRequest {
  switch (provider) {
    case 'scrapingbee':
      return {
        url:
          'https://app.scrapingbee.com/api/v1/?' +
          new URLSearchParams({
            api_key: apiKey,
            url,
            // The browser rung has already run by the time we get here, so
            // asking for rendering again would pay the premium twice.
            render_js: 'false',
            country_code: 'gb',
          }).toString(),
        init: { method: 'GET' },
        readBody: asText,
      };

    case 'scraperapi':
      return {
        url:
          'https://api.scraperapi.com/?' +
          new URLSearchParams({ api_key: apiKey, url, render: 'false', country_code: 'uk' }).toString(),
        init: { method: 'GET' },
        readBody: asText,
      };

    case 'zyte':
      return {
        url: 'https://api.zyte.com/v1/extract',
        init: {
          method: 'POST',
          headers: {
            // Zyte takes the API key as the Basic-auth username, no password.
            authorization: `Basic ${Buffer.from(`${apiKey}:`).toString('base64')}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ url, httpResponseBody: true, geolocation: 'GB' }),
        },
        readBody: async (response) => {
          const payload = (await response.json()) as { httpResponseBody?: string };
          if (!payload.httpResponseBody) return '';
          // Zyte returns the body base64-encoded rather than inline.
          return Buffer.from(payload.httpResponseBody, 'base64').toString('utf8');
        },
      };

    case 'brightdata':
      return {
        url: 'https://api.brightdata.com/request',
        init: {
          method: 'POST',
          headers: {
            authorization: `Bearer ${apiKey}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            zone: env.unblockerZone ?? 'web_unlocker',
            url,
            format: 'raw',
            country: 'gb',
            headers: { 'user-agent': userAgent },
          }),
        },
        readBody: asText,
      };
  }
}

/**
 * Fetch one page through the configured unblocking provider.
 *
 * Throws rather than returning null on failure: a paid attempt that also
 * failed is worth surfacing as its own error, not folding back into the
 * original block, or nobody ever finds out the subscription is not working.
 */
export async function fetchViaUnblocker(url: string, userAgent: string): Promise<FetchedPage> {
  const provider = env.unblockerProvider;
  const apiKey = env.unblockerApiKey;
  if (!provider || !apiKey) {
    throw new ScrapeError('unknown', 'No unblocking provider is configured', { url });
  }

  const request = buildRequest(provider, apiKey, url, userAgent);

  let response: Response;
  try {
    response = await fetch(request.url, {
      ...request.init,
      signal: AbortSignal.timeout(env.requestTimeoutMs * 2),
    });
  } catch (err) {
    const message = (err as Error).message;
    const kind = /timeout|abort/i.test(message) ? 'timeout' : 'navigation_failed';
    throw new ScrapeError(kind, `${provider} could not fetch ${url}: ${message}`, {
      url,
      cause: err,
    });
  }

  if (!response.ok) {
    // The provider's own failure, not the retailer's — say so, because the
    // remedy is a billing or configuration question rather than a scraping one.
    const detail = await response.text().catch(() => '');
    throw new ScrapeError(
      'blocked',
      `${provider} returned HTTP ${response.status} for ${url}. ` +
        `This is the unblocking service failing, not the retailer` +
        `${detail ? `: ${detail.slice(0, 200)}` : ''}`,
      { url, retryable: false },
    );
  }

  const html = await request.readBody(response);
  if (!html) {
    throw new ScrapeError('blocked', `${provider} returned an empty body for ${url}`, {
      url,
      retryable: false,
    });
  }

  logger.info('unblocker', `${provider} fetched ${url} (${html.length} bytes)`);

  return {
    url,
    finalUrl: url,
    html,
    status: 200,
    renderedWith: 'unblocker',
  };
}
