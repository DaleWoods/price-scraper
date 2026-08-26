-- A run can now be scoped to a specific uploaded list of products, not just
-- one (product_id) or the whole catalogue (neither set). product_id stays
-- singular and keeps meaning "scoped to exactly one product" — the existing
-- single-product test path is unchanged. A bulk-list run leaves product_id
-- NULL (there is no single product to point at) and records how many
-- products it targeted instead, purely so the run list can say "47 products"
-- rather than looking like an untargeted full run. The actual set of
-- products a run touched is already reconstructable from scrape_run_items,
-- so nothing else needs storing here.
ALTER TABLE scrape_runs
    ADD COLUMN IF NOT EXISTS product_count INTEGER;
