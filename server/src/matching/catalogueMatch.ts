import { query } from '../db/pool.js';
import type { Competitor, Product, SpecAttributes } from '../domain/types.js';
import { logger } from '../lib/logger.js';
import { recordPriceObservation } from '../scraping/observations.js';
import { upsertMatch } from './discovery.js';
import { identKey, isUsableReference } from './identifiers.js';
import { MIN_CANDIDATE_THRESHOLD, scoreCandidate, type CandidateListing } from './score.js';
import { searchTermsFor } from './sitemapDiscovery.js';

/**
 * Matching our products to a competitor's catalogue we have already read.
 *
 * No page is opened here. `competitor_products` holds what every one of their
 * product pages said about itself; this joins it to our products on the
 * barcode and the manufacturer reference, and — for whatever is left — looks
 * for their closest title. A match made here is priced on the spot from the
 * same stored page, so a product can go from "never seen" to "matched, with a
 * price" without a single further request to the competitor.
 */

interface CatalogueRow {
  id: number;
  url: string;
  title: string | null;
  brand: string | null;
  gtin: string | null;
  mpn: string | null;
  sku: string | null;
  price: string | null;
  was_price: string | null;
  currency: string | null;
  promo: boolean | null;
  in_stock: boolean | null;
  availability_text: string | null;
  attributes: SpecAttributes;
  rendered_with: string | null;
  fetched_at: string;
}

function toListing(row: CatalogueRow): CandidateListing {
  return {
    url: row.url,
    title: row.title ?? '',
    gtin: row.gtin,
    mpn: row.mpn,
    sku: row.sku,
    brand: row.brand,
    attributes: row.attributes ?? {},
    price: row.price != null ? Number(row.price) : null,
  };
}

export interface CatalogueMatchResult {
  /** Pairs found by barcode or manufacturer reference. */
  byIdentifier: number;
  /** Pairs found by title, for products with no identifier in common. */
  byTitle: number;
  autoConfirmed: number;
  /** Stored for a person to confirm or reject. */
  pending: number;
  /** Prices recorded straight from the stored catalogue page. */
  priced: number;
  /** Our products that came out of this with a match stored. */
  matchedProductIds: number[];
}

export interface CatalogueMatchOptions {
  runId?: number | null;
  productIds?: number[] | null;
  /**
   * Only price a new match from its stored page if that page was read at or
   * after this moment. A page read days ago is good evidence of *which*
   * product it is, but not of what it costs today.
   */
  priceIfReadSince?: Date | null;
}

/** How many of their titles to score for one product with no identifier match. */
const TITLE_CANDIDATES = 5;

/**
 * The confidence a title-only match needs before it is put in front of a
 * person.
 *
 * Much higher than the bar the page-by-page search used (25), and deliberately.
 * That search was grateful for anything: it could only open a few guessed
 * pages, so a weak candidate was still the best it would ever find. Here the
 * whole catalogue has been read, so the best title in it is known — and tried
 * against live data, anything under about 60 was a different model from the
 * same collection ("Spirit Zulu Time 39mm" offered against "Flagship Classic
 * 40mm"). Filling the review queue with those costs more attention than the
 * occasional real match among them is worth.
 */
const TITLE_MATCH_MIN = 60;

/**
 * How many of our references a competitor's field must have matched before a
 * *difference* in that field is believed.
 *
 * Whether `mpn` or `sku` holds the manufacturer's reference or the retailer's
 * own stock number varies by site and cannot be told from one page. It can be
 * told from the catalogue: if a field has matched several of our references
 * exactly, it holds manufacturer references, and a title candidate whose value
 * there differs from ours is a different product. If it has never matched one,
 * it is a stock code and says nothing.
 */
const TRUSTED_FIELD_HITS = 3;

/** Second-hand stock is not the same product at a different price. */
const PRE_OWNED = /\bpre[\s-]?owned\b|\bsecond[\s-]?hand\b|\bpreloved\b|\bpre[\s-]?loved\b/i;

/** Which of a competitor's fields demonstrably hold manufacturer references. */
async function trustedReferenceFields(competitorId: number): Promise<('mpn' | 'sku')[]> {
  const { rows } = await query<{ mpn_hits: number; sku_hits: number }>(
    `SELECT
       (SELECT count(*)::int FROM products p
          JOIN competitor_products cp
            ON cp.competitor_id = $1 AND cp.status = 'ok' AND cp.mpn IS NOT NULL
           AND ident_key(cp.mpn) = ident_key(p.mpn)
         WHERE p.mpn IS NOT NULL AND length(ident_key(p.mpn)) >= 5) AS mpn_hits,
       (SELECT count(*)::int FROM products p
          JOIN competitor_products cp
            ON cp.competitor_id = $1 AND cp.status = 'ok' AND cp.sku IS NOT NULL
           AND ident_key(cp.sku) = ident_key(p.mpn)
         WHERE p.mpn IS NOT NULL AND length(ident_key(p.mpn)) >= 5) AS sku_hits`,
    [competitorId],
  );
  const fields: ('mpn' | 'sku')[] = [];
  if ((rows[0]?.mpn_hits ?? 0) >= TRUSTED_FIELD_HITS) fields.push('mpn');
  if ((rows[0]?.sku_hits ?? 0) >= TRUSTED_FIELD_HITS) fields.push('sku');
  return fields;
}

