import type { MatchEvidence, MatchTier, Product, SpecAttributes } from '../domain/types.js';
import {
  AUTO_ACCEPT_THRESHOLD,
  MIN_CANDIDATE_THRESHOLD,
  WEIGHT_POINTS,
  canonicalAttributeName,
  normaliseAttribute,
  normaliseIdentifier,
  normaliseText,
  rulesForCategory,
  weightOf,
} from './attributes.js';

/** What we managed to read off a competitor listing (title, specs, JSON-LD). */
export interface CandidateListing {
  url: string;
  title: string;
  /** EAN/GTIN/MPN if the competitor exposes one. */
  ean?: string | null;
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

/**
 * Does the candidate's free text support this value, when it has no structured
 * attribute of its own? Used so a title like "Blue Dial Steel Bracelet" can still
 * satisfy dial_colour and case_material.
 */
function textSupports(attribute: string, normalisedOurs: string, haystack: string): boolean {
  if (normalisedOurs.length < 3) return false;
  if (attribute === 'case_size') return new RegExp(`\\b${normalisedOurs}\\s*mm\\b`).test(haystack);
  return haystack.includes(normalisedOurs);
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
  if (product.ean_mpn && listing.ean) {
    const ours = normaliseIdentifier(product.ean_mpn);
    const theirs = normaliseIdentifier(listing.ean);
    if (ours && ours === theirs) {
      evidence.tier = 'ean_mpn_exact';
      evidence.notes = [`EAN/MPN exact match on ${product.ean_mpn} — overrides attribute scoring.`];
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
      `Competitor publishes EAN/MPN ${listing.ean}, which differs from ours (${product.ean_mpn}).`,
    );
  }

  const attributes = candidateAttributes(listing);
  const ourSpecs: SpecAttributes = { brand: product.brand, ...normaliseSpecKeys(product.specs) };
  const haystack = normaliseText(
    [listing.title, ...Object.values(attributes)].filter(Boolean).join(' '),
  );

  // A competitor publishing a *different* EAN is a hard rejection: same-brand
  // products with different GTINs are different products.
  if (product.ean_mpn && listing.ean) {
    const ours = normaliseIdentifier(product.ean_mpn);
    const theirs = normaliseIdentifier(listing.ean);
    if (ours && theirs && ours !== theirs) {
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
