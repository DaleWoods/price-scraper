import { query } from '../db/pool.js';
import type { Competitor, MatchTier, Product } from '../domain/types.js';
import { logger } from '../lib/logger.js';
import { buildSearchUrl } from '../scraping/competitorRegistry.js';
import { ScrapeError } from '../scraping/errors.js';
import { extractSearchResults } from '../scraping/extract.js';
import { fetchAndExtract } from '../scraping/fetchAndExtract.js';
import { fetchPage } from '../scraping/fetcher.js';
import { canonicalAttributeName } from './attributes.js';
import { findCandidateUrls } from './sitemapDiscovery.js';
import { AUTO_ACCEPT_THRESHOLD, MIN_CANDIDATE_THRESHOLD, scoreCandidate, type CandidateListing } from './score.js';

export interface DiscoveryOutcome {
  productId: number;
  internalSku: string;
  candidatesFound: number;
  candidatesStored: number;
  autoConfirmed: number;
  /**
   * Set when at least one candidate page was opened and scored but nothing
   * cleared the bar to be stored. Without this, a competitor that genuinely
   * lists the product but fails a gate (wrong or absent brand, differing EAN)
   * looks identical in a run's output to one that was never found at all.
   */
  bestAttempt?: { url: string; confidence: number; reason: string } | null;
  /**
   * `blockCause` is carried alongside the kind because 'blocked' on its own
   * cannot be acted on — see blockDiagnosis.ts for the four walls it hides.
   */
  error?: { kind: string; message: string; blockCause?: string | null };
}

/** Turn a rejected score into a sentence a person can act on. */
export function rejectionReason(scored: ReturnType<typeof scoreCandidate>): string {
  const failedGate = scored.evidence.gatesFailed?.[0];
  if (failedGate === 'brand') {
    return "the listing does not identify the brand as ours, so the brand gate rejected it outright";
  }
  if (failedGate === 'ean_mpn') {
    // scoreCandidate records the two values as a note before it rejects, which
    // reads better than the generic gate sentence below.
    return (
      scored.evidence.notes?.find((note) => note.includes('differs from ours')) ??
      'the competitor publishes a different EAN/MPN to ours, which is an outright rejection'
    );
  }
  if (failedGate) {
    return `its ${failedGate.replace(/_/g, ' ')} does not agree with ours, which is a gate attribute`;
  }
  return `it scored ${scored.confidence}% confidence, below the ${MIN_CANDIDATE_THRESHOLD}% needed to store it`;
}

/**
 * Ceiling on how long discovery spends opening candidates for one competitor.
 * Exported for the test that proves a slow candidate stops the loop rather
 * than running unbounded.
 */
export const DISCOVERY_BUDGET_MS = 60_000;

/**
 * The term we hand to the competitor's on-site search. A manufacturer reference
 * is the strongest query when we hold one; otherwise brand + product name.
 */
export function buildSearchTerm(product: Product): string {
  const specs = Object.fromEntries(
    Object.entries(product.specs ?? {}).map(([key, value]) => [canonicalAttributeName(key), value]),
  );
  const reference = specs.reference_number?.trim();
  if (reference) return `${product.brand} ${reference}`.trim();
  return `${product.brand} ${product.product_name}`.trim();
}

/**
 * Search a competitor for one of our products, score every candidate listing,
 * and persist the viable ones.
 *
 * Anything at or above the auto-accept threshold is confirmed automatically;
 * everything else lands in the manual review queue (Spec §5.3).
 */
