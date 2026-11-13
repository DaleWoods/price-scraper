import type { MatchEvidence, MatchTier, Product, SpecAttributes } from '../domain/types.js';
import {
  AUTO_ACCEPT_THRESHOLD,
  MIN_CANDIDATE_THRESHOLD,
  WEIGHT_POINTS,
  canonicalAttributeName,
  normaliseAttribute,
  normaliseText,
  rulesForCategory,
  weightOf,
} from './attributes.js';
import { compareIdentifiers } from './identifiers.js';

/** What we managed to read off a competitor listing (title, specs, JSON-LD). */
export interface CandidateListing {
  url: string;
  title: string;
  /**
   * The first of gtin, mpn or sku the page published, as one value. Kept for
   * listings read before the three were separated; prefer the fields below.
   */
  ean?: string | null;
  /** The barcode, the manufacturer reference and the retailer's own code. */
  gtin?: string | null;
  mpn?: string | null;
  sku?: string | null;
  brand?: string | null;
  /** Spec attributes parsed from a listing's spec table or JSON-LD. */
  attributes?: SpecAttributes;
  price?: number | null;
}

export interface ScoredCandidate {
  listing: CandidateListing;
  confidence: number;
  tier: MatchTier;
  evidence: MatchEvidence;
  /** False when a gate attribute disagreed — candidate is rejected outright. */
  viable: boolean;
  autoAccept: boolean;
}

/** Token-level Dice coefficient — stable for short retail product names. */
export function nameSimilarity(a: string, b: string): number {
  const left = new Set(normaliseText(a).split(' ').filter(Boolean));
  const right = new Set(normaliseText(b).split(' ').filter(Boolean));
  if (left.size === 0 || right.size === 0) return 0;

  let shared = 0;
  for (const token of left) if (right.has(token)) shared += 1;
  return (2 * shared) / (left.size + right.size);
}

/**
 * Build a lookup of the candidate's attributes. Anything the competitor didn't
 * publish as structured data is inferred from the listing title, which is where
 * UK watch/jewellery retailers put case size, dial colour and metal.
 */
function candidateAttributes(listing: CandidateListing): SpecAttributes {
  const attributes: SpecAttributes = {};
  for (const [key, value] of Object.entries(listing.attributes ?? {})) {
    if (typeof value === 'string' && value.trim()) attributes[canonicalAttributeName(key)] = value;
  }
  if (listing.brand?.trim() && !attributes.brand) attributes.brand = listing.brand;

  const title = listing.title ?? '';

  if (!attributes.case_size) {
    const size = title.match(/(\d{2}(?:\.\d)?)\s*mm/i);
    if (size?.[1]) attributes.case_size = `${size[1]}mm`;
  }
  if (!attributes.carat_weight) {
    const carat = title.match(/(\d+(?:\.\d+)?)\s*(?:ct|carat)/i);
    if (carat?.[0]) attributes.carat_weight = carat[0];
  }
  return attributes;
}

/** Escapes regex metacharacters so a value gets matched literally, not interpreted. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Does the candidate's free text support this value, when it has no structured
 * attribute of its own? Used so a title like "Blue Dial Steel Bracelet" can still
 * satisfy dial_colour and case_material.
 */
function textSupports(attribute: string, normalisedOurs: string, haystack: string): boolean {
  if (normalisedOurs.length < 3) return false;
  if (attribute === 'case_size') {
    // A case size like "40.5" normalises with a literal decimal point, which
    // is also a regex wildcard — escape it, or a title containing something
    // like "40X5mm" would wrongly count as matching "40.5mm".
    return new RegExp(`\\b${escapeRegExp(normalisedOurs)}\\s*mm\\b`).test(haystack);
  }
  return haystack.includes(normalisedOurs);
}

/**
 * Does the listing show our brand anywhere a person would see it — the title,
 * the brand it declares, or the words of its address? Several retailers
 * declare their own shop name as the "brand" in their structured data, so the
 * declared brand alone is not enough to go on.
 */
