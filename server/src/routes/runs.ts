import { Router } from 'express';
import { query } from '../db/pool.js';
import { getActiveRunId, startRun, type RunMode } from '../scraping/runner.js';

export const runsRouter: Router = Router();

runsRouter.get('/', async (_req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT r.*, c.display_name AS competitor_name
       FROM scrape_runs r
       LEFT JOIN competitors c ON c.id = r.competitor_id
       ORDER BY r.started_at DESC
       LIMIT 25`,
    );
    res.json({ runs: rows, activeRunId: getActiveRunId() });
  } catch (err) {
    next(err);
  }
});

/** Manual "run now" trigger — MVP has no scheduler. */
runsRouter.post('/', async (req, res) => {
  try {
    const mode = (req.body?.mode ?? 'both') as RunMode;
    if (!['prices', 'discover', 'both'].includes(mode)) {
      res.status(400).json({ error: 'mode must be one of prices, discover, both' });
      return;
    }

    const competitorId = req.body?.competitorId ? Number(req.body.competitorId) : null;
    const limit = req.body?.limit ? Number(req.body.limit) : null;

    const run = await startRun({ mode, competitorId, limit, trigger: 'manual' });
    res.status(202).json({ run });
  } catch (err) {
    res.status(409).json({ error: (err as Error).message });
  }
});

runsRouter.get('/:id', async (req, res, next) => {
  try {
    const id = Number.parseInt(req.params.id ?? '', 10);
    const [{ rows: runRows }, { rows: items }] = await Promise.all([
      query('SELECT * FROM scrape_runs WHERE id = $1', [id]),
      query(
        `SELECT i.*, p.internal_sku, p.product_name, c.display_name AS competitor_name
         FROM scrape_run_items i
         LEFT JOIN products p    ON p.id = i.product_id
         LEFT JOIN competitors c ON c.id = i.competitor_id
         WHERE i.run_id = $1
         ORDER BY (i.status = 'error') DESC, i.id
         LIMIT 500`,
        [id],
      ),
    ]);

    if (!runRows[0]) {
      res.status(404).json({ error: 'Run not found' });
      return;
    }
    res.json({ run: runRows[0], items });
  } catch (err) {
    next(err);
  }
});

/** Recent scrape failures across all runs — the "fail loudly" surface (Spec §5.4). */
runsRouter.get('/errors/recent', async (_req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT i.id, i.run_id, i.url, i.error_kind, i.error, i.created_at,
              p.internal_sku, p.product_name, c.display_name AS competitor_name
       FROM scrape_run_items i
       LEFT JOIN products p    ON p.id = i.product_id
       LEFT JOIN competitors c ON c.id = i.competitor_id
       WHERE i.status = 'error'
       ORDER BY i.created_at DESC
       LIMIT 100`,
    );
    res.json({ errors: rows });
  } catch (err) {
    next(err);
  }
});
