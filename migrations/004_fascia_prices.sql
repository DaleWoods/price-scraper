-- Per-fascia pricing from the SAP price loadsheet.
--
-- The same product can carry a different price at each of our own fascias, so a
-- single price on the product cannot represent it. These tables hold one
-- resolved selling price per (product, fascia), together with enough provenance
-- to answer "why is Goldsmiths showing £445?" without re-reading the loadsheet.

CREATE TABLE IF NOT EXISTS fascias (
    id         BIGSERIAL   PRIMARY KEY,
    -- SAP store/plant code ('werks'), which for our own sites identifies the
    -- fascia rather than a physical shop.
    code       TEXT        NOT NULL UNIQUE,
    name       TEXT        NOT NULL,
    -- SAP sales organisation ('vkorg'). GS01 is the UK.
    sales_org  TEXT        NOT NULL,
    currency   TEXT        NOT NULL DEFAULT 'GBP',
    enabled    BOOLEAN     NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The three UK websites. Adding a fascia is a row here, not a code change.
INSERT INTO fascias (code, name, sales_org, currency) VALUES
    ('197', 'Goldsmiths',             'GS01', 'GBP'),
    ('439', 'Mappin & Webb',          'GS01', 'GBP'),
    ('470', 'Watches of Switzerland', 'GS01', 'GBP')
ON CONFLICT (code) DO NOTHING;

CREATE TABLE IF NOT EXISTS fascia_prices (
    id             BIGSERIAL   PRIMARY KEY,
    product_id     BIGINT      NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    fascia_id      BIGINT      NOT NULL REFERENCES fascias(id)  ON DELETE CASCADE,
    -- What a customer would actually pay: the sale price where one applies and
    -- is genuinely cheaper, otherwise the regular price. Gross (VAT inclusive),
    -- so it is directly comparable with competitor website prices.
    price          NUMERIC(12, 2) NOT NULL,
    -- The regular price when `price` is a discount, for the struck-through
    -- "was" figure. NULL when the product is not on sale.
    regular_price  NUMERIC(12, 2),
    on_sale        BOOLEAN     NOT NULL DEFAULT FALSE,
    currency       TEXT        NOT NULL DEFAULT 'GBP',
    -- Provenance: which loadsheet row won, so a surprising price is traceable.
    source_kschl   TEXT,
    source_werks   TEXT,
    valid_from     TIMESTAMPTZ,
    valid_to       TIMESTAMPTZ,
    imported_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (product_id, fascia_id)
);

CREATE INDEX IF NOT EXISTS idx_fascia_prices_product ON fascia_prices (product_id);
CREATE INDEX IF NOT EXISTS idx_fascia_prices_fascia  ON fascia_prices (fascia_id);
