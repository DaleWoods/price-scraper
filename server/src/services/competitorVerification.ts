import type { Competitor } from '../domain/types.js';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { ScrapeError } from '../scraping/errors.js';
import { fetchAndExtract } from '../scraping/fetchAndExtract.js';
import { inspectRobots } from '../scraping/robots.js';
import { surveySitemaps } from '../scraping/sitemap.js';

/**
 * Answer one question about one competitor: can this app actually read prices
 * from them, right now, from wherever it happens to be running?
 *
 * Ten of the eleven competitor configurations were written without network
 * access and have never been checked against a live site, so every claim about
 * them is a guess. This walks the three stages that have to work — are we
 * allowed in, can we find their product pages, can we read a price off one —
 * and reports which stage failed in words a person can act on.
 *
 * It has to be run from somewhere with ordinary internet access. Run from a
 * locked-down environment every competitor reports unreachable, which says
 * nothing about the retailers and everything about the host.
 */

export type Verdict = 'ready' | 'needs_config' | 'blocked' | 'no_sitemap' | 'unreachable';

export interface SampleAttempt {
  url: string;
  /** What we read, so a person can compare it against the page themselves. */
  price: number | null;
  currency: string | null;
  title: string | null;
  error: string | null;
}

export interface CompetitorVerification {
  slug: string;
  displayName: string;
  enabled: boolean;
  verdict: Verdict;
  /** One line saying what happened, in plain English. */
  headline: string;
  /** One line saying what to do about it. */
  whatToDo: string;
  robots: {
    reachable: boolean;
    allowsProductPages: boolean;
    declaredSitemaps: number;
    crawlDelaySeconds: number | null;
    detail: string | null;
  };
  sitemap: { urlsFound: number };
  samples: SampleAttempt[];
  /** Set when we were refused: which kind of wall, and who put it up. */
  blockCause: string | null;
  blockVendor: string | null;
  checkedAt: string;
}

/** How many real product pages to try. */
const SAMPLE_SIZE = 3;

/**
 * Pick the sitemap entries most likely to be product pages.
 *
 * A sitemap lists categories, guides and legal pages alongside products, and
 * testing extraction against a category page proves nothing — it will fail for
 * the honest reason that there is no single price on it. Longer slugs with
 * more words are overwhelmingly the product pages in retail sitemaps.
 */
function pickProductLikeUrls(urls: string[], count: number): string[] {
  const scored = urls
    .map((url) => {
      let path: string;
      try {
        path = new URL(url).pathname;
      } catch {
        return null;
      }
      const words = path.split(/[^a-zA-Z0-9]+/).filter(Boolean);
      // Depth alone is a poor signal; a long final segment is a strong one.
      const lastSegment = path.replace(/\/$/, '').split('/').pop() ?? '';
      return { url, score: words.length + lastSegment.length / 10 };
    })
    .filter((entry): entry is { url: string; score: number } => entry !== null)
    .sort((a, b) => b.score - a.score);

  return scored.slice(0, count).map((entry) => entry.url);
}

function summarise(
  verdict: Verdict,
  context: { priced: number; tried: number; urls: number; vendor: string | null },
): { headline: string; whatToDo: string } {
  switch (verdict) {
    case 'ready':
      return {
        headline: `Working — read a price from ${context.priced} of ${context.tried} real product pages.`,
        whatToDo:
          'Open the sample pages below and check each price matches what the site displays. ' +
          'If they do, this competitor is safe to enable.',
      };
    case 'needs_config':
      return {
        headline: `Reachable, but could not read a price from ${context.tried} product page(s).`,
        whatToDo:
          'Nothing is blocking us — the price selectors in this competitor\'s config file are ' +
          'wrong for their current layout. Open a sample page in Admin\'s "Test a product URL" ' +
          'panel to see what was extracted, and adjust the config. No code change needed.',
      };
    case 'blocked':
      return {
        headline: context.vendor
          ? `Refused us — ${context.vendor} is guarding the site.`
          : 'Refused us.',
        whatToDo:
          'See the reason below: some refusals are ours to fix by slowing down or identifying ' +
          'ourselves properly, and cost nothing. Only a genuine bot gate needs a different ' +
          'approach — a licensed product feed, or a paid unblocking service.',
      };
    case 'no_sitemap':
      return {
        headline: 'Allowed in, but no usable list of their product pages.',
        whatToDo:
          'Every competitor blocks their own search, so we find products through the sitemap ' +
          'they publish for search engines. Without one there is no way in. Check whether they ' +
          'publish a sitemap at all before writing this competitor off.',
      };
    case 'unreachable':
      return {
        headline: 'Could not reach the site at all.',
        whatToDo:
          'If every competitor reports this, the problem is this app\'s own internet access, ' +
          'not the retailers — check that before concluding anything. If it is just this one, ' +
          'their site may be down or the address in the config may be wrong.',
      };
  }
}

