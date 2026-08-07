import 'dotenv/config';

function required(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === '') {
    throw new Error(
      `Missing required environment variable ${name}. Copy .env.example to .env and fill it in.`,
    );
  }
  return value.trim();
}

function optionalInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * All configuration comes from the environment. Credentials are never
 * hardcoded and never committed — see .env.example for the required vars.
 */
export const env = {
  get databaseUrl(): string {
    return required('DATABASE_URL');
  },
  nodeEnv: process.env.NODE_ENV ?? 'development',
  port: optionalInt('PORT', 3001),

  /** Optional shared-password gate. Auth is disabled when unset (Spec §7, MVP). */
  appPassword: process.env.APP_PASSWORD?.trim() || null,
  sessionSecret: process.env.SESSION_SECRET?.trim() || null,

  /** Polite, identifiable UA (Spec §9). Competitor config may override. */
  scraperUserAgent:
    process.env.SCRAPER_USER_AGENT?.trim() ||
    'WOSG-PriceMonitor/0.1 (+price monitoring; contact: trading@example.com)',

  /** Global floor on per-domain politeness, regardless of competitor config. */
  minRequestDelayMs: optionalInt('SCRAPER_MIN_DELAY_MS', 3000),
  requestTimeoutMs: optionalInt('SCRAPER_TIMEOUT_MS', 30000),
  maxConcurrentScrapes: optionalInt('SCRAPER_MAX_CONCURRENCY', 2),

  /** Set to 'false' only for local testing against your own fixtures. */
  respectRobotsTxt: (process.env.RESPECT_ROBOTS_TXT ?? 'true').toLowerCase() !== 'false',

  get isProduction(): boolean {
    return this.nodeEnv === 'production';
  },
};
