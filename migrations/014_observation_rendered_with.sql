-- Which transport actually produced this price.
--
-- Chromium is the most expensive thing this app does, and it was the dominant
-- cost behind a compute-quota outage on the hosting platform. Competitors now
-- default to 'auto' rendering — plain HTTP first, a real browser only when the
-- HTTP response cannot be extracted from — and this column is how that choice
-- stays measurable rather than assumed: a competitor whose observations are all
-- 'http' never needs a browser, and one that is always 'browser' is worth
-- pinning explicitly so it stops paying for a failed HTTP attempt every time.
--
-- Nullable with no backfill: observations recorded before this column existed
-- genuinely do not know which transport produced them, and inventing a value
-- for them would make the measurement lie.
ALTER TABLE price_observations
    ADD COLUMN IF NOT EXISTS rendered_with TEXT;
