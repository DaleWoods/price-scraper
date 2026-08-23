import { Router } from 'express';
import { query } from '../db/pool.js';

export const alertsRouter: Router = Router();

/**
 * Undercut alerts. Open by default, since that is the actionable state — the
 * badge in the sidebar counts the same query.
 */
alertsRouter.get('/', async (req, res, next) => {
  try {
    const state = typeof req.query.state === 'string' ? req.query.state : 'open';
    if (!['open', 'acknowledged', 'resolved', 'all'].includes(state)) {
      res.status(400).json({ error: 'state must be one of open, acknowledged, resolved, all' });
      return;
    }

    const limit = Math.min(Number.parseInt(String(req.query.limit ?? '100'), 10) || 100, 500);
    const params: unknown[] = [];
    let where = '';
    if (state !== 'all') {
      params.push(state);
      where = 'WHERE a.state = $1';
    }

    const { rows } = await query(
      `SELECT a.*, count(*) OVER () AS total_count,
              p.internal_sku, p.product_name, p.delisted_at,
              c.display_name AS competitor_name, c.slug AS competitor_slug,
              (c.logo_data IS NOT NULL) AS competitor_has_logo,
              f.name AS fascia_name, f.code AS fascia_code
       FROM alerts a
       JOIN products    p ON p.id = a.product_id
       JOIN competitors c ON c.id = a.competitor_id
       LEFT JOIN fascias f ON f.id = a.fascia_id
       ${where}
       ORDER BY a.created_at DESC
       LIMIT ${limit}`,
      params,
    );

    res.json({ alerts: rows, total: rows[0]?.total_count ?? 0 });
  } catch (err) {
    next(err);
  }
});

alertsRouter.post('/:id/acknowledge', async (req, res, next) => {
  try {
    const id = Number.parseInt(req.params.id ?? '', 10);
    if (!Number.isFinite(id)) {
      res.status(400).json({ error: 'Invalid alert id' });
      return;
    }

    const { rows } = await query(
      `UPDATE alerts SET state = 'acknowledged', acknowledged_at = now()
       WHERE id = $1 AND state = 'open'
       RETURNING *`,
      [id],
    );
    if (!rows[0]) {
      res.status(404).json({ error: 'No open alert with that id' });
      return;
    }
    res.json({ alert: rows[0] });
  } catch (err) {
    next(err);
  }
});

/** Acknowledge every currently open alert in one action. */
alertsRouter.post('/acknowledge-all', async (_req, res, next) => {
  try {
    const { rows } = await query(
      `UPDATE alerts SET state = 'acknowledged', acknowledged_at = now()
       WHERE state = 'open'
       RETURNING id`,
    );
    res.json({ acknowledged: rows.length });
  } catch (err) {
    next(err);
  }
});