export async function discoverMatchesForProduct(
  product: Product,
  competitor: Competitor,
  options: { runId?: number | null } = {},
): Promise<DiscoveryOutcome> {
  const outcome: DiscoveryOutcome = {
    productId: product.id,
    internalSku: product.internal_sku,
    candidatesFound: 0,
    candidatesStored: 0,
    autoConfirmed: 0,
  };

  // Sitemap is the default because every competitor disallows /search; the
  // search path stays for any site that permits it.
  const mode = competitor.config?.discovery ?? 'sitemap';

  // Title is empty for a sitemap candidate: the sitemap gives a URL and nothing
  // else. Such a candidate is only ever kept if its page opens and supplies one.
  let results: { url: string; title: string; price: number | null }[];

  if (mode === 'sitemap') {
    const candidates = await findCandidateUrls(product, competitor);
    outcome.candidatesFound = candidates.length;

    if (candidates.length === 0) {
      outcome.error = {
        kind: 'not_found',
        message:
          `No cached ${competitor.display_name} URL resembles ${product.internal_sku}. ` +
          'Either they do not list it, or their sitemap has not been harvested yet.',
      };
      return outcome;
    }
    // A sitemap gives a URL and nothing else, so there is no title to pre-score
    // on — the product page itself supplies everything.
    results = candidates.map((candidate) => ({ url: candidate.url, title: '', price: null }));
  } else {
    const searchTerm = buildSearchTerm(product);
    const searchUrl = buildSearchUrl(competitor, searchTerm);

    let searchResults: ReturnType<typeof extractSearchResults>;
    try {
      const page = await fetchPage(competitor, searchUrl);
      searchResults = extractSearchResults(competitor, page);
    } catch (err) {
      const kind = err instanceof ScrapeError ? err.kind : 'unknown';
      outcome.error = {
        kind,
        message: (err as Error).message,
        blockCause: err instanceof ScrapeError ? (err.diagnosis?.cause ?? null) : null,
      };
      return outcome;
    }

    outcome.candidatesFound = searchResults.length;
    if (searchResults.length === 0) {
      outcome.error = {
        kind: 'layout_changed',
        message:
          `Search for "${searchTerm}" on ${competitor.display_name} returned no parseable results. ` +
          'Either there is genuinely no match, or the search-result selectors need review.',
      };
      return outcome;
    }
    results = searchResults.map((entry) => ({
      url: entry.url,
      title: entry.title ?? '',
      price: entry.price ?? null,
    }));
  }

  // Cheap pass first: score on the search-result title alone, then only open the
  // product pages of candidates that already look plausible. This keeps request
  // volume against the competitor low (Spec §9).
  const prescored = results
    .map((result) => ({
      result,
      preliminary: scoreCandidate(product, { url: result.url, title: result.title, price: result.price }),
    }))
    // Sitemap candidates carry no title, so pre-scoring cannot judge them and
    // they must be opened to be assessed at all. Search results can be filtered
    // cheaply first, which keeps request volume down.
    .filter((entry) => mode === 'sitemap' || entry.preliminary.viable)
    .sort((a, b) => b.preliminary.confidence - a.preliminary.confidence)
    .slice(0, 3);

  let bestAttempt: { url: string; confidence: number; reason: string } | null = null;
  const budgetStart = Date.now();

  for (const { result, preliminary } of prescored) {
    // A candidate is a guess, not yet evidence — retrying it against the
    // competitor's full retry policy (up to 3 attempts at a 30s timeout) burns
    // minutes on a URL that might not even be the right product. One attempt
    // per candidate, and move on to the next guess or report nothing found.
    //
    // The wall-clock cap on top of that is a backstop: three candidates can
    // still add up to a couple of minutes on a genuinely slow site, and one
    // uncooperative competitor must not be able to hold up the whole run —
    // or, on a small deployment, starve the process of enough CPU/time to
    // fail its own health check while Chromium is busy. This only stops the
    // *next* candidate from starting once the budget has passed; a candidate
    // already in flight runs out its own timeout, so the true worst case is
    // the budget plus one more request timeout, not a hard ceiling.
    if (Date.now() - budgetStart > DISCOVERY_BUDGET_MS) {
      logger.warn(
        'discovery',
        `[${competitor.slug}] ${product.internal_sku}: stopped after ${DISCOVERY_BUDGET_MS}ms, ` +
          'skipping remaining candidates for this competitor',
      );
      break;
    }

    let listing: CandidateListing = {
      url: result.url,
      title: result.title,
      price: result.price,
    };
    let opened = false;
    let scored = preliminary;

    // Open the product page for structured attributes and the EAN, which is what
    // lifts a candidate from a fuzzy name guess to a confident match.
    try {
      // maxAttempts: 1 applies to each leg — an unproven candidate is opened
      // once over HTTP and, only if that HTML turns out to be unreadable, once
      // through a browser. Retrying a guess is what made discovery take minutes.
      const { page, listing: extracted } = await fetchAndExtract(competitor, result.url, {
        maxAttempts: 1,
      });
      listing = {
        url: page.finalUrl,
        title: extracted.title ?? result.title,
        ean: extracted.ean,
        brand: extracted.brand,
        attributes: extracted.attributes,
        price: extracted.price,
      };
      scored = scoreCandidate(product, listing);
      opened = true;
    } catch (err) {
      logger.warn(
        'discovery',
        `could not open candidate ${result.url}: ${(err as Error).message} — scoring on search-result data only`,
      );
    }

    // A sitemap candidate that could not be opened has nothing behind it but a
    // URL guess, which is not evidence of a match.
    if (mode === 'sitemap' && !opened) continue;

    if (!scored.viable || scored.confidence < MIN_CANDIDATE_THRESHOLD) {
      // Keep the strongest rejection: this is what a test run needs to answer
      // "it looked like it found the competitor's listing — why nothing then?"
      if (!bestAttempt || scored.confidence > bestAttempt.confidence) {
        bestAttempt = { url: listing.url, confidence: scored.confidence, reason: rejectionReason(scored) };
      }
      continue;
    }

    const autoConfirm = scored.confidence >= AUTO_ACCEPT_THRESHOLD;
    await upsertMatch({
      productId: product.id,
      competitorId: competitor.id,
      url: listing.url,
      title: listing.title,
      ean: listing.ean ?? null,
      confidence: scored.confidence,
      tier: scored.tier,
      evidence: scored.evidence,
      autoConfirm,
    });

    outcome.candidatesStored += 1;
    if (autoConfirm) outcome.autoConfirmed += 1;
  }

  if (outcome.candidatesStored === 0) outcome.bestAttempt = bestAttempt;

  if (options.runId) {
    logger.debug('discovery', `run ${options.runId}: ${product.internal_sku} -> ${outcome.candidatesStored} candidate(s)`);
  }

  return outcome;
}

