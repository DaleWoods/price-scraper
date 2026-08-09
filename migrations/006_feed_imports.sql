-- Make a feed import authoritative for the fascia it belongs to.
--
-- The feed states "all valid products" for a site, so after importing one, the
-- products in that file are exactly what the site sells. Previously the import
-- only upserted, so anything from an earlier file lingered and was still
-- scanned — a one-product test file did not narrow the scan to one product.
--
-- Products are delisted rather than deleted: price_observations cascade from
-- products, so deleting would destroy the price history that is the point of
-- the app. A product returning to a later feed is simply re-listed.

CREATE TABLE IF NOT EXISTS feed_imports (
    id           BIGSERIAL   PRIMARY KEY,
    fascia_id    BIGINT      NOT NULL REFERENCES fascias(id) ON DELETE CASCADE,
    filename     TEXT        NOT NULL,
    rows_read    INTEGER     NOT NULL DEFAULT 0,
    products_seen INTEGER    NOT NULL DEFAULT 0,
    prices_written INTEGER   NOT NULL DEFAULT 0,
    delisted     INTEGER     NOT NULL DEFAULT 0,
    imported_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS feed_imports_fascia_idx ON feed_imports (fascia_id, imported_at DESC);

ALTER TABLE fascia_prices
    -- Which import last wrote this price. Rows left behind by an older import
    -- of the same fascia are removed once a newer one lands.
    ADD COLUMN IF NOT EXISTS feed_import_id BIGINT REFERENCES feed_imports(id) ON DELETE SET NULL;

ALTER TABLE products
    -- NULL means currently listed by at least one fascia. Set when a product
    -- stops appearing in every fascia's latest feed.
    ADD COLUMN IF NOT EXISTS delisted_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS products_listed_idx ON products (delisted_at) WHERE delisted_at IS NULL;
