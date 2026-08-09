-- Product URLs harvested from each competitor's sitemaps.
--
-- Every competitor disallows /search in robots.txt, so on-site search cannot be
-- used to find their listing for one of our products. A sitemap is published
-- for crawlers and lists the product pages directly, so it becomes the
-- discovery source instead. Fetching each page is still checked against
-- robots.txt at the time of the request.
--
-- Cached because a sitemap is large and changes slowly: walking it once per run
-- rather than once per product is the difference between one request and
-- thousands.

CREATE TABLE IF NOT EXISTS competitor_urls (
    id            BIGSERIAL   PRIMARY KEY,
    competitor_id BIGINT      NOT NULL REFERENCES competitors(id) ON DELETE CASCADE,
    url           TEXT        NOT NULL,
    -- The URL path reduced to words, which is what candidate selection searches.
    -- Retailers put the product name in the slug, so this is a usable index of
    -- what they sell without fetching a single product page.
    slug          TEXT        NOT NULL,
    lastmod       TIMESTAMPTZ,
    first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (competitor_id, url)
);

CREATE INDEX IF NOT EXISTS competitor_urls_competitor_idx ON competitor_urls (competitor_id);

-- Built-in full-text search rather than pg_trgm: no extension to enable, which
-- matters where the database is managed and CREATE EXTENSION may not be granted.
CREATE INDEX IF NOT EXISTS competitor_urls_slug_fts_idx
    ON competitor_urls USING GIN (to_tsvector('simple', slug));