function brandVisible(product: Product, listing: CandidateListing): boolean {
  const brand = normaliseText(product.brand);
  if (!brand || brand === 'unknown') return false;
  let path = listing.url;
  try {
    path = decodeURIComponent(new URL(listing.url).pathname);
  } catch {
    // Not a parseable URL: search it as it stands.
  }
  const haystack = normaliseText(
    [listing.title, listing.brand ?? '', path.replace(/[^A-Za-z0-9]+/g, ' ')].join(' '),
  );
  return haystack.includes(brand);
}

/**
 * Tiered confidence score (Spec §5.3 + Appendix A).
 *
 *   Tier 1 — exact EAN/MPN match: 100, overrides everything below.
 *   Tier 2 — gates pass, then weighted High/Medium agreements.
 *   Tier 3 — fuzzy name + specs fallback for sparse listings.
 *
 * A gate disagreement (not a gate *absence*) rejects the candidate outright.
 */
export function scoreCandidate(product: Product, listing: CandidateListing): ScoredCandidate {
  const rules = rulesForCategory(product.category);
  const evidence: MatchEvidence = {
    gatesPassed: [],
    gatesFailed: [],
    attributeHits: [],
    attributeMisses: [],
    notes: [],
  };

  // ---- Tier 1: EAN / MPN exact --------------------------------------------
  // Barcode against barcode, reference against reference — see identifiers.ts
  // for why the two are never compared with each other.
  const identity = compareIdentifiers(
    { gtin: product.gtin, mpn: product.mpn, eanMpn: product.ean_mpn },
    { gtin: listing.gtin, mpn: listing.mpn, sku: listing.sku, ean: listing.ean },
  );

  if (identity.verdict === 'match') {
    // A barcode is globally unique, so it stands alone. A manufacturer
    // reference is only unique within a brand, so it counts as exact only when
    // the listing also shows the brand — otherwise it falls through to be
    // scored on its attributes like any other candidate.
    if (identity.via === 'gtin' || brandVisible(product, listing)) {
      evidence.tier = 'ean_mpn_exact';
      evidence.notes = [
        identity.via === 'gtin'
          ? `EAN/MPN exact match on ${identity.ours} — overrides attribute scoring.`
          : `Manufacturer reference ${identity.ours} matches theirs (${identity.theirs}) and the ` +
            `listing names ${product.brand} — overrides attribute scoring.`,
      ];
      return {
        listing,
        confidence: 100,
        tier: 'ean_mpn_exact',
        evidence,
        viable: true,
        autoAccept: true,
      };
    }
    evidence.notes?.push(
      `Manufacturer reference ${identity.ours} matches theirs, but the listing does not name ` +
        `${product.brand}, so it was scored on its attributes instead.`,
    );
  }

  const attributes = candidateAttributes(listing);
  const ourSpecs: SpecAttributes = { brand: product.brand, ...normaliseSpecKeys(product.specs) };
  const haystack = normaliseText(
    [listing.title, ...Object.values(attributes)].filter(Boolean).join(' '),
  );

  // A competitor publishing a *different* barcode is a hard rejection:
  // same-brand products with different GTINs are different products. Only a
  // barcode can prove that; a differing reference may be their own stock code.
  if (identity.verdict === 'conflict') {
    evidence.notes?.push(
      `Competitor publishes EAN/MPN ${identity.theirs}, which differs from ours (${identity.ours}).`,
    );
    evidence.gatesFailed?.push('ean_mpn');
    return {
      listing,
      confidence: 0,
      tier: 'brand_spec_attributes',
      evidence,
      viable: false,
      autoAccept: false,
    };
  }

  // ---- Gates ---------------------------------------------------------------
  for (const gate of rules.gate) {
    const oursRaw = ourSpecs[gate];
    if (!oursRaw) continue; // We can't gate on what we don't hold.

    const ours = normaliseAttribute(gate, oursRaw);
    if (!ours) continue;

    const theirsRaw = attributes[gate];
    if (theirsRaw) {
      const theirs = normaliseAttribute(gate, theirsRaw);
      if (theirs && (theirs === ours || theirs.includes(ours) || ours.includes(theirs))) {
        evidence.gatesPassed?.push(gate);
      } else {
        evidence.gatesFailed?.push(gate);
        return {
          listing,
          confidence: 0,
          tier: 'brand_spec_attributes',
          evidence,
          viable: false,
          autoAccept: false,
        };
      }
    } else if (textSupports(gate, ours, haystack)) {
      evidence.gatesPassed?.push(gate);
    } else if (gate === 'brand') {
      // Brand is the one gate we insist on: if it is neither published nor
      // present in the title, this is not a candidate.
      evidence.gatesFailed?.push('brand');
      return {
        listing,
        confidence: 0,
        tier: 'brand_spec_attributes',
        evidence,
        viable: false,
        autoAccept: false,
      };
    } else {
      evidence.notes?.push(`Gate '${gate}' not published by competitor — treated as unknown.`);
    }
  }

  // ---- Weighted High / Medium agreements -----------------------------------
  let earned = 0;
  let available = 0;

  for (const [attribute, oursRaw] of Object.entries(ourSpecs)) {
    const weight = weightOf(rules, attribute);
    if (weight !== 'high' && weight !== 'medium') continue; // gates scored above, 'ignore' skipped

    const ours = normaliseAttribute(attribute, oursRaw);
    if (!ours) continue;

    const points = WEIGHT_POINTS[weight];
    available += points;

    const theirsRaw = attributes[attribute];
    const theirs = theirsRaw ? normaliseAttribute(attribute, theirsRaw) : null;

    if (theirs && theirs === ours) {
      earned += points;
      evidence.attributeHits?.push({ attribute, weight, ours: oursRaw, theirs: theirsRaw ?? '' });
    } else if (!theirs && textSupports(attribute, ours, haystack)) {
      // Inferred from the listing title — real agreement, but discounted.
      earned += points * 0.75;
      evidence.attributeHits?.push({
        attribute,
        weight,
        ours: oursRaw,
        theirs: '(inferred from listing title)',
      });
    } else if (theirs) {
      evidence.attributeMisses?.push({ attribute, weight, ours: oursRaw, theirs: theirsRaw ?? '' });
    } else {
      // Not published and not in the title — no evidence either way. Remove it
      // from the denominator so sparse listings aren't punished for silence.
      available -= points;
      evidence.attributeMisses?.push({ attribute, weight, ours: oursRaw, theirs: '(not published)' });
    }
  }

  const similarity = nameSimilarity(`${product.brand} ${product.product_name}`, listing.title);
  evidence.nameSimilarity = Number(similarity.toFixed(3));

  let confidence: number;
  let tier: MatchTier;

  if (available > 0) {
    // Tier 2: attribute-driven. Name similarity contributes a fifth, so a strong
    // attribute match on an oddly-worded title still scores well.
    const attributeScore = (earned / available) * 100;
    confidence = Math.round(attributeScore * 0.8 + similarity * 100 * 0.2);
    tier = 'brand_spec_attributes';
  } else {
    // Tier 3: nothing comparable beyond the name — fuzzy fallback, capped so it
    // can never auto-accept.
    confidence = Math.round(Math.min(similarity * 100, AUTO_ACCEPT_THRESHOLD - 5));
    tier = 'fuzzy_name_specs';
    evidence.notes?.push('No comparable spec attributes on the listing — fuzzy name match only.');
  }

  confidence = Math.max(0, Math.min(100, confidence));
  evidence.tier = tier;

  return {
    listing,
    confidence,
    tier,
    evidence,
    viable: confidence >= MIN_CANDIDATE_THRESHOLD,
    autoAccept: confidence >= AUTO_ACCEPT_THRESHOLD,
  };
}

function normaliseSpecKeys(specs: SpecAttributes): SpecAttributes {
  const out: SpecAttributes = {};
  for (const [key, value] of Object.entries(specs ?? {})) {
    if (typeof value === 'string' && value.trim()) out[canonicalAttributeName(key)] = value;
  }
  return out;
}

export { AUTO_ACCEPT_THRESHOLD, MIN_CANDIDATE_THRESHOLD };
