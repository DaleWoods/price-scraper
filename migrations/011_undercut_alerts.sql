-- Undercut alerts: the alerts table has existed since 001_init.sql but nothing
-- has ever written to it. This wires it up for one alert type — a confirmed
-- competitor price dropping below ours — which is per fascia, since we charge
-- a different price at each of our own sites for the same product.
ALTER TABLE alerts
    ADD COLUMN IF NOT EXISTS fascia_id BIGINT REFERENCES fascias(id) ON DELETE CASCADE;

ALTER TABLE alerts
    ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ;

-- 'resolved' is distinct from 'acknowledged': resolved means the system found
-- the undercut no longer applies (the competitor's price rose back above ours,
-- or the match was removed); acknowledged means a person saw it and dismissed
-- it while it may still be true. Conflating the two would hide which alerts
-- are still live undercuts a person chose to leave open.
ALTER TABLE alerts
    DROP CONSTRAINT IF EXISTS alerts_state_check;
ALTER TABLE alerts
    ADD CONSTRAINT alerts_state_check CHECK (state IN ('open', 'acknowledged', 'resolved'));

-- Only one OPEN alert per (product, competitor, fascia): a run that re-observes
-- the same still-cheaper price must not create a duplicate every time it runs.
-- The partial index only covers 'open' rows, so once an alert is acknowledged
-- or resolved, a later fresh undercut is free to raise a new one.
CREATE UNIQUE INDEX IF NOT EXISTS alerts_open_undercut_idx
    ON alerts (type, product_id, competitor_id, fascia_id)
    WHERE state = 'open';

CREATE INDEX IF NOT EXISTS alerts_state_idx ON alerts (state);
