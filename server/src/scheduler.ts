import { env } from './config/env.js';
import { query } from './db/pool.js';
import { logger } from './lib/logger.js';
import { ingestFeedsFromSource } from './import/feedIngest.js';
import { startRun } from './scraping/runner.js';

/**
 * The nightly job: collect today's feeds, then scan competitors.
 *
 * Deliberately one job rather than two schedules. The feed defines what we
 * currently sell, so scanning before collecting it means spending the night
 * checking prices for products that may no longer be on the site and missing
 * the ones that just appeared. Chaining them makes that ordering true by
 * construction instead of by someone setting two times in the right order.
 */

export const NIGHTLY_JOB = 'nightly';

/** A local wall-clock stamp that sorts correctly: "YYYY-MM-DD HH:MM". */
export function localStamp(date: Date, timeZone: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      // h23 rather than hour12:false — the latter renders midnight as "24" in
      // some runtimes, which sorts after everything and never looks due.
      hourCycle: 'h23',
    })
      .formatToParts(date)
      .map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

/** Wall-clock hours between two local stamps. */
function hoursBetween(from: string, to: string): number {
  const parse = (stamp: string) => Date.parse(`${stamp.replace(' ', 'T')}:00Z`);
  return (parse(to) - parse(from)) / 3_600_000;
}

export interface DueCheck {
  due: boolean;
  /** The scheduled moment being considered, as a local stamp. */
  occurrence: string;
  reason: string;
}

/**
 * Should the job run right now?
 *
 * Works in local wall-clock time rather than UTC instants, because "run at
 * 03:00" means 03:00 as the business reads it, in summer and in winter alike.
 *
 * The catch-up window is what makes a restart safe. If the app was down at
 * 03:00 it should still run when it comes back at 03:40 — a day without prices
 * is the failure this job exists to prevent. But coming back at 6pm should
 * wait for tonight rather than starting a full scan in the middle of the
 * afternoon, so catching up is bounded.
 */
export function isDue(options: {
  now: Date;
  at: string;
  timeZone: string;
  lastRunAt: Date | null;
  catchUpHours: number;
}): DueCheck {
  const { now, at, timeZone, lastRunAt, catchUpHours } = options;
  const nowLocal = localStamp(now, timeZone);
  const today = nowLocal.slice(0, 10);

  // The most recent scheduled moment: today's if it has passed, else
  // yesterday's — which is what makes a job configured for 03:00 still
  // considered at 00:30.
  let occurrence = `${today} ${at}`;
  if (nowLocal < occurrence) {
    const yesterday = localStamp(new Date(now.getTime() - 24 * 3_600_000), timeZone).slice(0, 10);
    occurrence = `${yesterday} ${at}`;
  }

  const sinceOccurrence = hoursBetween(occurrence, nowLocal);
  if (sinceOccurrence > catchUpHours) {
    return {
      due: false,
      occurrence,
      reason: `${sinceOccurrence.toFixed(1)}h past ${occurrence} — outside the ${catchUpHours}h catch-up window, waiting for the next one`,
    };
  }

  if (lastRunAt) {
    const lastLocal = localStamp(lastRunAt, timeZone);
    if (lastLocal >= occurrence) {
      return { due: false, occurrence, reason: `already ran at ${lastLocal}` };
    }
  }

  return { due: true, occurrence, reason: `due for ${occurrence}` };
}

async function lastRunAt(name: string): Promise<Date | null> {
  const { rows } = await query<{ last_run_at: Date | null }>(
    'SELECT last_run_at FROM scheduled_jobs WHERE name = $1',
    [name],
  );
  return rows[0]?.last_run_at ?? null;
}

async function recordRun(
  name: string,
  status: 'ok' | 'failed',
  detail: string,
  durationMs: number,
): Promise<void> {
  await query(
    `INSERT INTO scheduled_jobs (name, last_run_at, last_status, last_detail, last_duration_ms, updated_at)
     VALUES ($1, now(), $2, $3, $4, now())
     ON CONFLICT (name) DO UPDATE
       SET last_run_at = EXCLUDED.last_run_at,
           last_status = EXCLUDED.last_status,
           last_detail = EXCLUDED.last_detail,
           last_duration_ms = EXCLUDED.last_duration_ms,
           updated_at = now()`,
    [name, status, detail.slice(0, 2000), durationMs],
  );
}

/**
 * How long a job may sit marked 'running' before it is assumed abandoned.
 *
 * Without this the claim is a one-way door: a process killed mid-scan — a
 * deploy, an out-of-memory, a platform restart — leaves the row saying
 * 'running' with nothing running, and the nightly job never fires again. That
 * failure is completely silent, which makes it the worst kind. A real scan
 * taking longer than this is pathological in its own right.
 */
const STALE_CLAIM_HOURS = 12;

/**
 * Claim tonight's run before doing any of it.
 *
 * The timestamp is written up front rather than on completion, and only if no
 * one else holds the claim. A scrape takes hours; recording it afterwards
 * would leave every tick in between seeing a job that has not run and starting
 * another one.
 */
