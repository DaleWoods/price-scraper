-- 002_optional_our_price.sql
--
-- The master catalogue export carries product content, not pricing — prices
-- arrive later as a separate file keyed on SKU. Until then a product is a real,
-- matchable record with no price of its own, so our_price becomes nullable.
--
-- Everything except the £/% delta still works without it: import, matching, the
-- manual-confirm queue, scraping and competitor price history. The comparison
-- view reports those products as "our price not loaded" rather than pretending
-- they are level or cheapest.

ALTER TABLE products ALTER COLUMN our_price DROP NOT NULL;

-- Partial index: "which products are still waiting for a price?" is the query
-- the trading team will run every time a price file lands.
CREATE INDEX IF NOT EXISTS products_awaiting_price_idx
    ON products (brand, internal_sku)
    WHERE our_price IS NULL;
