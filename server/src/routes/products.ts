import { Router } from 'express';
import multer from 'multer';
import { query } from '../db/pool.js';
import { importFeed } from '../import/feedImport.js';
import { getProductHistory } from '../services/comparison.js';

export const productsRouter: Router = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (_req, file, callback) => {
    // The extension only gates obviously wrong uploads; the parser identifies
    // the real format from the file's magic bytes, since ".xls" in this domain
    // is frequently tab-separated text or a renamed .xlsx.
    if (/\.(csv|tsv|txt|xls|xlsx|xlsm|xltx)$/i.test(file.originalname)) callback(null, true);
    else callback(new Error('Accepted file types: .csv, .tsv, .txt, .xls, .xlsx, .xlsm, .xltx'));
  },
});

productsRouter.get('/', async (req, res, next) => {
  try {
    const limit = Math.min(Number.parseInt(String(req.query.limit ?? '100'), 10) || 100, 500);
    const offset = Math.max(Number.parseInt(String(req.query.offset ?? '0'), 10) || 0, 0);
    const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';

    const params: unknown[] = [];
    let where = '';
    if (search) {
      params.push(`%${search}%`);
      where = `WHERE product_name ILIKE $1 OR internal_sku ILIKE $1 OR brand ILIKE $1`;
    }

    const { rows } = await query(
      `SELECT *, count(*) OVER () AS total_count
       FROM products ${where}
       ORDER BY brand, product_name
       LIMIT ${limit} OFFSET ${offset}`,
      params,
    );

    res.json({ products: rows, total: rows[0]?.total_count ?? 0, limit, offset });
  } catch (err) {
    next(err);
  }
});

productsRouter.get('/facets', async (_req, res, next) => {
  try {
    const [brands, categories] = await Promise.all([
      query<{ value: string }>(
        `SELECT DISTINCT brand AS value FROM products
         WHERE brand <> '' AND delisted_at IS NULL ORDER BY 1`,
      ),
      query<{ value: string }>(
        `SELECT DISTINCT category AS value FROM products
         WHERE category IS NOT NULL AND category <> '' AND delisted_at IS NULL ORDER BY 1`,
      ),
    ]);
    res.json({
      brands: brands.rows.map((row) => row.value),
      categories: categories.rows.map((row) => row.value),
    });
  } catch (err) {
    next(err);
  }
});




/**
 * Import a Google Shopping feed for one fascia.
 *
 * The feed carries product content and the price that fascia shows, so it is
 * the single source for both — replacing the separate catalogue price column
 * and the SAP loadsheet.
 */
productsRouter.post('/import-feed', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      res.status(400).json({ error: 'No file uploaded. Attach the feed as "file".' });
      return;
    }
    const fascia = String(req.query.fascia ?? req.body?.fascia ?? '').trim();
    if (!fascia) {
      res.status(400).json({ error: 'Which fascia is this feed for? Pass ?fascia=<code>.' });
      return;
    }
    res.json(await importFeed(req.file.buffer, req.file.originalname, fascia));
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

productsRouter.get('/:id/history', async (req, res, next) => {
  try {
    const id = Number.parseInt(req.params.id ?? '', 10);
    if (!Number.isFinite(id)) {
      res.status(400).json({ error: 'Invalid product id' });
      return;
    }
    res.json({ observations: await getProductHistory(id) });
  } catch (err) {
    next(err);
  }
});

productsRouter.get('/:id', async (req, res, next) => {
  try {
    const id = Number.parseInt(req.params.id ?? '', 10);
    const { rows } = await query('SELECT * FROM products WHERE id = $1', [id]);
    if (!rows[0]) {
      res.status(404).json({ error: 'Product not found' });
      return;
    }
    res.json({ product: rows[0] });
  } catch (err) {
    next(err);
  }
});
