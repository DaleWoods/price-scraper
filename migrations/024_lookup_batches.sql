-- A list of products checked together, from an uploaded file on the Check
-- prices page. Finding each product can mean reading it from our own website,
-- which takes a moment per product, so the work happens in the background and
-- the page follows its progress here.
CREATE TABLE IF NOT EXISTS lookup_batches (
  id           BIGSERIAL PRIMARY KEY,
  file_name    TEXT,
  -- finding: working out which of our products each value is.
  -- checking: the competitor check is running.
  -- done / failed: finished.
  status       TEXT NOT NULL DEFAULT 'finding'
                 CHECK (status IN ('finding', 'checking', 'done', 'failed')),
  input_values TEXT[] NOT NULL,
  -- How many values have been looked at so far, for progress while finding.
  processed    INTEGER NOT NULL DEFAULT 0,
  product_ids  BIGINT[] NOT NULL DEFAULT '{}',
  unresolved   TEXT[] NOT NULL DEFAULT '{}',
  run_id       BIGINT REFERENCES scrape_runs(id) ON DELETE SET NULL,
  message      TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
