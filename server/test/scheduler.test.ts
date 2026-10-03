import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { isDue, localStamp } from '../src/scheduler.js';

/**
 * Whether the nightly job is due.
 *
 * Both failure directions are expensive and silent. Not firing means a day
 * with no competitor prices, which nobody notices until the comparison is
 * quietly stale. Firing twice means two overlapping scans competing for the
 * same compute — and this project has already had an outage from that.
 */
const TZ = 'Europe/London';
const at = (iso: string) => new Date(iso);

describe('localStamp', () => {
  it('renders UK local time, not UTC', () => {
    // 1 July is BST, so London is an hour ahead of UTC.
    assert.equal(localStamp(at('2026-07-01T02:30:00Z'), TZ), '2026-07-01 03:30');
  });

  it('renders GMT correctly in winter', () => {
    assert.equal(localStamp(at('2026-01-15T02:30:00Z'), TZ), '2026-01-15 02:30');
  });

  it('renders midnight as 00, not 24', () => {
    // hour12:false gives "24" in some runtimes, which sorts after everything
    // and would make a job scheduled near midnight never look due.
    assert.equal(localStamp(at('2026-01-15T00:10:00Z'), TZ), '2026-01-15 00:10');
  });
});

describe('isDue', () => {
  it('fires when the scheduled time has passed and it has not run', () => {
    const check = isDue({
      now: at('2026-01-15T03:05:00Z'),
      at: '03:00',
      timeZone: TZ,
      lastRunAt: null,
      catchUpHours: 4,
    });
    assert.equal(check.due, true);
    assert.equal(check.occurrence, '2026-01-15 03:00');
  });

  it('does not fire before the scheduled time', () => {
    const check = isDue({
      now: at('2026-01-15T02:30:00Z'),
      at: '03:00',
      timeZone: TZ,
      lastRunAt: at('2026-01-14T03:00:00Z'),
      catchUpHours: 4,
    });
    assert.equal(check.due, false);
    // Before today's 03:00, the occurrence under consideration is yesterday's.
    assert.equal(check.occurrence, '2026-01-14 03:00');
  });

  it('does not fire twice for the same night', () => {
    const check = isDue({
      now: at('2026-01-15T05:00:00Z'),
      at: '03:00',
      timeZone: TZ,
      lastRunAt: at('2026-01-15T03:01:00Z'),
      catchUpHours: 4,
    });
    assert.equal(check.due, false);
    assert.match(check.reason, /already ran/);
  });

  it('catches up after a restart inside the window', () => {
    // The app was down at 03:00 and came back at 03:40. A day without prices
    // is exactly what this job exists to prevent.
    const check = isDue({
      now: at('2026-01-15T03:40:00Z'),
      at: '03:00',
      timeZone: TZ,
      lastRunAt: at('2026-01-14T03:00:00Z'),
      catchUpHours: 4,
    });
    assert.equal(check.due, true);
  });

  it('refuses to catch up long after the window', () => {
    // Coming back at 6pm must not start a full scan in the afternoon.
    const check = isDue({
      now: at('2026-01-15T18:00:00Z'),
      at: '03:00',
      timeZone: TZ,
      lastRunAt: at('2026-01-14T03:00:00Z'),
      catchUpHours: 4,
    });
    assert.equal(check.due, false);
    assert.match(check.reason, /catch-up window/);
  });

  it('fires on a fresh database that has never run', () => {
    const check = isDue({
      now: at('2026-01-15T03:30:00Z'),
      at: '03:00',
      timeZone: TZ,
      lastRunAt: null,
      catchUpHours: 4,
    });
    assert.equal(check.due, true);
  });

  it('keeps to UK wall-clock time through British Summer Time', () => {
    // 03:00 must mean 03:00 to the business all year. In BST that is 02:00
    // UTC; a scheduler working in UTC would silently drift an hour twice a
    // year and run in the middle of the evening half the time.
    const duringBst = isDue({
      now: at('2026-07-01T02:05:00Z'), // 03:05 London
      at: '03:00',
      timeZone: TZ,
      lastRunAt: at('2026-06-30T02:00:00Z'),
      catchUpHours: 4,
    });
    assert.equal(duringBst.due, true);
    assert.equal(duringBst.occurrence, '2026-07-01 03:00');

    const stillTooEarly = isDue({
      now: at('2026-07-01T01:30:00Z'), // 02:30 London
      at: '03:00',
      timeZone: TZ,
      lastRunAt: at('2026-06-30T02:00:00Z'),
      catchUpHours: 4,
    });
    assert.equal(stillTooEarly.due, false);
  });

  it('runs once, not twice, on the day the clocks go back', () => {
    // 25 October 2026: 02:00 BST becomes 01:00 GMT, so 01:00–01:59 happens
    // twice. A job at 03:00 is clear of it, and having run must stay run
    // through the repeated hour.
    const after = isDue({
      now: at('2026-10-25T03:30:00Z'), // 03:30 GMT, after the change
      at: '03:00',
      timeZone: TZ,
      lastRunAt: at('2026-10-25T03:05:00Z'),
      catchUpHours: 4,
    });
    assert.equal(after.due, false, 'the repeated hour must not trigger a second run');
  });

  it('treats a job scheduled near midnight correctly', () => {
    const check = isDue({
      now: at('2026-01-15T00:05:00Z'),
      at: '00:00',
      timeZone: TZ,
      lastRunAt: at('2026-01-14T00:00:00Z'),
      catchUpHours: 4,
    });
    assert.equal(check.due, true);
    assert.equal(check.occurrence, '2026-01-15 00:00');
  });

  it('looks back to yesterday when the time has not come round yet today', () => {
    // At 00:30 with a 03:00 schedule, the occurrence under consideration is
    // yesterday's — and if that one ran, there is nothing to do.
    const check = isDue({
      now: at('2026-01-15T00:30:00Z'),
      at: '03:00',
      timeZone: TZ,
      lastRunAt: at('2026-01-14T03:02:00Z'),
      catchUpHours: 24,
    });
    assert.equal(check.due, false);
    assert.equal(check.occurrence, '2026-01-14 03:00');
  });
});

