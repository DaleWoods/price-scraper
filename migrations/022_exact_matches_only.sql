-- Exact matches only, and references compared without a brand's letter prefix.
--
-- Tried on a real product (Omega Seamaster Diver 300M, Goldsmiths 17331581) the
-- app offered three wrong Berry's watches for review and missed the right one.
-- Goldsmiths writes the reference O21030422004001; Berry's writes the same
-- reference 21030422004001, without Omega's "O". Compared letter for letter
-- they differ, so the exact match failed and the title guess stepped in.
--
-- ref_key() is ident_key() with a leading one- or two-letter prefix dropped
-- when what follows starts with a digit and is at least eight characters long:
-- "O21030422004001" and "21030422004001" agree, "L37204726" and "37204726"
-- agree, while "WSSA0086" or "GAC-2500-9AER" are left whole. Both sides go
-- through the same function, so it can only ever widen a match, and a match
-- on a reference still requires the listing to show our brand.
-- Mirrored by refKey() in server/src/matching/identifiers.ts.
-- Written with built-in functions only, never ident_key(): Postgres 17 builds
-- an index with the search path cut down to pg_catalog, so a call to another
-- of our functions by its short name fails there ("function ident_key(text)
-- does not exist") even though it works everywhere else. The first deploy of
-- this migration failed on exactly that.
CREATE OR REPLACE FUNCTION ref_key(value TEXT) RETURNS TEXT
  LANGUAGE sql IMMUTABLE PARALLEL SAFE AS
$$
  SELECT CASE
    WHEN k ~ '^[a-z]{1,2}[0-9]'
     AND length(regexp_replace(k, '^[a-z]{1,2}', '')) >= 8
      THEN regexp_replace(k, '^[a-z]{1,2}', '')
    ELSE k
  END
  FROM (SELECT regexp_replace(lower(coalesce(value, '')), '[^a-z0-9]', '', 'g') AS k) AS normalised
$$;

CREATE INDEX IF NOT EXISTS competitor_products_mpn_ref_idx
  ON competitor_products (competitor_id, ref_key(mpn)) WHERE mpn IS NOT NULL;
CREATE INDEX IF NOT EXISTS competitor_products_sku_ref_idx
  ON competitor_products (competitor_id, ref_key(sku)) WHERE sku IS NOT NULL;
CREATE INDEX IF NOT EXISTS products_mpn_ref_idx ON products (ref_key(mpn)) WHERE mpn IS NOT NULL;

-- Nothing is matched by likeness of name any more, so nothing waits for a
-- person to confirm it. Suggestions already waiting are removed; matches a
-- person has already confirmed are kept.
DELETE FROM product_matches WHERE status = 'pending';

-- For the Check a product page: our product's picture, and when someone last
-- looked it up, so the page can list recent checks.
ALTER TABLE products ADD COLUMN IF NOT EXISTS image_url TEXT;
ALTER TABLE products ADD COLUMN IF NOT EXISTS looked_up_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS products_looked_up_idx ON products (looked_up_at DESC) WHERE looked_up_at IS NOT NULL;
