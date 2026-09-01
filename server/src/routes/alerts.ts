import { Router } from 'express';
import { query } from '../db/pool.js';
import { getAlertSettings, updateAlertSettings } from '../services/alertSettings.js';

export const alertsRouter: Router = Router();

/** The alert types this app raises (Spec §5.5). */
const ALERT_TYPES = ['undercut', 'price_drop', 'listing_gone'];

/**
 * Alerts. Open by default, since that is the actionable state — the badge in
 * the sidebar counts the same query.
 */
alertsRouter.get('/', async (req, res, next) => {
  try {
    const state = typeof req.query.state === 'string' ? req.query.state : 'open';
    if (!['open', 'acknowledged', 'resolved', 'all'].includes(state)) {
      res.status(400).json({ error: 'state must be one of open, acknowledged, resolved, all' });
      return;
    }

    const type = typeof req.query.type === 'string' ? req.query.type : 'all';
    if (type !== 'all' && !ALERT_TYPES.includes(type)) {
      res.status(400).json({ error: `type must be one of ${ALERT_TYPES.join(', ')}, all` });
      return;
    }

    const limit = Math.min(Number.parseInt(String(req.query.limit ?? '100'), 10) || 100, 500);
    const params: unknown[] = [];
    const conditions: string[] = [];
    if (state !== 'all') {
      params.push(state);
      conditions.push(`a.state = $${params.length}`);
    }
    if (type !== 'all') {
      params.push(type);
      conditions.push(`a.type = $${params.length}`);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

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

/* ---------- thresholds (Spec §5.5) --------------------------------------- */

alertsRouter.get('/settings', async (_req, res, next) => {
  try {
    res.json(await getAlertSettings());
  } catch (err) {
    next(err);
  }
});

/**
 * Update the thresholds. Validated field by field so a bad value names itself
 * rather than failing as a database constraint violation.
 */
alertsRouter.put('/settings', async (req, res) => {
  try {
    const body = req.body ?? {};
    const patch: Record<string, number | boolean> = {};

    const percentFields = ['undercutMinPct', 'priceDropMinPct'] as const;
    for (const field of percentFields) {
      if (body[field] === undefined || body[field] === null) continue;
      const value = Number(body[field]);
      if (!Number.isFinite(value) || value < 0 || value > 100) {
        res.status(400).json({ error: `${field} must be a percentage between 0 and 100.` });
        return;
      }
      patch[field] = value;
    }

    if (body.undercutMinAbs !== undefined && body.undercutMinAbs !== null) {
      const value = Number(body.undercutMinAbs);
      if (!Number.isFinite(value) || value < 0) {
        res.status(400).json({ error: 'undercutMinAbs must be zero or a positive amount.' });
        return;
      }
      patch.undercutMinAbs = value;
    }

    for (const field of ['priceDropEnabled', 'listingGoneEnabled'] as const) {
      if (body[field] === undefined || body[field] === null) continue;
      if (typeof body[field] !== 'boolean') {
        res.status(400).json({ error: `${field} must be true or false.` });
        return;
      }
      patch[field] = body[field];
    }

    res.json(await updateAlertSettings(patch));
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
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
