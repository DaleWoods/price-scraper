-- A history for our own prices, which until now had none.
--
-- Competitor prices accumulate in price_observations, but ours were only ever
-- overwritten: a feed import replaces the fascia_prices row and the old value
-- is gone. That makes the obvious question — "did they drop their price, or
-- did we raise ours?" — unanswerable, and a report that can only describe one
-- side of a comparison is half a report.
--
-- Written by a trigger rather than by the importer, so a price changed by any
-- route is recorded. The importer is the only writer today, but "remember to
-- also write history" is exactly the kind of instruction that gets missed when
-- a second one appears.
CREATE TABLE IF NOT EXISTS fascia_price_history (
  id             BIGSERIAL PRIMARY KEY,
  product_id     BIGINT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  fascia_id      BIGINT NOT NULL REFERENCES fascias(id) ON DELETE CASCADE,
  price          NUMERIC(12,2),
  previous_price NUMERIC(12,2),
  recorded_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS fascia_price_history_recent_idx
  ON fascia_price_history (recorded_at DESC);

CREATE INDEX IF NOT EXISTS fascia_price_history_product_idx
  ON fascia_price_history (product_id, fascia_id, recorded_at DESC);

CREATE OR REPLACE FUNCTION record_fascia_price_change() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- A baseline, so the first price we ever held for a product is on the
    -- record rather than appearing from nowhere at its first change.
    INSERT INTO fascia_price_history (product_id, fascia_id, price, previous_price)
    VALUES (NEW.product_id, NEW.fascia_id, NEW.price, NULL);
  -- IS DISTINCT FROM, not <>: price is nullable (price_visible=FALSE publishes
  -- no price), and a NULL never equals a NULL, so <> would silently miss both
  -- a price disappearing and one appearing.
  ELSIF NEW.price IS DISTINCT FROM OLD.price THEN
    INSERT INTO fascia_price_history (product_id, fascia_id, price, previous_price)
    VALUES (NEW.product_id, NEW.fascia_id, NEW.price, OLD.price);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS fascia_prices_history ON fascia_prices;
CREATE TRIGGER fascia_prices_history
  AFTER INSERT OR UPDATE ON fascia_prices
  FOR EACH ROW EXECUTE FUNCTION record_fascia_price_change();
