import { Router } from 'express';
import { query } from '../db/pool.js';
import { getPriceMovements, type MovementSide } from '../services/priceMovements.js';

export const reportRouter = Router();

/** Windows offered, as a whitelist — the value interpolates into an interval. */
const WINDOWS = [1, 7, 30, 90];

function windowDays(raw: unknown): number {
  const days = Number(raw);
  return WINDOWS.includes(days) ? days : 1;
}

async function resolveFascia(raw: unknown): Promise<number | null> {
  if (raw) {
    const { rows } = await query<{ id: number }>('SELECT id FROM fascias WHERE code = $1', [
      String(raw),
    ]);
    if (rows[0]) return rows[0].id;
  }
  // Falling back to a site rather than erroring: the report is the first thing
  // someone opens in the morning and should show something useful without
  // having to pick anything first.
  const { rows } = await query<{ id: number }>(
    'SELECT id FROM fascias WHERE enabled ORDER BY code LIMIT 1',
  );
  return rows[0]?.id ?? null;
}

function parseSide(raw: unknown): MovementSide | 'all' {
  return raw === 'competitor' || raw === 'ours' ? raw : 'all';
}

reportRouter.get('/', async (req, res, next) => {
  try {
    const fasciaId = await resolveFascia(req.query.fascia);
    if (fasciaId == null) {
      res.status(400).json({ error: 'No sites are configured, so there is nothing to compare against.' });
      return;
    }

    res.json(
      await getPriceMovements({
        fasciaId,
        days: windowDays(req.query.days),
        side: parseSide(req.query.side),
        undercutsOnly: req.query.undercutsOnly === '1',
      }),
    );
  } catch (err) {
    next(err);
  }
});

/** Escape a CSV field — quotes doubled, anything risky quoted. */
function csvField(value: string | number | null): string {
  if (value == null) return '';
  const text = String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

reportRouter.get('/export.csv', async (req, res, next) => {
  try {
    const fasciaId = await resolveFascia(req.query.fascia);
    if (fasciaId == null) {
      res.status(400).json({ error: 'No sites are configured.' });
      return;
    }

    const report = await getPriceMovements({
      fasciaId,
      days: windowDays(req.query.days),
      side: parseSide(req.query.side),
      undercutsOnly: req.query.undercutsOnly === '1',
    });

    const header = [
      'changed_at',
      'who',
      'sku',
      'product',
      'brand',
      'competitor',
      'previous_price',
      'new_price',
      'change',
      'change_pct',
      'our_price',
      'our_position',
      'currency',
    ];

    const lines = [header.join(',')];
    for (const movement of report.movements) {
      lines.push(
        [
          movement.changedAt,
          movement.side === 'ours' ? 'us' : 'competitor',
          movement.internalSku,
          movement.productName,
          movement.brand,
          movement.competitorName ?? '',
          movement.previousPrice,
          movement.price,
          movement.deltaAbs,
          movement.deltaPct,
          movement.ourPrice,
          movement.position ?? '',
          movement.currency,
        ]
          .map(csvField)
          .join(','),
      );
    }

    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader('content-type', 'text/csv; charset=utf-8');
    res.setHeader(
      'content-disposition',
      `attachment; filename="price-movements-${report.fascia?.code ?? 'all'}-${stamp}.csv"`,
    );
    // A BOM, so Excel opens it as UTF-8 rather than mangling the pound sign.
    res.send(`﻿${lines.join('\n')}\n`);
  } catch (err) {
    next(err);
  }
});
