-- Read each competitor's catalogue once; match by barcode in the database.
--
-- Until now discovery worked one of our products at a time: guess which of a
-- competitor's URLs might be it from the words in the address, open up to three
-- of those pages, score them. Five thousand products against six competitors is
-- up to ninety thousand page loads, most of them wrong guesses, and a product
-- whose address shares no words with our title is never found at all.
--
-- A competitor's catalogue is small by comparison — a few thousand product pages
-- each — and every one of those pages states its own barcode and manufacturer
-- reference. So each page is read once and remembered here; matching is then a
-- join on the barcode, which is exact, instant, and finds every product a
-- competitor lists whether or not its address resembles ours.
CREATE TABLE IF NOT EXISTS competitor_products (
  id                 BIGSERIAL PRIMARY KEY,
  competitor_id      BIGINT NOT NULL REFERENCES competitors(id) ON DELETE CASCADE,
  url                TEXT NOT NULL,
  -- ok: a product page we read. not_product: reachable, but no product on it
  -- (a category or article that looked like one). gone: 404/410. error: could
  -- not be read this time; retried on a later run.
  status             TEXT NOT NULL DEFAULT 'ok'
                       CHECK (status IN ('ok', 'not_product', 'gone', 'error')),
  title              TEXT,
  brand              TEXT,
  gtin               TEXT,
  mpn                TEXT,
  sku                TEXT,
  price              NUMERIC(12, 2),
  was_price          NUMERIC(12, 2),
  currency           TEXT,
  promo              BOOLEAN,
  in_stock           BOOLEAN,
  availability_text  TEXT,
  attributes         JSONB NOT NULL DEFAULT '{}'::jsonb,
  rendered_with      TEXT,
  error_kind         TEXT,
  error              TEXT,
  first_fetched_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  fetched_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (competitor_id, url)
);

-- The two comparison keys, as functions so the same rule applies to our side
-- and theirs and cannot drift between the two. Mirrored in
-- server/src/matching/identifiers.ts — change both together.
--
-- A barcode compares on its digits with leading zeros dropped, so a 12-digit
-- UPC and the 13-digit EAN that is the same number with a zero in front agree.
CREATE OR REPLACE FUNCTION gtin_key(value TEXT) RETURNS TEXT
  LANGUAGE sql IMMUTABLE PARALLEL SAFE AS
$$ SELECT ltrim(regexp_replace(coalesce(value, ''), '[^0-9]', '', 'g'), '0') $$;

-- A manufacturer reference compares on its letters and digits only:
-- "220.13.41.21.10.001", "220-13-41-21-10-001" and "22013412110001" agree.
CREATE OR REPLACE FUNCTION ident_key(value TEXT) RETURNS TEXT
  LANGUAGE sql IMMUTABLE PARALLEL SAFE AS
$$ SELECT regexp_replace(lower(coalesce(value, '')), '[^a-z0-9]', '', 'g') $$;

CREATE INDEX IF NOT EXISTS competitor_products_gtin_idx
  ON competitor_products (competitor_id, gtin_key(gtin)) WHERE gtin IS NOT NULL;
CREATE INDEX IF NOT EXISTS competitor_products_mpn_idx
  ON competitor_products (competitor_id, ident_key(mpn)) WHERE mpn IS NOT NULL;
CREATE INDEX IF NOT EXISTS competitor_products_sku_idx
  ON competitor_products (competitor_id, ident_key(sku)) WHERE sku IS NOT NULL;
CREATE INDEX IF NOT EXISTS competitor_products_fetched_idx
  ON competitor_products (competitor_id, fetched_at);
-- For products with no identifier in common: search their titles, not their
-- addresses. The title is what the page says the product is.
CREATE INDEX IF NOT EXISTS competitor_products_title_idx
  ON competitor_products
  USING gin (to_tsvector('simple', coalesce(brand, '') || ' ' || coalesce(title, '')))
  WHERE status = 'ok';

-- Our side kept one identifier per product: the barcode when the feed had one,
-- otherwise the manufacturer reference — never both. Several competitors
-- publish only the reference, so a product of ours held by barcode alone could
-- not be matched to them exactly. Both are kept from now on.
ALTER TABLE products ADD COLUMN IF NOT EXISTS gtin TEXT;
ALTER TABLE products ADD COLUMN IF NOT EXISTS mpn  TEXT;

-- What is already held is one or the other; a run of 12 to 14 digits is a
-- barcode, anything else a reference. The next feed import fills in whichever
-- half is missing.
UPDATE products
SET gtin = CASE WHEN ean_mpn ~ '^[0-9]{12,14}$' THEN ean_mpn END,
    mpn  = CASE WHEN ean_mpn !~ '^[0-9]{12,14}$' THEN ean_mpn END
WHERE ean_mpn IS NOT NULL AND gtin IS NULL AND mpn IS NULL;

CREATE INDEX IF NOT EXISTS products_gtin_key_idx ON products (gtin_key(gtin)) WHERE gtin IS NOT NULL;
CREATE INDEX IF NOT EXISTS products_mpn_key_idx  ON products (ident_key(mpn)) WHERE mpn IS NOT NULL;
