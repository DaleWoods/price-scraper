import { query } from '../db/pool.js';

/**
 * Scrape health per competitor (Spec §3: "success rate per competitor;
 * breakages flagged, not silently wrong").
 *
 * The subtlety that makes or breaks this report is the denominator. A run item
 * is one of three things, and only two of them are an *attempt*:
 *
 *   ok      — we asked and nothing went wrong.
 *   error   — we asked and it failed.
 *   skipped — we never asked. Either the competitor does not stock the brand,
 *             or nothing in their sitemap resembled the product.
 *
 * Most of our range is not carried by most competitors, so `skipped` is the
 * normal majority outcome by a wide margin. Counting it as failure would make
 * every competitor read as ~5% healthy and the report would be worse than
 * useless. Attempts are therefore ok + error only.
 *
 * `robots_disallowed` gets the same treatment in spirit: it is the system
 * correctly honouring a competitor's rules, not a breakage, so it is reported
 * as its own figure rather than being buried in the error count.
 */

export interface CompetitorHealth {
  competitorId: number;
  competitorName: string;
  competitorSlug: string;
  enabled: boolean;
  /** ok + error. Deliberately excludes skipped — we never asked. */
  attempts: number;
  ok: number;
  errored: number;
  skipped: number;
  /** Of the errors, the ones that are a policy outcome rather than a breakage. */
  robotsDisallowed: number;
  /** ok / attempts as a percentage, or null when nothing was attempted at all. */
  successPct: number | null;
  /** Error kinds by frequency, worst first. */
  topErrors: { kind: string; count: number }[];
  lastOkAt: string | null;
  lastErrorAt: string | null;
  lastErrorKind: string | null;
  lastErrorMessage: string | null;
  medianDurationMs: number | null;
  /**
   * Which walls this competitor put up, worst first, when any did.
   *
   * Separate from `topErrors` because the remedies are unrelated: a
   * `layout_changed` is a selector to fix, whereas a block is a decision about
   * whether this source is reachable at all — and *which* block decides
   * whether the answer is "slow down", "ask them for access", or "drop it".
   */
  blockCauses: { cause: string; count: number }[];
}

export interface ScrapeHealthReport {
  windowDays: number;
  competitors: CompetitorHealth[];
}

interface HealthRow {
  competitor_id: number;
  competitor_name: string;
  competitor_slug: string;
  enabled: boolean;
  attempts: string | number;
  ok: string | number;
  errored: string | number;
  skipped: string | number;
  robots_disallowed: string | number;
  last_ok_at: string | null;
  last_error_at: string | null;
  median_duration_ms: string | number | null;
}

const num = (value: string | number | null | undefined): number => Number(value ?? 0);

export async function getScrapeHealth(days = 7): Promise<ScrapeHealthReport> {
  // Driven from `competitors` with a LEFT JOIN so a competitor with no activity
  // still gets a row — those are exactly the ones worth seeing. The window
  // condition belongs in the ON clause: in a WHERE clause it would quietly turn
  // this into an INNER JOIN and drop every quiet competitor from the report.
  const { rows } = await query<HealthRow>(
    `SELECT c.id                                                        AS competitor_id,
            c.display_name                                              AS competitor_name,
            c.slug                                                      AS competitor_slug,
            c.enabled,
            count(*) FILTER (WHERE i.status IN ('ok', 'error'))         AS attempts,
            count(*) FILTER (WHERE i.status = 'ok')                     AS ok,
            count(*) FILTER (WHERE i.status = 'error')                  AS errored,
            count(*) FILTER (WHERE i.status = 'skipped')                AS skipped,
            count(*) FILTER (WHERE i.error_kind = 'robots_disallowed')  AS robots_disallowed,
            max(i.created_at) FILTER (WHERE i.status = 'ok')            AS last_ok_at,
            max(i.created_at) FILTER (WHERE i.status = 'error')         AS last_error_at,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY i.duration_ms)
              FILTER (WHERE i.duration_ms IS NOT NULL)                  AS median_duration_ms
     FROM competitors c
     LEFT JOIN scrape_run_items i
       ON i.competitor_id = c.id
      AND i.created_at >= now() - ($1::int * interval '1 day')
     GROUP BY c.id, c.display_name, c.slug, c.enabled
     ORDER BY c.display_name`,
    [days],
  );

  const { rows: errorRows } = await query<{
    competitor_id: number;
    error_kind: string | null;
    count: number;
  }>(
    `SELECT competitor_id, error_kind, count(*)::int AS count
     FROM scrape_run_items
     WHERE status = 'error'
       AND competitor_id IS NOT NULL
       AND created_at >= now() - ($1::int * interval '1 day')
     GROUP BY competitor_id, error_kind
     ORDER BY count DESC`,
    [days],
  );

  const { rows: lastErrors } = await query<{
    competitor_id: number;
    error_kind: string | null;
    error: string | null;
  }>(
    `SELECT DISTINCT ON (competitor_id) competitor_id, error_kind, error
     FROM scrape_run_items
     WHERE status = 'error'
       AND competitor_id IS NOT NULL
       AND created_at >= now() - ($1::int * interval '1 day')
     ORDER BY competitor_id, created_at DESC`,
    [days],
  );

  const { rows: blockRows } = await query<{
    competitor_id: number;
    block_cause: string;
    count: number;
  }>(
    `SELECT competitor_id, block_cause, count(*)::int AS count
     FROM scrape_run_items
     WHERE block_cause IS NOT NULL
       AND competitor_id IS NOT NULL
       AND created_at >= now() - ($1::int * interval '1 day')
     GROUP BY competitor_id, block_cause
     ORDER BY count DESC`,
    [days],
  );

  const blocksByCompetitor = new Map<number, { cause: string; count: number }[]>();
  for (const row of blockRows) {
    const list = blocksByCompetitor.get(row.competitor_id) ?? [];
    list.push({ cause: row.block_cause, count: row.count });
    blocksByCompetitor.set(row.competitor_id, list);
  }

  const errorsByCompetitor = new Map<number, { kind: string; count: number }[]>();
  for (const row of errorRows) {
    const list = errorsByCompetitor.get(row.competitor_id) ?? [];
    list.push({ kind: row.error_kind ?? 'unknown', count: row.count });
    errorsByCompetitor.set(row.competitor_id, list);
  }
  const lastErrorByCompetitor = new Map(lastErrors.map((row) => [row.competitor_id, row]));

  const competitors: CompetitorHealth[] = rows.map((row) => {
    const attempts = num(row.attempts);
    const ok = num(row.ok);
    const lastError = lastErrorByCompetitor.get(row.competitor_id);

    return {
      competitorId: row.competitor_id,
      competitorName: row.competitor_name,
      competitorSlug: row.competitor_slug,
      enabled: row.enabled,
      attempts,
      ok,
      errored: num(row.errored),
      skipped: num(row.skipped),
      robotsDisallowed: num(row.robots_disallowed),
      // Null rather than 0: "never tried" and "tried and failed every time" are
      // opposite states and must not render identically.
      successPct: attempts === 0 ? null : Math.round((ok / attempts) * 1000) / 10,
      topErrors: errorsByCompetitor.get(row.competitor_id) ?? [],
      lastOkAt: row.last_ok_at,
      lastErrorAt: row.last_error_at,
      lastErrorKind: lastError?.error_kind ?? null,
      lastErrorMessage: lastError?.error ?? null,
      medianDurationMs:
        row.median_duration_ms == null ? null : Math.round(Number(row.median_duration_ms)),
      blockCauses: blocksByCompetitor.get(row.competitor_id) ?? [],
    };
  });

  return { windowDays: days, competitors };
}
