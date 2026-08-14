-- A run can be scoped to a single product, which is how you test whether one
-- SKU you know a competitor stocks is actually picked up. Recording the scope
-- on the run is what lets the runs list say "1 product" rather than leaving you
-- to infer it from the items.
ALTER TABLE scrape_runs
    ADD COLUMN IF NOT EXISTS product_id BIGINT REFERENCES products(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS scrape_runs_product_idx ON scrape_runs (product_id);
