-- Lead times: what each product page says about how soon the product arrives
-- ("Next day", "1-2 weeks"), read alongside the price. `lead_days` is the
-- number of days until it has arrived (the end of a stated range), for comparing one retailer with another.
ALTER TABLE competitor_products ADD COLUMN IF NOT EXISTS lead_text TEXT;
ALTER TABLE competitor_products ADD COLUMN IF NOT EXISTS lead_days INTEGER;

ALTER TABLE price_observations ADD COLUMN IF NOT EXISTS lead_text TEXT;
ALTER TABLE price_observations ADD COLUMN IF NOT EXISTS lead_days INTEGER;

-- Ours, as our own product page states it. The feed does not carry it, so it
-- is read from the page: when a product is looked up, and for products a
-- competitor also sells.
ALTER TABLE products ADD COLUMN IF NOT EXISTS our_lead_text TEXT;
ALTER TABLE products ADD COLUMN IF NOT EXISTS our_lead_days INTEGER;
ALTER TABLE products ADD COLUMN IF NOT EXISTS our_lead_at TIMESTAMPTZ;
