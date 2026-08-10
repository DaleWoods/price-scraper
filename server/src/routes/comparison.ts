import { Router } from 'express';
import { query } from '../db/pool.js';
import { getComparison, type ComparisonFilters } from '../services/comparison.js';
import type { PricePosition } from '../domain/types.js';

export const comparisonRouter: Router = Router();

/**
 * Remove one competitor's price for one product.
 *
 * Deletes the observations and the match together: leaving the match behind
 * would have the next run re-record the same stale price, and leaving
 * observations behind would keep showing a price with nothing to explain it.
 *
 * A rejected match survives. It carries no price — it records a human deciding
 * this candidate is the wrong product — and deleting it would let a later run
 * offer the same wrong candidate all over again.
 */
comparisonRouter.delete('/product/:productId/competitor/:competitorId', async (req, res) => {
  try {
    const productId = Number.parseInt(req.params.productId ?? '', 10);
    const competitorId = Number.parseInt(req.params.competitorId ?? '', 10);
    if (!Number.isFinite(productId) || !Number.isFinite(competitorId)) {
      res.status(400).json({ error: 'Invalid product or competitor id' });
      return;
    }

    const observations = await query(
      'DELETE FROM price_observations WHERE product_id = $1 AND competitor_id = $2',
      [productId, competitorId],
    );
    const matches = await query(
      `DELETE FROM product_matches
       WHERE product_id = $1 AND competitor_id = $2 AND status <> 'rejected'`,
      [productId, competitorId],
    );

    res.json({
      observationsRemoved: observations.rowCount ?? 0,
      matchesRemoved: matches.rowCount ?? 0,
    });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

/**
 * Clear every recorded comparison: all competitor observations, and the matches
 * that produced them.
 *
 * Three things survive deliberately. Products and our own prices, because those
 * come from the feed rather than from scraping. Rejections, because they are
 * human decisions and a run that could re-suggest them would undo the review
 * queue. And the sitemap URL cache, because rebuilding it means re-fetching
 * every competitor's sitemap for no benefit.
 */
comparisonRouter.delete('/observations', async (_req, res) => {
  try {
    const observations = await query('DELETE FROM price_observations');
    const matches = await query(`DELETE FROM product_matches WHERE status <> 'rejected'`);
    res.json({
      observationsRemoved: observations.rowCount ?? 0,
      matchesRemoved: matches.rowCount ?? 0,
    });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

function parseFilters(queryParams: Record<string, unknown>): ComparisonFilters {
  const position = typeof queryParams.position === 'string' ? queryParams.position : null;
  const validPositions = ['lower', 'equal', 'higher', 'unmatched', 'awaiting_price'];

  return {
    fasciaCode:
      typeof queryParams.fascia === 'string' && queryParams.fascia ? queryParams.fascia : null,
    brand: typeof queryParams.brand === 'string' && queryParams.brand ? queryParams.brand : null,
    category:
      typeof queryParams.category === 'string' && queryParams.category ? queryParams.category : null,
    competitorId: queryParams.competitorId ? Number(queryParams.competitorId) : null,
    position:
      position && validPositions.includes(position)
        ? (position as PricePosition | 'unmatched' | 'awaiting_price')
        : null,
    search: typeof queryParams.search === 'string' && queryParams.search ? queryParams.search : null,
    limit: queryParams.limit ? Number(queryParams.limit) : 100,
    offset: queryParams.offset ? Number(queryParams.offset) : 0,
  };
}

comparisonRouter.get('/', async (req, res, next) => {
  try {
    res.json(await getComparison(parseFilters(req.query as Record<string, unknown>)));
  } catch (err) {
    next(err);
  }
});

/** CSV export of the current comparison view (Spec §5.6). */
comparisonRouter.get('/export.csv', async (req, res, next) => {
  try {
    const filters = parseFilters(req.query as Record<string, unknown>);
    const { rows } = await getComparison({ ...filters, limit: 500, offset: 0 });

    const header = [
      'internal_sku',
      'brand',
      'product_name',
      'category',
      'ean_mpn',
      'our_price',
      'currency',
      'best_competitor',
      'best_competitor_price',
      'position',
      'delta_gbp',
      'delta_pct',
      'observed_at',
    ];

    const escape = (value: unknown): string => {
      if (value == null) return '';
      // Timestamps arrive from pg as Date objects; String() would render the long
      // "Fri Aug 07 2026 …" form, which Excel will not parse as a date.
      const text = value instanceof Date ? value.toISOString() : String(value);
      return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    };

    const lines = [header.join(',')];
    for (const row of rows) {
      lines.push(
        [
          row.product.internal_sku,
          row.product.brand,
          row.product.product_name,
          row.product.category,
          row.product.ean_mpn,
          row.product.our_price,
          row.product.currency,
          row.bestCompetitorName,
          row.bestCompetitorPrice,
          row.position ?? 'unmatched',
          row.deltaAbs,
          row.deltaPct,
          row.observedAt,
        ]
          .map(escape)
          .join(','),
      );
    }

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="price-comparison.csv"');
    // BOM so Excel opens the £ signs correctly.
    res.send(`﻿${lines.join('\n')}`);
  } catch (err) {
    next(err);
  }
});
