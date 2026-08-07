-- 001_init.sql — core schema for the Competitor Price Monitor (Spec §6)
--
-- Design notes:
--   * No per-website (Goldsmiths / Mappin & Webb / WoS) split anywhere — the app
--     imports a single master catalogue export (Spec §5.1).
--   * Spec attributes are stored as JSONB so the import accepts an open,
--     extensible set of fields rather than a fixed column list (Spec §5.1).
--   * Competitors are rows + JSONB config, so adding a retailer is configuration,
--     not code (Spec §5.2).

CREATE TABLE IF NOT EXISTS products (
    id              BIGSERIAL PRIMARY KEY,
    internal_sku    TEXT        NOT NULL UNIQUE,
    brand           TEXT        NOT NULL,
    product_name    TEXT        NOT NULL,
    ean_mpn         TEXT,
    our_price       NUMERIC(12, 2) NOT NULL CHECK (our_price >= 0),
    currency        TEXT        NOT NULL DEFAULT 'GBP',
    category        TEXT,
    our_product_url TEXT,
    specs           JSONB       NOT NULL DEFAULT '{}'::jsonb,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS products_brand_idx    ON products (lower(brand));
CREATE INDEX IF NOT EXISTS products_ean_idx      ON products (ean_mpn) WHERE ean_mpn IS NOT NULL;
CREATE INDEX IF NOT EXISTS products_category_idx ON products (lower(category));

CREATE TABLE IF NOT EXISTS competitors (
    id                 BIGSERIAL PRIMARY KEY,
    slug               TEXT        NOT NULL UNIQUE,
    display_name       TEXT        NOT NULL,
    base_url           TEXT        NOT NULL,
    search_url_pattern TEXT        NOT NULL,
    brands             TEXT[]      NOT NULL DEFAULT '{}',
    enabled            BOOLEAN     NOT NULL DEFAULT TRUE,
    scrape_frequency   TEXT        NOT NULL DEFAULT 'daily',
    config             JSONB       NOT NULL DEFAULT '{}'::jsonb,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ProductMatch: our product <-> a competitor listing URL, with confidence and
-- a confirm/reject state. Confirmed rows are what the scraper hits directly.
CREATE TABLE IF NOT EXISTS product_matches (
    id               BIGSERIAL PRIMARY KEY,
    product_id       BIGINT      NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    competitor_id    BIGINT      NOT NULL REFERENCES competitors(id) ON DELETE CASCADE,
    competitor_url   TEXT        NOT NULL,
    competitor_title TEXT,
    competitor_ean   TEXT,
    confidence       INTEGER     NOT NULL DEFAULT 0 CHECK (confidence BETWEEN 0 AND 100),
    match_tier       TEXT        NOT NULL DEFAULT 'fuzzy_name_specs',
    status           TEXT        NOT NULL DEFAULT 'pending'
                                 CHECK (status IN ('pending', 'confirmed', 'rejected')),
    evidence         JSONB       NOT NULL DEFAULT '{}'::jsonb,
    confirmed_at     TIMESTAMPTZ,
    confirmed_by     TEXT,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (product_id, competitor_id, competitor_url)
);

CREATE INDEX IF NOT EXISTS product_matches_status_idx  ON product_matches (status);
CREATE INDEX IF NOT EXISTS product_matches_product_idx ON product_matches (product_id);

-- Only one confirmed listing per product per competitor.
CREATE UNIQUE INDEX IF NOT EXISTS product_matches_one_confirmed_idx
    ON product_matches (product_id, competitor_id)
    WHERE status = 'confirmed';

CREATE TABLE IF NOT EXISTS scrape_runs (
    id            BIGSERIAL PRIMARY KEY,
    trigger       TEXT        NOT NULL DEFAULT 'manual',
    status        TEXT        NOT NULL DEFAULT 'running'
                              CHECK (status IN ('running', 'completed', 'failed')),
    competitor_id BIGINT      REFERENCES competitors(id) ON DELETE SET NULL,
    ok_count      INTEGER     NOT NULL DEFAULT 0,
    error_count   INTEGER     NOT NULL DEFAULT 0,
    skipped_count INTEGER     NOT NULL DEFAULT 0,
    error         TEXT,
    started_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at   TIMESTAMPTZ
);

-- Per-target outcome of a run. A layout change surfaces here as an error row,
-- never as a silently wrong price (Spec §5.4).
CREATE TABLE IF NOT EXISTS scrape_run_items (
    id            BIGSERIAL PRIMARY KEY,
    run_id        BIGINT      NOT NULL REFERENCES scrape_runs(id) ON DELETE CASCADE,
    match_id      BIGINT      REFERENCES product_matches(id) ON DELETE SET NULL,
    product_id    BIGINT      REFERENCES products(id) ON DELETE SET NULL,
    competitor_id BIGINT      REFERENCES competitors(id) ON DELETE SET NULL,
    url           TEXT,
    status        TEXT        NOT NULL CHECK (status IN ('ok', 'error', 'skipped')),
    error_kind    TEXT,
    error         TEXT,
    duration_ms   INTEGER,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS scrape_run_items_run_idx ON scrape_run_items (run_id);

CREATE TABLE IF NOT EXISTS price_observations (
    id                BIGSERIAL PRIMARY KEY,
    product_id        BIGINT      NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    competitor_id     BIGINT      NOT NULL REFERENCES competitors(id) ON DELETE CASCADE,
    match_id          BIGINT      REFERENCES product_matches(id) ON DELETE SET NULL,
    scrape_run_id     BIGINT      REFERENCES scrape_runs(id) ON DELETE SET NULL,
    price             NUMERIC(12, 2) CHECK (price >= 0),
    was_price         NUMERIC(12, 2) CHECK (was_price >= 0),
    currency          TEXT        NOT NULL DEFAULT 'GBP',
    promo             BOOLEAN     NOT NULL DEFAULT FALSE,
    in_stock          BOOLEAN,
    availability_text TEXT,
    source_url        TEXT        NOT NULL,
    observed_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS price_observations_latest_idx
    ON price_observations (product_id, competitor_id, observed_at DESC);

CREATE TABLE IF NOT EXISTS alerts (
    id              BIGSERIAL PRIMARY KEY,
    type            TEXT        NOT NULL,
    product_id      BIGINT      REFERENCES products(id) ON DELETE CASCADE,
    competitor_id   BIGINT      REFERENCES competitors(id) ON DELETE CASCADE,
    delta_abs       NUMERIC(12, 2),
    delta_pct       NUMERIC(7, 2),
    message         TEXT        NOT NULL,
    state           TEXT        NOT NULL DEFAULT 'open'
                                CHECK (state IN ('open', 'acknowledged')),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    acknowledged_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS users (
    id            BIGSERIAL PRIMARY KEY,
    email         TEXT        NOT NULL UNIQUE,
    display_name  TEXT,
    role          TEXT        NOT NULL DEFAULT 'viewer'
                              CHECK (role IN ('admin', 'trader', 'viewer')),
    password_hash TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
