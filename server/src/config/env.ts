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

  /**
   * Where the daily Google feeds are delivered.
   *
   * Collecting them from here rather than by hand is not only about saving
   * the upload: a feed that travels via someone's desktop tends to arrive
   * having been opened in Excel, which destroys long GTINs into scientific
   * notation and throws away the strongest matching key we have.
   *
   * Unset means nothing changes — feeds are uploaded manually as before.
   */
  feedFtpProtocol: ((process.env.FEED_FTP_PROTOCOL?.trim().toLowerCase() || 'sftp') as
    | 'ftp'
    | 'ftps'
    | 'sftp'),
  feedFtpHost: process.env.FEED_FTP_HOST?.trim() || null,
  feedFtpPort: process.env.FEED_FTP_PORT ? optionalInt('FEED_FTP_PORT', 0) || null : null,
  feedFtpUser: process.env.FEED_FTP_USER?.trim() || null,
  feedFtpPassword: process.env.FEED_FTP_PASSWORD || null,
  feedFtpDirectory: process.env.FEED_FTP_DIRECTORY?.trim() || '/',

  /**
   * Which filename belongs to which of our sites, as
   * `FEED_FTP_PATTERN_<fascia code>=goldsmiths_*.csv`.
   *
   * Read from the environment by prefix rather than listed here, so adding a
   * fourth fascia is a deployment setting and not a code change — the same
   * rule the competitor configs follow.
   */
  get feedPatterns(): { fasciaCode: string; pattern: string }[] {
    return Object.entries(process.env)
      .filter(([key, value]) => key.startsWith('FEED_FTP_PATTERN_') && value?.trim())
      .map(([key, value]) => ({
        fasciaCode: key.slice('FEED_FTP_PATTERN_'.length),
        pattern: value!.trim(),
      }))
      .sort((a, b) => a.fasciaCode.localeCompare(b.fasciaCode));
  },

  /**
   * The nightly job: collect feeds, then scan.
   *
   * Off by default. A scan started by surprise on a deployment nobody was
   * watching is the sort of thing that burns a compute quota overnight, so
   * turning it on is a deliberate act.
   */
  scheduleEnabled: (process.env.SCHEDULE_ENABLED ?? 'false').toLowerCase() === 'true',
  /** 24-hour local time, "HH:MM". */
  scheduleAt: (process.env.SCHEDULE_AT?.trim() || '03:00'),
  /**
   * Defaults to UK local time, so "03:00" means 3am as the business reads it
   * in summer and winter alike rather than drifting an hour twice a year.
   */
  scheduleTimeZone: process.env.SCHEDULE_TIMEZONE?.trim() || 'Europe/London',
  /**
   * How long after the scheduled time a missed run is still worth starting.
   *
   * If the app was down at 03:00 it should still run when it comes back at
   * 03:40 — a day with no prices is the thing this job exists to prevent. But
   * coming back at 6pm should wait for tonight rather than starting a full
   * scan in the middle of the afternoon.
   */
  scheduleCatchUpHours: optionalInt('SCHEDULE_CATCH_UP_HOURS', 4),

  /** Set to 'false' only for local testing against your own fixtures. */
  respectRobotsTxt: (process.env.RESPECT_ROBOTS_TXT ?? 'true').toLowerCase() !== 'false',

  /**
   * Optional paid unblocking backend, for competitors that refuse us directly.
   *
   * Unset means the app behaves exactly as it always has — every request goes
   * out from this host and nothing costs money. Set both provider and key and
   * a *blocked* request can be retried through that provider; see
   * scraping/unblocker.ts for which blocks are worth retrying and which are
   * money burnt.
   */
  unblockerProvider: (process.env.UNBLOCKER_PROVIDER?.trim().toLowerCase() || null) as
    | 'zyte'
    | 'brightdata'
    | 'scrapingbee'
    | 'scraperapi'
    | null,
  unblockerApiKey: process.env.UNBLOCKER_API_KEY?.trim() || null,
  /** Bright Data addresses its unlocker by zone; ignored by the others. */
  unblockerZone: process.env.UNBLOCKER_ZONE?.trim() || null,
  /**
   * Hard ceiling on paid calls in a single run.
   *
   * A per-request charge with no cap is how a scan of 30,000 products turns
   * into an invoice nobody approved, and this project has already had one
   * compute-quota outage. The run carries on without the unblocker once the
   * ceiling is hit; it does not fail.
   */
  unblockerMaxCallsPerRun: optionalInt('UNBLOCKER_MAX_CALLS_PER_RUN', 250),

  get isProduction(): boolean {
    return this.nodeEnv === 'production';
  },
};
