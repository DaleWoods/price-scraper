-- Where a product came from.
--
-- Everything normally arrives in a Google feed, and a feed is authoritative for
-- its site: anything it omits is delisted. A product added by hand for testing
-- has no feed to appear in, so without this it would be delisted by the very
-- next import — which is exactly when you are trying to use it.
ALTER TABLE products
    ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'feed';

ALTER TABLE products
    DROP CONSTRAINT IF EXISTS products_source_check;
ALTER TABLE products
    ADD CONSTRAINT products_source_check CHECK (source IN ('feed', 'manual'));

CREATE INDEX IF NOT EXISTS products_source_idx ON products (source);
