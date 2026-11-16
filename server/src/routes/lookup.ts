import { Router } from 'express';
import { getLookup, LookupError, recentLookups, startLookup } from '../services/lookup.js';
import { getBatch, recentBatches, startBatch } from '../services/lookupBatch.js';

export const lookupRouter: Router = Router();

/** Start checking one product against every enabled competitor. */
lookupRouter.post('/', async (req, res, next) => {
  try {
    const input = typeof req.body?.query === 'string' ? req.body.query : '';
    const fascia = typeof req.body?.fascia === 'string' ? req.body.fascia : null;
    res.status(202).json(await startLookup(input, fascia));
  } catch (err) {
    if (err instanceof LookupError) {
      res.status(404).json({ error: err.message });
      return;
    }
    next(err);
  }
});

/** Check a list of products: SKUs, references or barcodes, read from an uploaded file. */
lookupRouter.post('/batch', async (req, res, next) => {
  try {
    const values: string[] = Array.isArray(req.body?.values)
      ? req.body.values.filter((value: unknown): value is string => typeof value === 'string')
      : [];
    const fileName = typeof req.body?.fileName === 'string' ? req.body.fileName.slice(0, 200) : null;
    res.status(202).json(await startBatch(values, fileName));
  } catch (err) {
    if (err instanceof LookupError) {
      res.status(400).json({ error: err.message });
      return;
    }
    next(err);
  }
});

lookupRouter.get('/batches', async (_req, res, next) => {
  try {
    res.json({ batches: await recentBatches() });
  } catch (err) {
    next(err);
  }
});

lookupRouter.get('/batch/:id', async (req, res, next) => {
  try {
    const batch = await getBatch(Number(req.params.id));
    if (!batch) {
      res.status(404).json({ error: 'No such list.' });
      return;
    }
    res.json(batch);
  } catch (err) {
    next(err);
  }
});

lookupRouter.get('/recent', async (_req, res, next) => {
  try {
    res.json({ recent: await recentLookups() });
  } catch (err) {
    next(err);
  }
});

/** The product and what each competitor has for it; polled while a check runs. */
lookupRouter.get('/:productId', async (req, res, next) => {
  try {
    const result = await getLookup(Number(req.params.productId));
    if (!result) {
      res.status(404).json({ error: 'No such product.' });
      return;
    }
    res.json(result);
  } catch (err) {
    next(err);
  }
});
