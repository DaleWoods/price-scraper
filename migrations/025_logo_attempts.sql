-- When a logo was last looked for, found or not. Logos are now fetched on
-- their own at start-up for any competitor without one; this stops a site
-- that refuses being asked again on every restart.
ALTER TABLE competitors ADD COLUMN IF NOT EXISTS logo_attempted_at TIMESTAMPTZ;
