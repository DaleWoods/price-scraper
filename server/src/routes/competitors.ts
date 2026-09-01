import { Router, type RequestHandler } from 'express';
import multer from 'multer';
import { query } from '../db/pool.js';
import {
  getCompetitorBySlug,
  listCompetitors,
  syncCompetitorsToDatabase,
} from '../scraping/competitorRegistry.js';
import { ScrapeError } from '../scraping/errors.js';
import { fetchAndExtract } from '../scraping/fetchAndExtract.js';
import { checkRobots } from '../scraping/robots.js';
import { env } from '../config/env.js';
import {
  MAX_UPLOAD_BYTES,
  clearLogo,
  refreshAllLogos,
  setUploadedLogo,
} from '../competitors/logos.js';

export const competitorsRouter: Router = Router();

const logoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
});

/**
 * Multer's own limit message is just "File too large", which does not say what
 * the limit is. Translate it into something the person uploading can act on.
 */
const uploadLogoFile: RequestHandler = (req, res, next) => {
  logoUpload.single('file')(req, res, (err: unknown) => {
    if (err instanceof multer.MulterError) {
      const message =
        err.code === 'LIMIT_FILE_SIZE'
          ? `That file is larger than the ${MAX_UPLOAD_BYTES / 1024 / 1024}MB limit. A logo should be a few KB.`
          : err.message;
      res.status(400).json({ error: message });
      return;
    }
    next(err);
  });
};

competitorsRouter.get('/', async (_req, res, next) => {
  try {
    res.json({ competitors: await listCompetitors() });
  } catch (err) {
    next(err);
  }
});

/**
 * Serve a cached competitor logo from our own origin.
 *
 * A 404 here is a normal outcome, not an error: the UI falls back to a
 * monogram badge, so a competitor with no reachable favicon still gets a mark
 * next to its name.
 */
competitorsRouter.get('/:slug/logo', async (req, res, next) => {
  try {
    const { rows } = await query<{ logo_data: Buffer | null; logo_content_type: string | null }>(
      'SELECT logo_data, logo_content_type FROM competitors WHERE slug = $1',
      [req.params.slug],
    );
    const logo = rows[0];
    if (!logo?.logo_data) {
      res.status(404).json({ error: 'No logo cached for this competitor.' });
      return;
    }
    res.setHeader('Content-Type', logo.logo_content_type ?? 'image/x-icon');
    // These bytes can be user-supplied, and an SVG is an active document: were
    // someone to open this URL directly, script inside it would run on our
    // origin. Locking the response down to no subresources and no sniffing
    // keeps it an image wherever it is opened.
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // Logos change rarely, but not never — revalidate rather than pinning a day.
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('ETag', `W/"${logo.logo_data.length}-${req.params.slug}"`);
    res.send(logo.logo_data);
  } catch (err) {
    next(err);
  }
});

/**
 * Fetch logos for competitors that do not have one yet (`?force=1` re-fetches
 * all). Requires egress to the competitor domains.
 */
competitorsRouter.post('/refresh-logos', async (req, res) => {
  try {
    const results = await refreshAllLogos(req.query.force === '1');
    res.json({
      results,
      fetched: results.filter((r) => r.status === 'fetched').length,
      failed: results.filter((r) => r.status === 'failed').length,
      unchanged: results.filter((r) => r.status === 'unchanged').length,
    });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

/**
 * Upload a logo by hand. This is the path that does not need egress: fetch the
 * image yourself and put it in directly.
 */
competitorsRouter.post('/:slug/logo', uploadLogoFile, async (req, res) => {
  try {
    if (!req.file) {
      res.status(400).json({ error: 'No file uploaded. Attach an image as "file".' });
      return;
    }
    const stored = await setUploadedLogo(req.params.slug!, req.file.buffer, req.file.originalname);
    res.json({ slug: req.params.slug, ...stored });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

/** Remove a logo, returning the competitor to its monogram badge. */
competitorsRouter.delete('/:slug/logo', async (req, res) => {
  try {
    await clearLogo(req.params.slug!);
    res.json({ slug: req.params.slug, cleared: true });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
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
    const { page, listing, escalated } = await fetchAndExtract(competitor, url);

    res.json({
      ok: true,
      robots,
      finalUrl: page.finalUrl,
      renderedWith: page.renderedWith,
      // True when a plain HTTP fetch was tried first and turned out unusable.
      // Worth seeing here: a competitor that always escalates is one to pin to
      // 'browser' explicitly rather than pay for the failed attempt every time.
      escalated,
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