interface UpsertMatchInput {
  productId: number;
  competitorId: number;
  url: string;
  title: string | null;
  ean: string | null;
  confidence: number;
  tier: MatchTier;
  evidence: unknown;
  autoConfirm: boolean;
}

/**
 * Store or refresh a candidate match.
 *
 * A match a human has already confirmed or rejected is never silently
 * overwritten by a later automated run — the human decision stands.
 */
async function upsertMatch(input: UpsertMatchInput): Promise<void> {
  // Only one confirmed listing per product/competitor is allowed by the schema,
  // so an auto-confirm must stand down if a human already confirmed a different URL.
  let status: 'pending' | 'confirmed' = input.autoConfirm ? 'confirmed' : 'pending';
  if (status === 'confirmed') {
    const { rows } = await query<{ competitor_url: string }>(
      `SELECT competitor_url FROM product_matches
       WHERE product_id = $1 AND competitor_id = $2 AND status = 'confirmed'`,
      [input.productId, input.competitorId],
    );
    const existing = rows[0];
    if (existing && existing.competitor_url !== input.url) status = 'pending';
  }

  await query(
    `INSERT INTO product_matches
       (product_id, competitor_id, competitor_url, competitor_title, competitor_ean,
        confidence, match_tier, status, evidence, confirmed_at, confirmed_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb,
             CASE WHEN $8 = 'confirmed' THEN now() ELSE NULL END,
             CASE WHEN $8 = 'confirmed' THEN 'auto' ELSE NULL END)
     ON CONFLICT (product_id, competitor_id, competitor_url) DO UPDATE SET
       competitor_title = EXCLUDED.competitor_title,
       competitor_ean   = EXCLUDED.competitor_ean,
       confidence       = EXCLUDED.confidence,
       match_tier       = EXCLUDED.match_tier,
       evidence         = EXCLUDED.evidence,
       -- Preserve any human decision; only re-score rows still pending.
       status           = CASE
                            WHEN product_matches.confirmed_by IS NOT NULL
                                 AND product_matches.confirmed_by <> 'auto'
                              THEN product_matches.status
                            WHEN product_matches.status = 'rejected' THEN 'rejected'
                            ELSE EXCLUDED.status
                          END,
       updated_at       = now()`,
    [
      input.productId,
      input.competitorId,
      input.url,
      input.title,
      input.ean,
      input.confidence,
      input.tier,
      status,
      JSON.stringify(input.evidence ?? {}),
    ],
  );
}
