import { Router } from 'express';
import { query } from '../db/pool.js';
import { getActiveRunId, startRun, type RunMode } from '../scraping/runner.js';

export const runsRouter: Router = Router();

runsRouter.get('/', async (_req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT r.*, c.display_name AS competitor_name,
              p.internal_sku AS product_sku, p.product_name
       FROM scrape_runs r
       LEFT JOIN competitors c ON c.id = r.competitor_id
       LEFT JOIN products p    ON p.id = r.product_id
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

    // A run can be aimed at one product, by id or by the SKU you actually have
    // to hand. Resolving the SKU here means an unknown one fails immediately
    // with a useful message, rather than starting a run that scans nothing.
    let productId = req.body?.productId ? Number(req.body.productId) : null;
    const sku = typeof req.body?.sku === 'string' ? req.body.sku.trim() : '';
    if (!productId && sku) {
      const { rows } = await query<{ id: number }>(
        'SELECT id FROM products WHERE lower(internal_sku) = lower($1)',
        [sku],
      );
      if (!rows[0]) {
        res.status(404).json({ error: `No product with SKU "${sku}". Import its feed first.` });
        return;
      }
      productId = rows[0].id;
    }

    const forceHarvest = req.body?.forceHarvest === true;

    const run = await startRun({ mode, competitorId, limit, productId, forceHarvest, trigger: 'manual' });
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
/**
 * Delete a run and its per-target detail.
 *
 * Price observations survive: they reference the run with ON DELETE SET NULL,
 * so clearing out noisy runs never destroys price history. A run still in
 * flight is refused rather than pulled out from under the runner.
 */
runsRouter.delete('/:id', async (req, res) => {
  try {
    const id = Number.parseInt(req.params.id ?? '', 10);
    if (!Number.isFinite(id)) {
      res.status(400).json({ error: 'Invalid run id' });
      return;
    }
    if (getActiveRunId() === id) {
      res.status(409).json({ error: 'That run is still in progress. Wait for it to finish first.' });
      return;
    }

    const { rows } = await query<{ id: number; observations: number }>(
      `WITH kept AS (
         SELECT count(*)::int AS observations FROM price_observations WHERE scrape_run_id = $1
       ), gone AS (
         DELETE FROM scrape_runs WHERE id = $1 RETURNING id
       )
       SELECT gone.id, kept.observations FROM gone, kept`,
      [id],
    );
    if (!rows[0]) {
      res.status(404).json({ error: 'Run not found' });
      return;
    }
    res.json({ deleted: rows[0].id, observationsKept: rows[0].observations });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

/** Clear every run that is not still going. Price observations are untouched. */
runsRouter.delete('/', async (_req, res) => {
  try {
    const activeId = getActiveRunId();
    const { rows } = await query<{ id: number }>(
      `DELETE FROM scrape_runs
       WHERE status <> 'running' AND ($1::bigint IS NULL OR id <> $1)
       RETURNING id`,
      [activeId],
    );
    res.json({ deleted: rows.length, skippedRunning: activeId !== null });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

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
