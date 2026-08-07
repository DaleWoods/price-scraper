import { query } from '../db/pool.js';
import type { Competitor, MatchTier, Product } from '../domain/types.js';
import { logger } from '../lib/logger.js';
import { buildSearchUrl } from '../scraping/competitorRegistry.js';
import { ScrapeError } from '../scraping/errors.js';
import { extractListing, extractSearchResults } from '../scraping/extract.js';
import { fetchPage } from '../scraping/fetcher.js';
import { canonicalAttributeName } from './attributes.js';
import { AUTO_ACCEPT_THRESHOLD, MIN_CANDIDATE_THRESHOLD, scoreCandidate, type CandidateListing } from './score.js';

export interface DiscoveryOutcome {
  productId: number;
  internalSku: string;
  candidatesFound: number;
  candidatesStored: number;
  autoConfirmed: number;
  error?: { kind: string; message: string };
}

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

  const searchTerm = buildSearchTerm(product);
  const searchUrl = buildSearchUrl(competitor, searchTerm);

  let results: ReturnType<typeof extractSearchResults>;
  try {
    const page = await fetchPage(competitor, searchUrl);
    results = extractSearchResults(competitor, page);
  } catch (err) {
    const kind = err instanceof ScrapeError ? err.kind : 'unknown';
    outcome.error = { kind, message: (err as Error).message };
    return outcome;
  }

  outcome.candidatesFound = results.length;
  if (results.length === 0) {
    outcome.error = {
      kind: 'layout_changed',
      message:
        `Search for "${searchTerm}" on ${competitor.display_name} returned no parseable results. ` +
        'Either there is genuinely no match, or the search-result selectors need review.',
    };
    return outcome;
  }

  // Cheap pass first: score on the search-result title alone, then only open the
  // product pages of candidates that already look plausible. This keeps request
  // volume against the competitor low (Spec §9).
  const prescored = results
    .map((result) => ({
      result,
      preliminary: scoreCandidate(product, { url: result.url, title: result.title, price: result.price }),
    }))
    .filter((entry) => entry.preliminary.viable)
    .sort((a, b) => b.preliminary.confidence - a.preliminary.confidence)
    .slice(0, 3);

  for (const { result, preliminary } of prescored) {
    let listing: CandidateListing = {
      url: result.url,
      title: result.title,
      price: result.price,
    };
    let scored = preliminary;

    // Open the product page for structured attributes and the EAN, which is what
    // lifts a candidate from a fuzzy name guess to a confident match.
    try {
      const page = await fetchPage(competitor, result.url);
      const extracted = extractListing(competitor, page);
      listing = {
        url: page.finalUrl,
        title: extracted.title ?? result.title,
        ean: extracted.ean,
        brand: extracted.brand,
        attributes: extracted.attributes,
        price: extracted.price,
      };
      scored = scoreCandidate(product, listing);
    } catch (err) {
      logger.warn(
        'discovery',
        `could not open candidate ${result.url}: ${(err as Error).message} — scoring on search-result data only`,
      );
    }

    if (!scored.viable || scored.confidence < MIN_CANDIDATE_THRESHOLD) continue;

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
