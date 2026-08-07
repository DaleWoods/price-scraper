import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type NextFunction, type Request, type Response } from 'express';
import cookieParser from 'cookie-parser';
import { env } from './config/env.js';
import { closePool, query } from './db/pool.js';
import { runMigrations } from './db/migrate.js';
import { logger } from './lib/logger.js';
import { authEnabled, requireAuth } from './middleware/auth.js';
import { authRouter } from './routes/auth.js';
import { comparisonRouter } from './routes/comparison.js';
import { competitorsRouter } from './routes/competitors.js';
import { matchesRouter } from './routes/matches.js';
import { productsRouter } from './routes/products.js';
import { runsRouter } from './routes/runs.js';
import { closeBrowser } from './scraping/browser.js';
import { syncCompetitorsToDatabase } from './scraping/competitorRegistry.js';

const app = express();

app.set('trust proxy', 1);
app.use(express.json({ limit: '2mb' }));
app.use(cookieParser());

app.get('/api/health', async (_req: Request, res: Response) => {
  try {
    await query('SELECT 1');
    res.json({ status: 'ok', database: 'connected', authEnabled: authEnabled() });
  } catch (err) {
    res.status(503).json({ status: 'degraded', database: 'unreachable', error: (err as Error).message });
  }
});

app.use('/api/auth', authRouter);

app.use('/api/products', requireAuth, productsRouter);
app.use('/api/competitors', requireAuth, competitorsRouter);
app.use('/api/matches', requireAuth, matchesRouter);
app.use('/api/comparison', requireAuth, comparisonRouter);
app.use('/api/runs', requireAuth, runsRouter);

// Serve the built React app. In development Vite serves it on its own port and
// proxies /api here, so this only matters for the single-service Render deploy.
const webDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web/dist');
app.use(express.static(webDist));
app.get(/^(?!\/api\/).*/, (_req: Request, res: Response) => {
  res.sendFile(path.join(webDist, 'index.html'), (err) => {
    if (err) res.status(404).json({ error: 'Frontend build not found. Run `npm run build` first.' });
  });
});

app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  logger.error('http', err.message, err);
  if (res.headersSent) return;
  res.status(500).json({
    error: env.isProduction ? 'Internal server error' : err.message,
  });
});

async function start(): Promise<void> {
  // Migrating on boot keeps the Render deploy to a single service with no
  // separate release step; it is a no-op once the schema is current.
  await runMigrations();
  await syncCompetitorsToDatabase();

  const server = app.listen(env.port, () => {
    logger.info('server', `listening on port ${env.port} (${env.nodeEnv})`);
    if (!authEnabled()) {
      logger.warn('server', 'APP_PASSWORD is not set — the app is running without a login gate.');
    }
  });

  const shutdown = async (signal: string): Promise<void> => {
    logger.info('server', `${signal} received, shutting down`);
    server.close();
    await closeBrowser();
    await closePool();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

start().catch((err) => {
  logger.error('server', `failed to start: ${(err as Error).message}`, err);
  process.exit(1);
});

export { app };
