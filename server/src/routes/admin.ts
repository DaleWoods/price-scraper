import { Router } from 'express';
import { query } from '../db/pool.js';

export const adminRouter: Router = Router();

export interface SystemStatus {
  catalogue: {
    products: number;
    withPrice: number;
    awaitingPrice: number;
    brands: number;
    lastImportedAt: string | null;
  };
  competitors: { total: number; enabled: number; withLogo: number };
  matching: { confirmed: number; pending: number; rejected: number; productsMatched: number };
  observations: { total: number; lastObservedAt: string | null };
  runs: { total: number; lastRunAt: string | null; lastRunStatus: string | null };
  schema: { migrations: string[]; appliedAt: string | null };
}

/**
 * A read-only picture of what is actually in the system.
 *
 * Deliberately all counts and timestamps: this page is for answering "is the
 * data what I think it is" before trusting a comparison, so nothing here
 * changes state.
 */
adminRouter.get('/status', async (_req, res, next) => {
  try {
    const [catalogue, competitors, matching, observations, runs, schema] = await Promise.all([
      query<{
        products: number;
        with_price: number;
        brands: number;
        last_imported_at: string | null;
      }>(
        `SELECT count(*)::int                                      AS products,
                count(our_price)::int                              AS with_price,
                count(DISTINCT lower(brand))::int                  AS brands,
                max(updated_at)::text                              AS last_imported_at
         FROM products`,
      ),
      query<{ total: number; enabled: number; with_logo: number }>(
        `SELECT count(*)::int                                      AS total,
                count(*) FILTER (WHERE enabled)::int               AS enabled,
                count(logo_data)::int                              AS with_logo
         FROM competitors`,
      ),
      query<{ confirmed: number; pending: number; rejected: number; products_matched: number }>(
        `SELECT count(*) FILTER (WHERE status = 'confirmed')::int  AS confirmed,
                count(*) FILTER (WHERE status = 'pending')::int    AS pending,
                count(*) FILTER (WHERE status = 'rejected')::int   AS rejected,
                count(DISTINCT product_id) FILTER (WHERE status = 'confirmed')::int
                                                                   AS products_matched
         FROM product_matches`,
      ),
      query<{ total: number; last_observed_at: string | null }>(
        `SELECT count(*)::int AS total, max(observed_at)::text AS last_observed_at
         FROM price_observations`,
      ),
      query<{ total: number; last_run_at: string | null; last_run_status: string | null }>(
        `SELECT count(*)::int AS total,
                max(started_at)::text AS last_run_at,
                (SELECT status FROM scrape_runs ORDER BY started_at DESC LIMIT 1)
                  AS last_run_status
         FROM scrape_runs`,
      ),
      query<{ filename: string; applied_at: string }>(
        'SELECT filename, applied_at::text FROM schema_migrations ORDER BY filename',
      ),
    ]);

    const c = catalogue.rows[0]!;
    const comp = competitors.rows[0]!;
    const m = matching.rows[0]!;
    const o = observations.rows[0]!;
    const r = runs.rows[0]!;

    const status: SystemStatus = {
      catalogue: {
        products: c.products,
        withPrice: c.with_price,
        awaitingPrice: c.products - c.with_price,
        brands: c.brands,
        lastImportedAt: c.last_imported_at,
      },
      competitors: { total: comp.total, enabled: comp.enabled, withLogo: comp.with_logo },
      matching: {
        confirmed: m.confirmed,
        pending: m.pending,
        rejected: m.rejected,
        productsMatched: m.products_matched,
      },
      observations: { total: o.total, lastObservedAt: o.last_observed_at },
      runs: { total: r.total, lastRunAt: r.last_run_at, lastRunStatus: r.last_run_status },
      schema: {
        migrations: schema.rows.map((row) => row.filename),
        appliedAt: schema.rows.at(-1)?.applied_at ?? null,
      },
    };

    res.json(status);
  } catch (err) {
    next(err);
  }
});