async function claim(name: string, occurrence: string): Promise<boolean> {
  const { rows } = await query<{ name: string }>(
    `INSERT INTO scheduled_jobs (name, last_run_at, last_status, last_detail, updated_at)
     VALUES ($1, now(), 'running', $2, now())
     ON CONFLICT (name) DO UPDATE
       SET last_run_at = now(), last_status = 'running', last_detail = $2, updated_at = now()
       WHERE scheduled_jobs.last_status IS DISTINCT FROM 'running'
          OR scheduled_jobs.last_run_at < now() - ($3::int * interval '1 hour')
     RETURNING name`,
    [name, `claimed ${occurrence}`, STALE_CLAIM_HOURS],
  );
  return rows.length > 0;
}

/** Collect feeds, then scan. Exported so Admin can trigger it by hand. */
export async function runNightlyJob(): Promise<{ feeds: string; scan: string }> {
  const summary = { feeds: 'skipped', scan: 'not started' };

  const ingest = await ingestFeedsFromSource();
  if (!ingest.configured) {
    summary.feeds = 'no feed location configured — catalogue not refreshed';
    logger.warn('scheduler', summary.feeds);
  } else {
    const imported = ingest.outcomes.filter((entry) => entry.status === 'imported').length;
    const failed = ingest.outcomes.filter((entry) => entry.status === 'failed').length;
    summary.feeds = `${imported} imported, ${failed} failed, ${ingest.outcomes.length} site(s) checked`;
  }

  // Deliberately not conditional on the feed import succeeding. A stale
  // catalogue is a much smaller problem than a night with no competitor
  // prices at all, and yesterday's products are still broadly the right ones.
  const run = await startRun({ mode: 'both', trigger: 'scheduled' });
  summary.scan = `run #${run.id} started`;

  return summary;
}

let timer: NodeJS.Timeout | null = null;

async function tick(): Promise<void> {
  try {
    const check = isDue({
      now: new Date(),
      at: env.scheduleAt,
      timeZone: env.scheduleTimeZone,
      lastRunAt: await lastRunAt(NIGHTLY_JOB),
      catchUpHours: env.scheduleCatchUpHours,
    });

    if (!check.due) return;
    if (!(await claim(NIGHTLY_JOB, check.occurrence))) {
      logger.info('scheduler', 'another run is already in progress; standing down');
      return;
    }

    logger.info('scheduler', `starting the nightly job (${check.reason})`);
    const startedAt = Date.now();

    try {
      const summary = await runNightlyJob();
      await recordRun(
        NIGHTLY_JOB,
        'ok',
        `feeds: ${summary.feeds}; scan: ${summary.scan}`,
        Date.now() - startedAt,
      );
      logger.info('scheduler', `nightly job started: ${summary.feeds}; ${summary.scan}`);
    } catch (err) {
      await recordRun(NIGHTLY_JOB, 'failed', (err as Error).message, Date.now() - startedAt);
      logger.error('scheduler', `nightly job failed: ${(err as Error).message}`, err);
    }
  } catch (err) {
    // A tick must never throw: an unhandled rejection here would take the
    // whole process down and stop every future night as well as this one.
    logger.error('scheduler', `scheduler tick failed: ${(err as Error).message}`, err);
  }
}

export function startScheduler(): void {
  if (!env.scheduleEnabled) {
    logger.info('scheduler', 'disabled (set SCHEDULE_ENABLED=true to run nightly)');
    return;
  }
  if (timer) return;

  logger.info(
    'scheduler',
    `nightly job at ${env.scheduleAt} ${env.scheduleTimeZone}, catching up within ${env.scheduleCatchUpHours}h`,
  );

  // A minute is fine: the job runs once a day and the due check is cheap. The
  // timer is unref'd so it never holds the process open on shutdown.
  timer = setInterval(() => void tick(), 60_000);
  timer.unref();
  void tick();
}

export function stopScheduler(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

export interface SchedulerStatus {
  enabled: boolean;
  at: string;
  timeZone: string;
  lastRunAt: string | null;
  lastStatus: string | null;
  lastDetail: string | null;
  lastDurationMs: number | null;
}

export async function schedulerStatus(): Promise<SchedulerStatus> {
  const { rows } = await query<{
    last_run_at: Date | null;
    last_status: string | null;
    last_detail: string | null;
    last_duration_ms: number | null;
  }>(
    'SELECT last_run_at, last_status, last_detail, last_duration_ms FROM scheduled_jobs WHERE name = $1',
    [NIGHTLY_JOB],
  );
  const row = rows[0];
  return {
    enabled: env.scheduleEnabled,
    at: env.scheduleAt,
    timeZone: env.scheduleTimeZone,
    lastRunAt: row?.last_run_at ? new Date(row.last_run_at).toISOString() : null,
    lastStatus: row?.last_status ?? null,
    lastDetail: row?.last_detail ?? null,
    lastDurationMs: row?.last_duration_ms ?? null,
  };
}
