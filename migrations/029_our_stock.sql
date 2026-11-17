-- Our own stock state, so the pages can say "Out of stock" rather than show a
-- bare dash where we have no price to compare.
--
-- A product our feed marks out of stock still gets no row in fascia_prices
-- (nothing changes for comparisons or delisting); what the feed said about it
-- is kept here instead: that it is out of stock, its price and its page.
CREATE TABLE IF NOT EXISTS fascia_out_of_stock (
  product_id     BIGINT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  fascia_id      BIGINT NOT NULL REFERENCES fascias(id) ON DELETE CASCADE,
  price          NUMERIC(12,2),
  product_url    TEXT,
  feed_import_id BIGINT,
  recorded_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (product_id, fascia_id)
);

-- What our own page said when it was read directly (NULL: not known).
ALTER TABLE fascia_prices ADD COLUMN IF NOT EXISTS in_stock BOOLEAN;