export async function matchFromCatalogue(
  competitor: Competitor,
  options: CatalogueMatchOptions = {},
): Promise<CatalogueMatchResult> {
  const result: CatalogueMatchResult = {
    byIdentifier: 0,
    byTitle: 0,
    autoConfirmed: 0,
    pending: 0,
    priced: 0,
    matchedProductIds: [],
  };
  const productIds = options.productIds ?? null;

  const { rows: held } = await query<{ count: number }>(
    `SELECT count(*)::int AS count FROM competitor_products WHERE competitor_id = $1 AND status = 'ok'`,
    [competitor.id],
  );
  if ((held[0]?.count ?? 0) === 0) return result;

  // ---- 1. Identifier matches: one indexed join per kind ---------------------
  //
  // Only products with no confirmed match for this competitor yet. A confirmed
  // match is settled; re-deriving it every night would do nothing but churn.
  const { rows: pairs } = await query<{ product_id: number; cp_id: number }>(
    `WITH open_products AS (
       SELECT p.id, p.gtin, p.mpn FROM products p
       WHERE p.delisted_at IS NULL
         AND ($2::bigint[] IS NULL OR p.id = ANY($2::bigint[]))
         AND NOT EXISTS (
           SELECT 1 FROM product_matches m
           WHERE m.product_id = p.id AND m.competitor_id = $1 AND m.status = 'confirmed'
         )
     )
     SELECT p.id AS product_id, cp.id AS cp_id
     FROM open_products p
     JOIN competitor_products cp
       ON cp.competitor_id = $1 AND cp.status = 'ok' AND cp.gtin IS NOT NULL
      AND gtin_key(cp.gtin) = gtin_key(p.gtin)
     WHERE p.gtin IS NOT NULL AND gtin_key(p.gtin) <> ''
     UNION
     SELECT p.id, cp.id
     FROM open_products p
     JOIN competitor_products cp
       ON cp.competitor_id = $1 AND cp.status = 'ok' AND cp.mpn IS NOT NULL
      AND ident_key(cp.mpn) = ident_key(p.mpn)
     WHERE p.mpn IS NOT NULL AND length(ident_key(p.mpn)) >= 5
     UNION
     SELECT p.id, cp.id
     FROM open_products p
     JOIN competitor_products cp
       ON cp.competitor_id = $1 AND cp.status = 'ok' AND cp.sku IS NOT NULL
      AND ident_key(cp.sku) = ident_key(p.mpn)
     WHERE p.mpn IS NOT NULL AND length(ident_key(p.mpn)) >= 5`,
    [competitor.id, productIds],
  );

  const settled = new Set<number>();

  for (const pair of pairs) {
    const stored = await scoreAndStore(competitor, pair.product_id, pair.cp_id, options, result, 0);
    if (stored) {
      result.byIdentifier += 1;
      settled.add(pair.product_id);
    }
  }

  // ---- 2. Title matches, for products no identifier reached -----------------
  //
  // Only products this competitor has no match row for at all: one a person
  // has already rejected should not be offered back every night.
  const { rows: unmatched } = await query<Product>(
    `SELECT p.* FROM products p
     WHERE p.delisted_at IS NULL
       AND ($2::bigint[] IS NULL OR p.id = ANY($2::bigint[]))
       AND NOT EXISTS (
         SELECT 1 FROM product_matches m
         WHERE m.product_id = p.id AND m.competitor_id = $1
       )
     ORDER BY p.id`,
    [competitor.id, productIds],
  );

  const trusted = await trustedReferenceFields(competitor.id);

  for (const product of unmatched) {
    if (settled.has(product.id)) continue;

    const brandWords = product.brand
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .split(/\s+/)
      .filter((word) => word.length > 1);
    // A listing that does not name the brand cannot pass the brand gate, so
    // there is no point scoring it — and requiring the brand in the query is
    // what keeps this to an index lookup for the many products a competitor
    // simply does not stock.
    if (brandWords.length === 0 || product.brand.toLowerCase() === 'unknown') continue;

    const terms = searchTermsFor(product).filter((term) => !brandWords.includes(term));
    if (terms.length === 0) continue;

    const tsquery = `(${brandWords.join(' & ')}) & (${terms.join(' | ')})`;
    const { rows: candidates } = await query<CatalogueRow>(
      `SELECT cp.*
       FROM competitor_products cp,
            to_tsquery('simple', $2) AS q
       WHERE cp.competitor_id = $1 AND cp.status = 'ok'
         AND to_tsvector('simple', coalesce(cp.brand, '') || ' ' || coalesce(cp.title, '')) @@ q
       ORDER BY ts_rank(to_tsvector('simple', coalesce(cp.brand, '') || ' ' || coalesce(cp.title, '')), q) DESC
       LIMIT $3`,
      [competitor.id, tsquery, TITLE_CANDIDATES],
    );

    // Only the single strongest title is offered. Several weaker ones for the
    // same product are several things for a person to reject.
    const ourReference = identKey(product.mpn);
    let best: { row: CatalogueRow; confidence: number } | null = null;
    for (const row of candidates) {
      // Their reference is known to be the manufacturer's, and it is not ours.
      const differs =
        isUsableReference(ourReference) &&
        trusted.some((field) => row[field] && identKey(row[field]) !== ourReference);
      if (differs) continue;
      if (PRE_OWNED.test(row.title ?? '') && !PRE_OWNED.test(product.product_name)) continue;

      const scored = scoreCandidate(product, toListing(row));
      if (!scored.viable || scored.confidence < TITLE_MATCH_MIN) continue;
      if (!best || scored.confidence > best.confidence) best = { row, confidence: scored.confidence };
    }

    if (best) {
      const stored = await scoreAndStore(competitor, product, best.row, options, result, TITLE_MATCH_MIN);
      if (stored) {
        result.byTitle += 1;
        settled.add(product.id);
      }
    }
  }
  result.matchedProductIds = [...settled];

  if (result.byIdentifier + result.byTitle > 0) {
    logger.info(
      'catalogue',
      `[${competitor.slug}] matched from stored catalogue: ${result.byIdentifier} by barcode/reference, ` +
        `${result.byTitle} by title; ${result.autoConfirmed} confirmed, ${result.pending} for review, ` +
        `${result.priced} priced`,
    );
  }
  return result;
}

