import { Router } from 'express';
import { query } from '../db/pool.js';
import { env } from '../config/env.js';
import { inspectRobots } from '../scraping/robots.js';
import { surveySitemaps } from '../scraping/sitemap.js';
import { buildSearchUrl, listCompetitors } from '../scraping/competitorRegistry.js';

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
/** Our own sites, for the comparison page's fascia selector. */
adminRouter.get('/fascias', async (_req, res, next) => {
  try {
    const { rows } = await query<{ code: string; name: string; currency: string; priced: number }>(
      `SELECT f.code, f.name, f.currency,
              (SELECT count(*)::int FROM fascia_prices fp WHERE fp.fascia_id = f.id) AS priced
       FROM fascias f WHERE f.enabled ORDER BY f.code`,
    );
    res.json({ fascias: rows });
  } catch (err) {
    next(err);
  }
});

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

/**
 * Report what each competitor's robots.txt permits, without scraping anything.
 *
 * A run that reports "blocked" for every source does not say whether the source
 * is unusable or merely the chosen route is. This reads the rules directly and
 * shows the search URL decision alongside the sitemaps the site publishes —
 * a sitemap being the route intended for crawlers where search is closed.
 */
export interface RobotsCheckRow {
  slug: string;
  name: string;
  enabled?: boolean;
  error?: string;
  origin?: string;
  status?: 'ok' | 'absent' | 'unreachable';
  failureDetail?: string | null;
  probe?: { url: string; allowed: boolean }[];
  crawlDelaySeconds?: number | null;
  sitemaps?: string[];
  disallowRules?: string[];
}

adminRouter.post('/robots-check', async (_req, res) => {
  try {
    const competitors = await listCompetitors();
    const results: RobotsCheckRow[] = [];

    for (const competitor of competitors) {
      const searchUrl = buildSearchUrl(competitor, 'test product');
      let origin: string;
      try {
        origin = new URL(competitor.base_url).origin;
      } catch {
        results.push({
          slug: competitor.slug,
          name: competitor.display_name,
          error: `"${competitor.base_url}" is not a valid URL`,
        });
        continue;
      }

      try {
        const inspection = await inspectRobots(origin, env.scraperUserAgent, [searchUrl]);
        results.push({
          slug: competitor.slug,
          name: competitor.display_name,
          enabled: competitor.enabled,
          ...inspection,
        });
      } catch (err) {
        results.push({
          slug: competitor.slug,
          name: competitor.display_name,
          error: (err as Error).message,
        });
      }
    }

    res.json({
      userAgent: env.scraperUserAgent,
      results,
      summary: {
        searchAllowed: results.filter((r) => r.probe?.[0]?.allowed).length,
        searchBlocked: results.filter((r) => r.probe && !r.probe[0]?.allowed).length,
        unreachable: results.filter((r) => r.status === 'unreachable').length,
        withSitemaps: results.filter((r) => (r.sitemaps?.length ?? 0) > 0).length,
      },
    });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

/**
 * Survey each competitor's sitemaps: what they declare, what those contain, and
 * a sample of the URLs. Bounded — reads the index and a few children rather
 * than walking a retailer's entire tree.
 */
export interface SitemapCheckRow {
  slug: string;
  name: string;
  error?: string | null;
  origin?: string;
  declared?: string[];
  fetched?: { url: string; ok: boolean; error: string | null; isIndex: boolean; urlCount: number }[];
  sampleUrls?: string[];
  totalUrls?: number;
}

adminRouter.post('/sitemap-check', async (_req, res) => {
  try {
    const competitors = await listCompetitors();
    const results: SitemapCheckRow[] = [];

    for (const competitor of competitors) {
      let origin: string;
      try {
        origin = new URL(competitor.base_url).origin;
      } catch {
        results.push({
          slug: competitor.slug,
          name: competitor.display_name,
          error: `"${competitor.base_url}" is not a valid URL`,
        });
        continue;
      }

      const survey = await surveySitemaps(origin, env.scraperUserAgent);
      results.push({ slug: competitor.slug, name: competitor.display_name, ...survey });
    }

    res.json({
      userAgent: env.scraperUserAgent,
      results,
      summary: {
        withUsableSitemap: results.filter((r) => (r.totalUrls ?? 0) > 0).length,
        declaringSitemaps: results.filter((r) => (r.declared?.length ?? 0) > 0).length,
        failed: results.filter((r) => r.error || (r.totalUrls ?? 0) === 0).length,
      },
    });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});
