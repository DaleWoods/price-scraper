-- Spec §5.5 asks for alerts that are "threshold-driven and configurable", with
-- three triggers. Until now there was one trigger and no threshold at all: any
-- undercut raised an alert, including a penny on a five-figure watch.
CREATE TABLE IF NOT EXISTS alert_settings (
    -- A BOOLEAN primary key fixed to TRUE makes "exactly one row, ever" a
    -- schema guarantee rather than a convention someone later breaks.
    id                     BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
    undercut_min_pct       NUMERIC(6, 2)  NOT NULL DEFAULT 0 CHECK (undercut_min_pct >= 0),
    undercut_min_abs       NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (undercut_min_abs >= 0),
    price_drop_enabled     BOOLEAN        NOT NULL DEFAULT TRUE,
    price_drop_min_pct     NUMERIC(6, 2)  NOT NULL DEFAULT 5 CHECK (price_drop_min_pct >= 0),
    listing_gone_enabled   BOOLEAN        NOT NULL DEFAULT TRUE,
    updated_at             TIMESTAMPTZ    NOT NULL DEFAULT now()
);

-- Defaults of 0 for both undercut thresholds mean behaviour is unchanged until
-- somebody deliberately sets one.
INSERT INTO alert_settings (id) VALUES (TRUE) ON CONFLICT (id) DO NOTHING;

-- The existing dedupe index covers (type, product_id, competitor_id, fascia_id)
-- WHERE state = 'open'. The two new alert types are facts about a competitor's
-- own listing rather than about one of our sites, so they carry fascia_id NULL
-- — and Postgres treats NULLs as DISTINCT in a unique index, which means that
-- index provides no dedupe for them whatsoever. Without this second index every
-- run would raise a fresh duplicate of the same still-true alert, forever.
CREATE UNIQUE INDEX IF NOT EXISTS alerts_open_no_fascia_idx
    ON alerts (type, product_id, competitor_id)
    WHERE state = 'open' AND fascia_id IS NULL;
