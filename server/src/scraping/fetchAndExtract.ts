import type { Competitor } from '../domain/types.js';
import { logger } from '../lib/logger.js';
import { describeBlock, diagnoseBlock } from './blockDiagnosis.js';
import { ScrapeError, type ScrapeErrorKind } from './errors.js';
import { extractListing, type ExtractedListing } from './extract.js';
import { fetchPage, type FetchPageOptions, type FetchedPage } from './fetcher.js';

/**
 * Fetching and extracting live in separate modules — extract.ts imports
 * FetchedPage from fetcher.ts, so pairing them anywhere but here would make
 * that a cycle. This module is the one place that knows about both.
 */

/**
 * The only two extraction failures that mean "we fetched the wrong shape of
 * HTML, and a real browser might do better".
 *
 * Everything else is a decision the site made, not a rendering problem:
 * 'blocked' (403/429) and 'robots_disallowed' are a refusal we honour rather
 * than work around (Spec §9), 'not_found' means the listing is genuinely gone,
 * and a timeout re-tried through Chromium just costs twice as much to fail.
 */
const ESCALATABLE: ReadonlySet<ScrapeErrorKind> = new Set<ScrapeErrorKind>([
  'layout_changed',
  'no_price_found',
]);

export interface FetchAndExtractResult {
  page: FetchedPage;
  listing: ExtractedListing;
  /** True when the HTTP attempt was unusable and Playwright was needed after all. */
  escalated: boolean;
}

/** A copy of the competitor with one rendering mode forced, leaving the original untouched. */
function withRendering(competitor: Competitor, rendering: 'http' | 'browser'): Competitor {
  // Deliberately a copy: the same Competitor object is shared across every
  // product for that competitor, and up to three competitors run concurrently,
  // so mutating config.rendering here would race and corrupt the config for
  // work already in flight.
  return { ...competitor, config: { ...competitor.config, rendering } };
}

/**
 * Fetch a competitor page and read a listing off it, using a plain HTTP request
 * where that works and a real browser only where it does not.
 *
 * Chromium is by far the most expensive thing this app does — it was the
 * dominant cost behind a compute-quota outage — and most retail product pages
 * publish their price in server-rendered JSON-LD that a plain fetch can read
 * perfectly well. Spec §5.4 asks for exactly this: HTTP where a site allows it,
 * "fall back to a full headless browser only where JS rendering is needed".
 */
export async function fetchAndExtract(
  competitor: Competitor,
  url: string,
  options: FetchPageOptions = {},
): Promise<FetchAndExtractResult> {
  const mode = competitor.config.rendering ?? 'auto';

  // An explicit choice is honoured as-is — 'auto' is a default, not a policy.
  if (mode !== 'auto') {
    const page = await fetchPage(competitor, url, options);
    return { page, listing: extractListing(competitor, page), escalated: false };
  }

  try {
    const page = await fetchPage(withRendering(competitor, 'http'), url, options);
    return { page, listing: extractListing(competitor, page), escalated: false };
  } catch (err) {
    const kind = err instanceof ScrapeError ? err.kind : 'unknown';
    if (!ESCALATABLE.has(kind as ScrapeErrorKind)) throw err;

    logger.info(
      'fetch',
      `[${competitor.slug}] plain HTTP fetch of ${url} was not extractable (${kind}); escalating to a browser`,
    );
  }

  const page = await fetchPage(withRendering(competitor, 'browser'), url, options);
  try {
    return { page, listing: extractListing(competitor, page), escalated: true };
  } catch (err) {
    // Last chance to catch a soft block. Both transports have now failed to
    // find a price on a page that returned 200 both times, which is the exact
    // signature of an interstitial: a challenge page is valid HTML and a
    // perfectly healthy status, so every layer above reads it as a layout
    // change and someone spends an afternoon on selectors that were never
    // wrong. Only re-labelled when the page actually carries challenge
    // markers — a genuine redesign must stay a layout change.
    if (err instanceof ScrapeError && ESCALATABLE.has(err.kind)) {
      const diagnosis = diagnoseBlock({
        status: page.status,
        html: page.html,
        extractionFailed: true,
      });
      if (diagnosis.cause === 'soft_block') {
        throw new ScrapeError('blocked', `${url}: ${describeBlock(diagnosis)}`, {
          url,
          retryable: false,
          diagnosis,
        });
      }
    }
    throw err;
  }
}