/**
 * Claiming the run.
 *
 * The claim is what stops two ticks both starting a scan, and the staleness
 * escape is what stops a killed process locking the job out forever. Both are
 * SQL conditions that cannot be checked by reading them.
 */
const DATABASE_URL = process.env.DATABASE_URL;

describe('claiming the nightly run', { skip: !DATABASE_URL && 'DATABASE_URL not set' }, () => {
  let query: typeof import('../src/db/pool.ts').query;
  let closePool: typeof import('../src/db/pool.ts').closePool;
  const JOB = 'tst-nightly';
  const STALE_CLAIM_HOURS = 12;

  /** The same statement the scheduler claims with. */
  async function tryClaim(): Promise<boolean> {
    const { rows } = await query<{ name: string }>(
      `INSERT INTO scheduled_jobs (name, last_run_at, last_status, last_detail, updated_at)
       VALUES ($1, now(), 'running', 'claimed', now())
       ON CONFLICT (name) DO UPDATE
         SET last_run_at = now(), last_status = 'running', last_detail = 'claimed', updated_at = now()
         WHERE scheduled_jobs.last_status IS DISTINCT FROM 'running'
            OR scheduled_jobs.last_run_at < now() - ($2::int * interval '1 hour')
       RETURNING name`,
      [JOB, STALE_CLAIM_HOURS],
    );
    return rows.length > 0;
  }

  before(async () => {
    ({ query, closePool } = await import('../src/db/pool.ts'));
    await query('DELETE FROM scheduled_jobs WHERE name = $1', [JOB]);
  });

  after(async () => {
    await query('DELETE FROM scheduled_jobs WHERE name = $1', [JOB]);
    await closePool();
  });

  it('lets the first caller claim and refuses the second', async () => {
    assert.equal(await tryClaim(), true);
    assert.equal(await tryClaim(), false, 'two overlapping scans is the outage this prevents');
  });

  it('releases the claim once the run finishes', async () => {
    await query(`UPDATE scheduled_jobs SET last_status = 'ok' WHERE name = $1`, [JOB]);
    assert.equal(await tryClaim(), true);
  });

  it('takes over a claim abandoned by a killed process', async () => {
    // Left 'running' with nothing running — a deploy or an OOM mid-scan.
    // Without the staleness escape the job would never fire again, silently.
    await query(
      `UPDATE scheduled_jobs SET last_status = 'running', last_run_at = now() - interval '13 hours'
       WHERE name = $1`,
      [JOB],
    );
    assert.equal(await tryClaim(), true);
  });

  it('does not treat a long but live run as abandoned', async () => {
    await query(
      `UPDATE scheduled_jobs SET last_status = 'running', last_run_at = now() - interval '2 hours'
       WHERE name = $1`,
      [JOB],
    );
    assert.equal(await tryClaim(), false);
  });
});
