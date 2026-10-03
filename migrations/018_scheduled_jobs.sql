-- When each scheduled job last ran, so a restart neither repeats nor skips it.
--
-- The state has to outlive the process. An in-memory "last run" is lost on
-- every deploy and every container recycle, which on a nightly job means
-- either running twice or not at all, and neither is visible until someone
-- notices the prices are a day old.
CREATE TABLE IF NOT EXISTS scheduled_jobs (
  name              TEXT PRIMARY KEY,
  last_run_at       TIMESTAMPTZ,
  last_status       TEXT,
  last_detail       TEXT,
  last_duration_ms  INTEGER,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
