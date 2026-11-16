-- Our own product addresses, so a product can be found by its manufacturer
-- reference alone. Goldsmiths, Mappin & Webb and Watches of Switzerland put the
-- reference in the address ("…-Mens-Watch-O21030422004001/p/17331581"), so
-- someone typing "O21030422004001" or "210.30.42.20.04.001" can be taken
-- straight to the product without its SKU. Rebuilt from our sitemaps when more
-- than a day old.
CREATE TABLE IF NOT EXISTS own_site_urls (
  url          TEXT PRIMARY KEY,
  fascia_code  TEXT NOT NULL,
  sku          TEXT NOT NULL,
  -- The address's letters and digits only, lower-cased: what a reference is
  -- searched for in.
  path_key     TEXT NOT NULL,
  seen_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS own_site_urls_sku_idx ON own_site_urls (sku);
