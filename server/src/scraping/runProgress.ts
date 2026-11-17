/**
 * How far a check of every product has got, competitor by competitor, for the
 * progress bars on All products and Check prices.
 *
 * A full check reads each competitor's whole catalogue — thousands of pages,
 * a page every second or two — then matches it against our products and
 * records the prices. That is hours of work, and a run that only says
 * "running" for hours looks stuck. This keeps the live position in memory:
 * it is about what is happening now, so nothing needs storing, and a restart
 * (which ends the run anyway) starts it afresh.
 */
export type CompetitorStage =
  | 'waiting'
  | 'repricing'
  | 'reading'
  | 'searching'
  | 'matching'
  | 'pricing'
  | 'done'
  | 'failed';

export interface CompetitorProgress {
  slug: string;
  name: string;
  stage: CompetitorStage;
  /**
   * Catalogue pages read so far, and how many this run means to read. While
   * searching for a list's products, products searched for and how many.
   */
  pagesRead: number;
  pagesTotal: number;
  /** Our products found at this competitor by this run. */
  matched: number;
  /** Products already matched here whose price has been re-read, of how many. */
  pricesChecked: number;
  pricesTotal: number;
  /** Set when the run stopped short, e.g. at its time limit. */
  note: string | null;
  /** When reading began, so the page can work out this site's own pace. */
  readingSince: string | null;
}

export interface RunProgress {
  runId: number;
  /** A check of every product, or of a list of products. */
  kind: 'full' | 'list';
  startedAt: string;
  finishedAt: string | null;
  competitors: CompetitorProgress[];
}

const progressByRun = new Map<number, RunProgress>();
/** Only the latest few are kept: older ones are history, held in scrape_runs. */
const KEEP = 5;

export function beginRunProgress(
  runId: number,
  competitors: { slug: string; display_name: string }[],
  kind: 'full' | 'list' = 'full',
): void {
  progressByRun.set(runId, {
    runId,
    kind,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    competitors: competitors.map((competitor) => ({
      slug: competitor.slug,
      name: competitor.display_name,
      stage: 'waiting',
      pagesRead: 0,
      pagesTotal: 0,
      matched: 0,
      pricesChecked: 0,
      pricesTotal: 0,
      note: null,
      readingSince: null,
    })),
  });
  while (progressByRun.size > KEEP) {
    const oldest = progressByRun.keys().next().value;
    if (oldest === undefined) break;
    progressByRun.delete(oldest);
  }
}

export function updateCompetitorProgress(
  runId: number,
  slug: string,
  change: Partial<Omit<CompetitorProgress, 'slug' | 'name'>> | ((entry: CompetitorProgress) => void),
): void {
  const entry = progressByRun.get(runId)?.competitors.find((competitor) => competitor.slug === slug);
  if (!entry) return;
  if (typeof change === 'function') change(entry);
  else Object.assign(entry, change);
}

export function finishRunProgress(runId: number, failed = false): void {
  const progress = progressByRun.get(runId);
  if (!progress) return;
  progress.finishedAt = new Date().toISOString();
  for (const entry of progress.competitors) {
    if (entry.stage !== 'done') entry.stage = failed ? 'failed' : 'done';
  }
}

export function getRunProgress(runId: number): RunProgress | null {
  return progressByRun.get(runId) ?? null;
}

/** The most recent check of that kind, running or just finished. */
export function latestRunProgress(kind: 'full' | 'list' | null = null): RunProgress | null {
  let latest: RunProgress | null = null;
  for (const progress of progressByRun.values()) if (kind == null || progress.kind === kind) latest = progress;
  return latest;
}
