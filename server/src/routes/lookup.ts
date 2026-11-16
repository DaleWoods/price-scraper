import { Router } from 'express';
import { getLookup, LookupError, recentLookups, startLookup } from '../services/lookup.js';

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
