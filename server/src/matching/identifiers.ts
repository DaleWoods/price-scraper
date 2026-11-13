/**
 * Comparing our product identifiers with a competitor's.
 *
 * There are two kinds and they must not be compared with each other. A GTIN
 * (the barcode: EAN-13, UPC-12, GTIN-14) is the manufacturer's global number
 * for one exact product. An MPN is the manufacturer's own reference
 * ("220.13.41.21.10.001", "WSSA0086"). Until this module existed both sides
 * were squeezed into a single "EAN/MPN" value — ours whichever the feed
 * preferred, theirs the first of gtin, mpn or sku the page happened to publish
 * — and compared as one string. Read against real pages that goes wrong both
 * ways at once: our barcode against a page that publishes only the reference
 * is two different numbers for the same watch, which was scored as an outright
 * rejection; and several retailers put their own stock code in the `mpn` or
 * `sku` field, which is not the manufacturer's reference at all.
 *
 * The rules here:
 *   - barcode equals barcode                -> the same product, certainly;
 *   - our reference equals their mpn or sku -> the same product, provided the
 *     caller can also see the brand on the listing (short references collide
 *     across brands);
 *   - both sides publish a barcode and they differ, with no reference in
 *     common                                -> a different product;
 *   - anything else                         -> no evidence either way.
 *
 * The two key functions are mirrored by gtin_key() and ident_key() in
 * migrations/021_competitor_catalogue.sql — change both together.
 */

/** Digits only, leading zeros dropped: a UPC-12 and its zero-padded EAN-13 agree. */
export function gtinKey(value: string | null | undefined): string {
  return (value ?? '').replace(/[^0-9]/g, '').replace(/^0+/, '');
}

/** Letters and digits only, lower-cased. */
export function identKey(value: string | null | undefined): string {
  return (value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Is this value a barcode rather than a reference?
 *
 * Only 12 to 14 digits count. Eight digits is a valid GTIN-8 on paper, but an
 * eight-digit retailer stock code is far more common on a jeweller's product
 * page, and mistaking one for a barcode turns it into grounds for rejection.
 */
export function looksLikeGtin(value: string | null | undefined): boolean {
  return /^[0-9]{12,14}$/.test((value ?? '').replace(/[\s-]/g, ''));
}

/**
 * Is a reference distinctive enough to match on? "1234" or "GOLD" appear in
 * too many catalogues to mean anything.
 */
export function isUsableReference(key: string): boolean {
  return key.length >= 5 && /[0-9]/.test(key);
}

export interface OurIdentifiers {
  gtin?: string | null;
  mpn?: string | null;
  /** The older combined field: a barcode or a reference, whichever was held. */
  eanMpn?: string | null;
}

export interface TheirIdentifiers {
  gtin?: string | null;
  mpn?: string | null;
  sku?: string | null;
  /** The older combined field: the first of gtin, mpn or sku the page published. */
  ean?: string | null;
}

export type IdentifierVerdict =
  | { verdict: 'match'; via: 'gtin' | 'mpn'; ours: string; theirs: string }
  | { verdict: 'conflict'; ours: string; theirs: string }
  | { verdict: 'unknown' };

export function compareIdentifiers(ours: OurIdentifiers, theirs: TheirIdentifiers): IdentifierVerdict {
  const ourGtin = ours.gtin || (looksLikeGtin(ours.eanMpn) ? ours.eanMpn : null) || null;
  const ourMpn = ours.mpn || (ours.eanMpn && !looksLikeGtin(ours.eanMpn) ? ours.eanMpn : null) || null;

  const theirGtin = theirs.gtin || (looksLikeGtin(theirs.ean) ? theirs.ean : null) || null;
  const theirReferences = [
    theirs.mpn,
    theirs.sku,
    theirs.ean && !looksLikeGtin(theirs.ean) ? theirs.ean : null,
  ].filter((value): value is string => Boolean(value));

  const ourGtinKey = gtinKey(ourGtin);
  const theirGtinKey = gtinKey(theirGtin);
  if (ourGtinKey && theirGtinKey && ourGtinKey === theirGtinKey) {
    return { verdict: 'match', via: 'gtin', ours: ourGtin!, theirs: theirGtin! };
  }

  const ourMpnKey = identKey(ourMpn);
  if (isUsableReference(ourMpnKey)) {
    const hit = theirReferences.find((reference) => identKey(reference) === ourMpnKey);
    if (hit) return { verdict: 'match', via: 'mpn', ours: ourMpn!, theirs: hit };
  }

  // Only barcode against barcode can prove a difference. A differing reference
  // proves nothing: the competitor's may be their own stock code.
  if (ourGtinKey && theirGtinKey) {
    return { verdict: 'conflict', ours: ourGtin!, theirs: theirGtin! };
  }

  return { verdict: 'unknown' };
}
