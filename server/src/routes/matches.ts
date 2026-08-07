import { Router } from 'express';
import { query } from '../db/pool.js';
import type { Product } from '../domain/types.js';
import { scoreCandidate } from '../matching/score.js';
import { getCompetitorById } from '../scraping/competitorRegistry.js';
import { extractListing } from '../scraping/extract.js';
import { fetchPage } from '../scraping/fetcher.js';
import { ScrapeError } from '../scraping/errors.js';

export const matchesRouter: Router = Router();

/** The manual review queue (Spec §5.3). */
matchesRouter.get('/', async (req, res, next) => {
  try {
    const status = typeof req.query.status === 'string' ? req.query.status : 'pending';
    if (!['pending', 'confirmed', 'rejected', 'all'].includes(status)) {
      res.status(400).json({ error: 'status must be one of pending, confirmed, rejected, all' });
      return;
    }

    const limit = Math.min(Number.parseInt(String(req.query.limit ?? '100'), 10) || 100, 500);
    const params: unknown[] = [];
    let where = '';
    if (status !== 'all') {
      params.push(status);
      where = 'WHERE m.status = $1';
    }

    const { rows } = await query(
      `SELECT m.*, count(*) OVER () AS total_count,
              p.internal_sku, p.brand, p.product_name, p.our_price, p.currency,
              p.category, p.ean_mpn, p.specs, p.our_product_url,
              c.display_name AS competitor_name, c.slug AS competitor_slug
       FROM product_matches m
       JOIN products p    ON p.id = m.product_id
       JOIN competitors c ON c.id = m.competitor_id
       ${where}
       ORDER BY m.confidence DESC, m.id
       LIMIT ${limit}`,
      params,
    );

    res.json({ matches: rows, total: rows[0]?.total_count ?? 0 });
  } catch (err) {
    next(err);
  }
});

matchesRouter.post('/:id/confirm', async (req, res, next) => {
  try {
    const id = Number.parseInt(req.params.id ?? '', 10);
    const confirmedBy = typeof req.body?.confirmedBy === 'string' ? req.body.confirmedBy : 'admin';

    const { rows: target } = await query<{ product_id: number; competitor_id: number }>(
      'SELECT product_id, competitor_id FROM product_matches WHERE id = $1',
      [id],
    );
    const match = target[0];
    if (!match) {
      res.status(404).json({ error: 'Match not found' });
      return;
    }

    // Only one confirmed listing per product/competitor — supersede any previous one.
    await query(
      `UPDATE product_matches
       SET status = 'rejected', updated_at = now()
       WHERE product_id = $1 AND competitor_id = $2 AND id <> $3 AND status = 'confirmed'`,
      [match.product_id, match.competitor_id, id],
    );

    const { rows } = await query(
      `UPDATE product_matches
       SET status = 'confirmed', confirmed_at = now(), confirmed_by = $2, updated_at = now()
       WHERE id = $1
       RETURNING *`,
      [id, confirmedBy],
    );

    res.json({ match: rows[0] });
  } catch (err) {
    next(err);
  }
});

matchesRouter.post('/:id/reject', async (req, res, next) => {
  try {
    const id = Number.parseInt(req.params.id ?? '', 10);
    const rejectedBy = typeof req.body?.confirmedBy === 'string' ? req.body.confirmedBy : 'admin';

    const { rows } = await query(
      `UPDATE product_matches
       SET status = 'rejected', confirmed_at = now(), confirmed_by = $2, updated_at = now()
       WHERE id = $1
       RETURNING *`,
      [id, rejectedBy],
    );

    if (!rows[0]) {
      res.status(404).json({ error: 'Match not found' });
      return;
    }
    res.json({ match: rows[0] });
  } catch (err) {
    next(err);
  }
});

/**
 * Manually link a product to a competitor URL. Fetches the page so the stored
 * link is verified and scored rather than taken on trust.
 */
matchesRouter.post('/', async (req, res, next) => {
  try {
    const productId = Number.parseInt(String(req.body?.productId ?? ''), 10);
    const competitorId = Number.parseInt(String(req.body?.competitorId ?? ''), 10);
    const url = typeof req.body?.url === 'string' ? req.body.url.trim() : '';

    if (!Number.isFinite(productId) || !Number.isFinite(competitorId) || !url) {
      res.status(400).json({ error: 'productId, competitorId and url are all required' });
      return;
    }

    const [{ rows: productRows }, competitor] = await Promise.all([
      query<Product>('SELECT * FROM products WHERE id = $1', [productId]),
      getCompetitorById(competitorId),
    ]);

    const product = productRows[0];
    if (!product) {
      res.status(404).json({ error: 'Product not found' });
      return;
    }
    if (!competitor) {
      res.status(404).json({ error: 'Competitor not found' });
      return;
    }
    if (!url.startsWith(competitor.base_url)) {
      res.status(400).json({
        error: `URL must be on ${competitor.display_name} (${competitor.base_url})`,
      });
      return;
    }

    const page = await fetchPage(competitor, url);
    const listing = extractListing(competitor, page);
    const scored = scoreCandidate(product, {
      url: page.finalUrl,
      title: listing.title ?? url,
      ean: listing.ean,
      brand: listing.brand,
      attributes: listing.attributes,
      price: listing.price,
    });

    const { rows } = await query(
      `INSERT INTO product_matches
         (product_id, competitor_id, competitor_url, competitor_title, competitor_ean,
          confidence, match_tier, status, evidence, confirmed_at, confirmed_by)
       VALUES ($1, $2, $3, $4, $5, $6, 'manual', 'pending', $7::jsonb, NULL, NULL)
       ON CONFLICT (product_id, competitor_id, competitor_url) DO UPDATE SET
         competitor_title = EXCLUDED.competitor_title,
         competitor_ean   = EXCLUDED.competitor_ean,
         confidence       = EXCLUDED.confidence,
         evidence         = EXCLUDED.evidence,
         updated_at       = now()
       RETURNING *`,
      [
        productId,
        competitorId,
        page.finalUrl,
        listing.title,
        listing.ean,
        scored.confidence,
        JSON.stringify(scored.evidence),
      ],
    );

    res.json({ match: rows[0], extracted: listing });
  } catch (err) {
    if (err instanceof ScrapeError) {
      res.status(422).json({ error: err.message, kind: err.kind });
      return;
    }
    next(err);
  }
});
