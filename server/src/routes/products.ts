import { Router } from 'express';
import multer from 'multer';
import { query } from '../db/pool.js';
import { importCatalogue } from '../import/catalogueImport.js';
import { importLoadsheet } from '../import/loadsheetImport.js';
import { importPrices } from '../import/priceImport.js';
import { getProductHistory } from '../services/comparison.js';

export const productsRouter: Router = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (_req, file, callback) => {
    if (/\.(csv|xlsx|xlsm|xltx)$/i.test(file.originalname)) callback(null, true);
    else callback(new Error('Only .csv, .xlsx, .xlsm and .xltx files are accepted'));
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
        `SELECT DISTINCT brand AS value FROM products WHERE brand <> '' ORDER BY 1`,
      ),
      query<{ value: string }>(
        `SELECT DISTINCT category AS value FROM products WHERE category IS NOT NULL AND category <> '' ORDER BY 1`,
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

/** CSV/Excel import of the master catalogue export (Spec §5.1). */
productsRouter.post('/import', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      res.status(400).json({ error: 'No file uploaded. Attach a .csv or .xlsx export as "file".' });
      return;
    }
    const result = await importCatalogue(req.file.buffer, req.file.originalname);
    res.json(result);
  } catch (err) {
    // Problems in the uploaded file are the user's to fix, not a server fault —
    // report them as 400 with the specific reason.
    res.status(400).json({ error: (err as Error).message });
  }
});

/**
 * Apply a price file, joined on SKU (Spec §5.1 — prices arrive separately from
 * the product content export). Only updates existing products.
 */
productsRouter.post('/import-prices', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      res.status(400).json({ error: 'No file uploaded. Attach a .csv or .xlsx price file as "file".' });
      return;
    }
    res.json(await importPrices(req.file.buffer, req.file.originalname));
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

/**
 * Import a SAP price loadsheet, resolving one selling price per UK fascia
 * (Spec: store-specific beats sales-org-wide; sale beats regular when cheaper).
 */
productsRouter.post('/import-loadsheet', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      res.status(400).json({ error: 'No file uploaded. Attach the loadsheet as "file".' });
      return;
    }
    res.json(await importLoadsheet(req.file.buffer, req.file.originalname));
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
