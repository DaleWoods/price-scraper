import { query } from '../db/pool.js';
import { gtinKey, refKey } from '../matching/identifiers.js';

/**
 * Turn whatever someone has to hand — our SKU, a barcode, or the manufacturer's
 * reference — into our product ids.
 *
 * Buyers and merchandisers rarely think in our internal SKUs; a list pulled
 * from a supplier or a brand is far more likely to be barcodes or references.
 * Each value is tried as a SKU first (exact, ignoring case), then as a barcode
 * (digits only, leading zeros ignored), then as a reference (letters and digits
 * only), using the same rules as competitor matching.
 *
 * One value can resolve to more than one product — the same barcode on two of
 * our SKUs — and all of them are returned. Delisted products are included: the
 * runner skips them itself, and saying "not found" for a product we hold but no
 * longer sell would be wrong.
 */
export async function resolveProducts(
  values: string[],
): Promise<{ productIds: number[]; unresolved: string[] }> {
  const cleaned = [...new Set(values.map((value) => value.trim()).filter(Boolean))];
  if (cleaned.length === 0) return { productIds: [], unresolved: [] };

  const lowered = cleaned.map((value) => value.toLowerCase());
  const gtinKeys = cleaned.map((value) => gtinKey(value));
  const refKeys = cleaned.map((value) => refKey(value));

  // Four lookups joined by UNION rather than one join on four conditions: a
  // join on "this OR that OR the other" can use no index, so every value
  // scanned every product — minutes per value on a full catalogue. Each of
  // these is served by its own index (migrations 021, 022, 027).
  const { rows } = await query<{ id: number; hit: number }>(
    `WITH v AS (
       SELECT * FROM unnest($1::text[], $2::text[], $3::text[]) WITH ORDINALITY AS v(sku, gk, rk, ord)
     )
     SELECT p.id, v.ord::int AS hit FROM v JOIN products p ON lower(p.internal_sku) = v.sku
     UNION
     -- Eight digits or more before it counts as a barcode: a short number is
     -- far more likely to be a SKU than a barcode, and is matched as one above.
     SELECT p.id, v.ord::int FROM v JOIN products p ON p.gtin IS NOT NULL AND gtin_key(p.gtin) = v.gk
     WHERE length(v.gk) >= 8
     UNION
     SELECT p.id, v.ord::int FROM v JOIN products p ON p.ean_mpn IS NOT NULL AND gtin_key(p.ean_mpn) = v.gk
     WHERE length(v.gk) >= 8
     UNION
     SELECT p.id, v.ord::int FROM v JOIN products p ON p.mpn IS NOT NULL AND ref_key(p.mpn) = v.rk
     WHERE length(v.rk) >= 5`,
    [lowered, gtinKeys, refKeys],
  );

  const matched = new Set(rows.map((row) => row.hit));
  return {
    productIds: [...new Set(rows.map((row) => Number(row.id)))],
    unresolved: cleaned.filter((_, index) => !matched.has(index + 1)),
  };
}
