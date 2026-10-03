-- Which remote file a feed import came from, so the same one is not imported twice.
--
-- These feeds are commonly republished under the same filename every day, so
-- the name alone cannot tell yesterday's from today's. The signature carries
-- the size and modified time with it.
--
-- Re-importing an identical feed is not harmless: a feed is authoritative for
-- its fascia, so it rewrites that site's prices and churns the delist/relist
-- counters while telling us nothing new.
ALTER TABLE feed_imports ADD COLUMN IF NOT EXISTS source_signature TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS feed_imports_source_signature_idx
  ON feed_imports (fascia_id, source_signature)
  WHERE source_signature IS NOT NULL;