async function scoreAndStore(
  competitor: Competitor,
  productOrId: Product | number,
  rowOrId: CatalogueRow | number,
  options: CatalogueMatchOptions,
  result: CatalogueMatchResult,
  minimumConfidence: number,
): Promise<boolean> {
  const product =
    typeof productOrId === 'number'
      ? (await query<Product>('SELECT * FROM products WHERE id = $1', [productOrId])).rows[0]
      : productOrId;
  const row =
    typeof rowOrId === 'number'
      ? (await query<CatalogueRow>('SELECT * FROM competitor_products WHERE id = $1', [rowOrId])).rows[0]
      : rowOrId;
  if (!product || !row) return false;

  const listing = toListing(row);
  const scored = scoreCandidate(product, listing);
  const minimum = Math.max(MIN_CANDIDATE_THRESHOLD, minimumConfidence);
  if (!scored.viable || scored.confidence < minimum) return false;
  // A second-hand listing can share a barcode with the new one. It is not the
  // same offer, and comparing our new price with it would mislead.
  if (PRE_OWNED.test(row.title ?? '') && !PRE_OWNED.test(product.product_name)) return false;

  const stored = await upsertMatch({
    productId: product.id,
    competitorId: competitor.id,
    url: row.url,
    title: row.title,
    ean: row.gtin ?? row.mpn ?? row.sku ?? null,
    confidence: scored.confidence,
    tier: scored.tier,
    evidence: scored.evidence,
    autoConfirm: scored.autoAccept,
  });

  if (stored.status === 'confirmed') result.autoConfirmed += 1;
  else if (stored.status === 'pending') result.pending += 1;

  // Price it now, from the page we already hold — but only a page read during
  // this run, and only if this run has not already priced the match.
  const fresh =
    options.priceIfReadSince != null &&
    new Date(row.fetched_at).getTime() >= options.priceIfReadSince.getTime();
  if (stored.status === 'confirmed' && fresh && row.price != null) {
    const { rows: already } = await query(
      `SELECT 1 FROM price_observations WHERE match_id = $1 AND scrape_run_id = $2 LIMIT 1`,
      [stored.id, options.runId ?? null],
    );
    if (already.length === 0) {
      await recordPriceObservation(
        {
          matchId: stored.id,
          productId: product.id,
          competitorId: competitor.id,
          internalSku: product.internal_sku,
        },
        {
          price: Number(row.price),
          wasPrice: row.was_price != null ? Number(row.was_price) : null,
          currency: row.currency ?? 'GBP',
          promo: Boolean(row.promo),
          inStock: row.in_stock,
          availabilityText: row.availability_text,
        },
        { runId: options.runId ?? null, sourceUrl: row.url, renderedWith: row.rendered_with },
      );
      result.priced += 1;
    }
  }

  return true;
}
