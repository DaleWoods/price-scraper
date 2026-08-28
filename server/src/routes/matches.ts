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

    // Our price is per fascia, so reviewing a candidate needs to say whose
    // price is being shown. Without this the column read NULL for every row,
    // since nothing writes products.our_price any more.
    const requested = typeof req.query.fascia === 'string' ? req.query.fascia : null;
    const { rows: fasciaRows } = await query<{ id: number; code: string; name: string }>(
      `SELECT id, code, name FROM fascias
       WHERE enabled AND ($1::text IS NULL OR code = $1)
       ORDER BY code LIMIT 1`,
      [requested],
    );
    const fascia = fasciaRows[0] ?? null;
    params.push(fascia?.id ?? null);
    const fasciaParam = params.length;

    const { rows } = await query(
      `SELECT m.*, count(*) OVER () AS total_count,
              p.internal_sku, p.brand, p.product_name,
              fp.price AS our_price,
              COALESCE(fp.currency, 'GBP') AS currency,
              p.category, p.ean_mpn, p.specs,
              COALESCE(fp.product_url, p.our_product_url) AS our_product_url,
              c.display_name AS competitor_name, c.slug AS competitor_slug
       FROM product_matches m
       JOIN products p    ON p.id = m.product_id
       JOIN competitors c ON c.id = m.competitor_id
       LEFT JOIN fascia_prices fp
         ON fp.product_id = p.id AND fp.fascia_id = $${fasciaParam}
       ${where}
       ORDER BY m.confidence DESC, m.id
       LIMIT ${limit}`,
      params,
    );

    res.json({
      matches: rows,
      total: rows[0]?.total_count ?? 0,
      fascia: fascia ? { code: fascia.code, name: fascia.name } : null,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Confirm one candidate. Only one confirmed listing is allowed per
 * product/competitor, so confirming this one supersedes any previous one
 * rather than leaving two confirmed matches fighting over the same run.
 */
async function confirmMatch(id: number, confirmedBy: string) {
  const { rows: target } = await query<{ product_id: number; competitor_id: number }>(
    'SELECT product_id, competitor_id FROM product_matches WHERE id = $1',
    [id],
  );
  const match = target[0];
  if (!match) return null;

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
  return rows[0] ?? null;
}

async function rejectMatch(id: number, rejectedBy: string) {
  const { rows } = await query(
    `UPDATE product_matches
     SET status = 'rejected', confirmed_at = now(), confirmed_by = $2, updated_at = now()
     WHERE id = $1
     RETURNING *`,
    [id, rejectedBy],
  );
  return rows[0] ?? null;
}

matchesRouter.post('/:id/confirm', async (req, res, next) => {
  try {
    const id = Number.parseInt(req.params.id ?? '', 10);
    const confirmedBy = typeof req.body?.confirmedBy === 'string' ? req.body.confirmedBy : 'admin';

    const match = await confirmMatch(id, confirmedBy);
    if (!match) {
      res.status(404).json({ error: 'Match not found' });
      return;
    }
    res.json({ match });
  } catch (err) {
    next(err);
  }
});

/**
 * Decide several candidates in one action. Each id is applied independently
 * through the same logic as the single-row routes — a bad id among a batch
 * fails just that one row rather than the whole selection.
 */
matchesRouter.post('/bulk', async (req, res, next) => {
  try {
    const decision = req.body?.decision;
    if (decision !== 'confirm' && decision !== 'reject') {
      res.status(400).json({ error: 'decision must be "confirm" or "reject"' });
      return;
    }
    const ids = Array.isArray(req.body?.ids)
      ? req.body.ids.map((id: unknown) => Number(id)).filter((id: number) => Number.isFinite(id))
      : [];
    if (ids.length === 0) {
      res.status(400).json({ error: 'ids must be a non-empty array' });
      return;
    }

    const by = typeof req.body?.confirmedBy === 'string' ? req.body.confirmedBy : 'admin';
    let succeeded = 0;
    let failed = 0;

    for (const id of ids) {
      const result = decision === 'confirm' ? await confirmMatch(id, by) : await rejectMatch(id, by);
      if (result) succeeded += 1;
      else failed += 1;
    }

    res.json({
      decision,
      confirmed: decision === 'confirm' ? succeeded : 0,
      rejected: decision === 'reject' ? succeeded : 0,
      failed,
    });
  } catch (err) {
    next(err);
  }
});

matchesRouter.post('/:id/reject', async (req, res, next) => {
  try {
    const id = Number.parseInt(req.params.id ?? '', 10);
    const rejectedBy = typeof req.body?.confirmedBy === 'string' ? req.body.confirmedBy : 'admin';

    const match = await rejectMatch(id, rejectedBy);

    if (!match) {
      res.status(404).json({ error: 'Match not found' });
      return;
    }
    res.json({ match });
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