export async function verifyCompetitor(competitor: Competitor): Promise<CompetitorVerification> {
  const userAgent = competitor.config.userAgent ?? env.scraperUserAgent;
  const checkedAt = new Date().toISOString();

  const base: CompetitorVerification = {
    slug: competitor.slug,
    displayName: competitor.display_name,
    enabled: competitor.enabled,
    verdict: 'unreachable',
    headline: '',
    whatToDo: '',
    robots: {
      reachable: false,
      allowsProductPages: false,
      declaredSitemaps: 0,
      crawlDelaySeconds: null,
      detail: null,
    },
    sitemap: { urlsFound: 0 },
    samples: [],
    blockCause: null,
    blockVendor: null,
    checkedAt,
  };

  let origin: string;
  try {
    origin = new URL(competitor.base_url).origin;
  } catch {
    return {
      ...base,
      headline: `"${competitor.base_url}" is not a valid web address.`,
      whatToDo: 'Fix baseUrl in this competitor\'s config file.',
    };
  }

  // Stage 1 — are we allowed in? Probing the site root rather than a guessed
  // product path: a made-up URL can be disallowed by a rule that has nothing
  // to say about the real product pages.
  const robots = await inspectRobots(origin, userAgent, [origin + '/']);
  base.robots = {
    reachable: robots.status !== 'unreachable',
    allowsProductPages: robots.probe[0]?.allowed ?? false,
    declaredSitemaps: robots.sitemaps.length,
    crawlDelaySeconds: robots.crawlDelaySeconds,
    detail: robots.failureDetail ?? null,
  };

  if (robots.status === 'unreachable') {
    const summary = summarise('unreachable', { priced: 0, tried: 0, urls: 0, vendor: null });
    return { ...base, verdict: 'unreachable', ...summary };
  }

  if (!base.robots.allowsProductPages) {
    return {
      ...base,
      verdict: 'blocked',
      blockCause: 'robots_disallowed',
      headline: 'Their robots.txt asks automated visitors not to read this site.',
      whatToDo:
        'This is their published wish and we honour it, so this competitor cannot be scraped. ' +
        'A licensed product feed is the only route to their prices.',
    };
  }

  // Stage 2 — can we find their product pages?
  const survey = await surveySitemaps(origin, userAgent, { maxChildren: 2, sampleSize: 40 });
  base.sitemap = { urlsFound: survey.totalUrls };

  if (survey.totalUrls === 0 || survey.sampleUrls.length === 0) {
    const summary = summarise('no_sitemap', { priced: 0, tried: 0, urls: 0, vendor: null });
    return { ...base, verdict: 'no_sitemap', ...summary };
  }

  // Stage 3 — can we read a price off one? This is the only stage that proves
  // anything: the first two can pass on a site whose prices we cannot read.
  const candidates = pickProductLikeUrls(survey.sampleUrls, SAMPLE_SIZE);
  for (const url of candidates) {
    try {
      const { listing } = await fetchAndExtract(competitor, url, { maxAttempts: 1 });
      base.samples.push({
        url,
        price: listing.price ?? null,
        currency: listing.currency ?? null,
        title: listing.title ?? null,
        error: null,
      });
    } catch (err) {
      const scrapeError = err instanceof ScrapeError ? err : null;
      base.samples.push({
        url,
        price: null,
        currency: null,
        title: null,
        error: (err as Error).message,
      });

      // One refusal settles it — the remaining samples would be refused too,
      // and there is no reason to make a site that just said no say it twice.
      if (scrapeError?.kind === 'blocked') {
        base.blockCause = scrapeError.diagnosis?.cause ?? 'unclassified';
        base.blockVendor = scrapeError.diagnosis?.vendor ?? null;
        const summary = summarise('blocked', {
          priced: 0,
          tried: base.samples.length,
          urls: survey.totalUrls,
          vendor: base.blockVendor,
        });
        return { ...base, verdict: 'blocked', ...summary };
      }
    }
  }

  const priced = base.samples.filter((sample) => sample.price != null).length;
  // Two of three, not one: a single simple product with clean structured data
  // can pass by luck on a site where everything else fails.
  const verdict: Verdict = priced >= 2 ? 'ready' : 'needs_config';
  const summary = summarise(verdict, {
    priced,
    tried: base.samples.length,
    urls: survey.totalUrls,
    vendor: null,
  });

  logger.info(
    'verify',
    `[${competitor.slug}] ${verdict}: ${priced}/${base.samples.length} priced, ${survey.totalUrls} sitemap URL(s)`,
  );

  return { ...base, verdict, ...summary };
}
