import { Router } from 'express';
import { query } from '../db/pool.js';
import {
  getCompetitorBySlug,
  listCompetitors,
  syncCompetitorsToDatabase,
} from '../scraping/competitorRegistry.js';
import { ScrapeError } from '../scraping/errors.js';
import { extractListing } from '../scraping/extract.js';
import { fetchPage } from '../scraping/fetcher.js';
import { checkRobots } from '../scraping/robots.js';
import { env } from '../config/env.js';

export const competitorsRouter: Router = Router();

competitorsRouter.get('/', async (_req, res, next) => {
  try {
    res.json({ competitors: await listCompetitors() });
  } catch (err) {
    next(err);
  }
});

/** Re-read competitors/*.json — how a newly added retailer enters the app. */
competitorsRouter.post('/sync', async (_req, res) => {
  try {
    res.json({ synced: await syncCompetitorsToDatabase() });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

competitorsRouter.patch('/:slug', async (req, res, next) => {
  try {
    const enabled = req.body?.enabled;
    if (typeof enabled !== 'boolean') {
      res.status(400).json({ error: 'Only the "enabled" flag can be toggled here; edit the JSON config for anything else.' });
      return;
    }

    const { rows } = await query(
      `UPDATE competitors SET enabled = $2, updated_at = now() WHERE slug = $1 RETURNING *`,
      [req.params.slug, enabled],
    );
    if (!rows[0]) {
      res.status(404).json({ error: 'Competitor not found' });
      return;
    }
    res.json({ competitor: rows[0] });
  } catch (err) {
    next(err);
  }
});

/**
 * Dry-run one URL through the real extraction path and show exactly what was
 * parsed. Nothing is written. This is how selectors get tuned against a live
 * site without editing code or polluting the observation history.
 */
competitorsRouter.post('/:slug/test-url', async (req, res) => {
  const url = typeof req.body?.url === 'string' ? req.body.url.trim() : '';
  try {
    const competitor = await getCompetitorBySlug(req.params.slug ?? '');
    if (!competitor) {
      res.status(404).json({ error: 'Competitor not found' });
      return;
    }
    if (!url) {
      res.status(400).json({ error: 'A url is required' });
      return;
    }

    const robots = await checkRobots(url, competitor.config.userAgent ?? env.scraperUserAgent);
    const page = await fetchPage(competitor, url);
    const listing = extractListing(competitor, page);

    res.json({
      ok: true,
      robots,
      finalUrl: page.finalUrl,
      renderedWith: page.renderedWith,
      extracted: listing,
    });
  } catch (err) {
    if (err instanceof ScrapeError) {
      res.status(422).json({ ok: false, kind: err.kind, error: err.message, url });
      return;
    }
    res.status(500).json({ ok: false, kind: 'unknown', error: (err as Error).message, url });
  }
});
