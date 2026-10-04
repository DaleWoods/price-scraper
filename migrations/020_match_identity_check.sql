-- Flag a confirmed match whose page has stopped being the product we matched.
--
-- A confirmed match stores a URL and nothing re-checked it afterwards: every
-- night we fetched that URL and recorded whatever price was on it. A retailer
-- redirecting an old URL to a replacement model, reusing a slug for next
-- season, or serving a category page after discontinuing something would have
-- us recording the wrong price against our product indefinitely — and
-- invisibly, because a plausible price looks exactly like a correct one.
--
-- The EAN was checked once, at discovery, to confirm the match. Now it is
-- checked on every scrape, and a mismatch lands here rather than in the price
-- history.
ALTER TABLE product_matches ADD COLUMN IF NOT EXISTS flagged_at   TIMESTAMPTZ;
ALTER TABLE product_matches ADD COLUMN IF NOT EXISTS flag_reason  TEXT;

-- The scraper skips flagged matches, so this is the lookup it makes every run.
CREATE INDEX IF NOT EXISTS product_matches_flagged_idx
  ON product_matches (competitor_id) WHERE flagged_at IS NOT NULL;
