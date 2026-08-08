-- Competitor logos.
--
-- The bytes are cached in our own database rather than hotlinked from the
-- competitor's site at render time. Two reasons: the dashboard keeps working
-- without egress to those domains, and — for a tool whose whole purpose is
-- watching these retailers — hotlinking would announce a visit to every one of
-- them each time the page is opened.

ALTER TABLE competitors
    ADD COLUMN IF NOT EXISTS logo_url          TEXT,
    ADD COLUMN IF NOT EXISTS logo_data         BYTEA,
    ADD COLUMN IF NOT EXISTS logo_content_type TEXT,
    ADD COLUMN IF NOT EXISTS logo_fetched_at   TIMESTAMPTZ,
    -- Why the last attempt failed, so the UI can explain a missing logo
    -- instead of silently showing the fallback.
    ADD COLUMN IF NOT EXISTS logo_error        TEXT;
