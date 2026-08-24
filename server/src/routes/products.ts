import { Router } from 'express';
import multer from 'multer';
import { query } from '../db/pool.js';
import { importFeed } from '../import/feedImport.js';
import { getProductCoverage, getProductHistory } from '../services/comparison.js';

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
 * Add one product by hand.
 *
 * Everything normally arrives in a Google feed, but testing needs a product you
 * have chosen — one you already know a competitor lists — without waiting on a
 * feed export. Such a product is marked `manual` so a later feed import does
 * not delist it for being absent from the file.
 */
productsRouter.post('/', async (req, res) => {
  try {
    const body = req.body ?? {};
    const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '');

    const internalSku = text(body.internalSku);
    const brand = text(body.brand);
    const productName = text(body.productName);
    if (!internalSku || !brand || !productName) {
      res.status(400).json({ error: 'SKU, brand and product name are all required.' });
      return;
    }

    const price = body.price === '' || body.price == null ? null : Number(body.price);
    if (price != null && (!Number.isFinite(price) || price < 0)) {
      res.status(400).json({ error: 'Price must be a positive number, or left empty.' });
      return;
    }

    const fasciaCode = text(body.fascia);
    let fasciaId: number | null = null;
    if (price != null) {
      if (!fasciaCode) {
        res.status(400).json({ error: 'Which of our sites is that price for?' });
        return;
      }
      const { rows } = await query<{ id: number }>('SELECT id FROM fascias WHERE code = $1', [
        fasciaCode,
      ]);
      if (!rows[0]) {
        res.status(400).json({ error: `No site with code "${fasciaCode}".` });
        return;
      }
      fasciaId = rows[0].id;
    }

    const { rows: existing } = await query<{ id: number }>(
      'SELECT id FROM products WHERE lower(internal_sku) = lower($1)',
      [internalSku],
    );
    if (existing[0]) {
      res
        .status(409)
        .json({ error: `${internalSku} already exists. Delete it first if you want to re-add it.` });
      return;
    }

    const { rows } = await query<{ id: number }>(
      `INSERT INTO products
         (internal_sku, brand, product_name, ean_mpn, category, our_product_url, specs, source)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, 'manual')
       RETURNING id`,
      [
        internalSku,
        brand,
        productName,
        text(body.eanMpn) || null,
        text(body.category) || null,
        text(body.ourProductUrl) || null,
        JSON.stringify(
          text(body.referenceNumber) ? { reference_number: text(body.referenceNumber) } : {},
        ),
      ],
    );

    const productId = rows[0]!.id;
    if (price != null && fasciaId != null) {
      await query(
        `INSERT INTO fascia_prices (product_id, fascia_id, price, currency)
         VALUES ($1, $2, $3, 'GBP')`,
        [productId, fasciaId, price],
      );
    }

    res.status(201).json({ productId, internalSku });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

/**
 * Delete a product outright, with everything attached to it.
 *
 * A feed import never does this — it delists instead, because deleting destroys
 * the price history the app exists to collect. Asking for it directly is a
 * different matter: it is how test data gets cleared out, and the confirmation
 * says what goes with it.
 */
productsRouter.delete('/:id', async (req, res) => {
  try {
    const id = Number.parseInt(req.params.id ?? '', 10);
    if (!Number.isFinite(id)) {
      res.status(400).json({ error: 'Invalid product id' });
      return;
    }

    const { rows } = await query<{ internal_sku: string; observations: number }>(
      `WITH counted AS (
         SELECT count(*)::int AS observations FROM price_observations WHERE product_id = $1
       ), gone AS (
         DELETE FROM products WHERE id = $1 RETURNING internal_sku
       )
       SELECT gone.internal_sku, counted.observations FROM gone, counted`,
      [id],
    );
    if (!rows[0]) {
      res.status(404).json({ error: 'Product not found' });
      return;
    }
    res.json({ deleted: rows[0].internal_sku, observationsRemoved: rows[0].observations });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

/**
 * Delete the whole catalogue — every product, and everything hanging off it.
 *
 * The "start from scratch" button. Competitors, their logos and the cached
 * sitemap URLs are all kept: none of those came from a feed.
 */
productsRouter.delete('/', async (_req, res) => {
  try {
    const { rows } = await query<{ id: number }>('DELETE FROM products RETURNING id');
    res.json({ deleted: rows.length });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
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

/**
 * Every enabled competitor's outcome for one product — priced, or why not.
 *
 * `ourPrice` is optional and only used to classify a found price as lower /
 * equal / higher; it comes from whichever fascia the caller is currently
 * comparing against, since price and position are per-fascia everywhere else
 * in the app too.
 */
productsRouter.get('/:id/coverage', async (req, res, next) => {
  try {
    const id = Number.parseInt(req.params.id ?? '', 10);
    if (!Number.isFinite(id)) {
      res.status(400).json({ error: 'Invalid product id' });
      return;
    }
    const rawOurPrice = req.query.ourPrice;
    const ourPrice =
      typeof rawOurPrice === 'string' && rawOurPrice !== '' && Number.isFinite(Number(rawOurPrice))
        ? Number(rawOurPrice)
        : null;
    res.json(await getProductCoverage(id, ourPrice));
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
