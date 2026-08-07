import { Router } from 'express';
import { getComparison, type ComparisonFilters } from '../services/comparison.js';
import type { PricePosition } from '../domain/types.js';

export const comparisonRouter: Router = Router();

function parseFilters(queryParams: Record<string, unknown>): ComparisonFilters {
  const position = typeof queryParams.position === 'string' ? queryParams.position : null;
  const validPositions = ['lower', 'equal', 'higher', 'unmatched'];

  return {
    brand: typeof queryParams.brand === 'string' && queryParams.brand ? queryParams.brand : null,
    category:
      typeof queryParams.category === 'string' && queryParams.category ? queryParams.category : null,
    competitorId: queryParams.competitorId ? Number(queryParams.competitorId) : null,
    position: position && validPositions.includes(position) ? (position as PricePosition | 'unmatched') : null,
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
