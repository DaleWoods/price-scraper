import { useEffect, useRef, useState } from 'react';
import { api, type RunProgress, type RunProgressCompetitor } from '../api';

/**
 * Live progress of a check of every product, competitor by competitor.
 *
 * Each competitor goes through three stages: reading their catalogue (the long
 * one — a page every second or two, thousands of pages), matching it against
 * our products, then recording prices. Reading is shown page by page; the two
 * short stages after it make up the last part of each bar.
 */
/**
 * The work for one competitor, in pages: the prices of products already
 * matched there, re-read first, then their catalogue.
 */
function workOf(entry: RunProgressCompetitor): number {
  return (entry.pricesTotal ?? 0) + entry.pagesTotal;
}

function fractionOf(entry: RunProgressCompetitor): number {
  switch (entry.stage) {
    case 'waiting':
      return 0;
    case 'repricing': {
      const total = entry.pricesTotal ?? 0;
      return total > 0 ? 0.15 * Math.min(1, (entry.pricesChecked ?? 0) / total) : 0.01;
    }
    case 'reading': {
      const work = workOf(entry);
      if (work <= 0 || entry.pagesTotal <= 0) return 0.02;
      return 0.9 * Math.min(1, ((entry.pricesChecked ?? 0) + entry.pagesRead) / work);
    }
    case 'searching':
      return entry.pagesTotal > 0 ? 0.9 * Math.min(1, entry.pagesRead / entry.pagesTotal) : 0.02;
    case 'matching':
      return 0.92;
    case 'pricing':
      return 0.96;
    default:
      return 1;
  }
}

/**
 * Seconds this competitor still needs to finish reading, from its own pace so
 * far. Null until it has read enough pages to judge by.
 */
function secondsLeft(entry: RunProgressCompetitor): number | null {
  if ((entry.stage !== 'reading' && entry.stage !== 'searching') || !entry.readingSince || entry.pagesRead < 5 || entry.pagesTotal <= 0) return null;
  const spent = (Date.now() - new Date(entry.readingSince).getTime()) / 1000;
  return (spent / entry.pagesRead) * Math.max(0, entry.pagesTotal - entry.pagesRead);
}

function describe(entry: RunProgressCompetitor): string {
  switch (entry.stage) {
    case 'waiting':
      return 'Starting…';
    case 'repricing':
      return (entry.pricesTotal ?? 0) > 0
        ? `Re-checking today's price of the ${(entry.pricesTotal ?? 0).toLocaleString('en-GB')} products already matched — ${(entry.pricesChecked ?? 0).toLocaleString('en-GB')} done`
        : 'Re-checking prices of products already matched…';
    case 'reading': {
      if (entry.pagesTotal <= 0) return 'Finding their product pages…';
      const left = secondsLeft(entry);
      return (
        `Reading their range — ${entry.pagesRead.toLocaleString('en-GB')} of ${entry.pagesTotal.toLocaleString('en-GB')} pages` +
        (left != null ? ` · about ${duration(left)} left` : '')
      );
    }
    case 'searching': {
      const left = secondsLeft(entry);
      return (
        `Looking for the list's products — ${entry.pagesRead.toLocaleString('en-GB')} of ${entry.pagesTotal.toLocaleString('en-GB')}` +
        (left != null ? ` · about ${duration(left)} left` : '')
      );
    }
    case 'matching':
      return 'Matching against our products…';
    case 'pricing':
      return `Pricing what was newly found — ${entry.matched.toLocaleString('en-GB')} new matches here`;
    case 'done':
      return entry.pagesTotal === 0 && entry.matched === 0
        ? 'Nothing to read — no product pages could be listed for this site'
        : `Done — ${((entry.pricesTotal ?? 0) + entry.matched).toLocaleString('en-GB')} of our products priced here` +
          ((entry.pricesTotal ?? 0) > 0 && entry.matched > 0 ? ` (${entry.matched.toLocaleString('en-GB')} newly found)` : '');
    case 'failed':
      return 'Stopped before finishing';
  }
}

function duration(seconds: number): string {
  if (seconds < 60) return `${Math.max(1, Math.round(seconds))} sec`;
  const minutes = Math.round(seconds / 60);
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} hr ${minutes % 60} min`;
}

export function RunProgressPanel({
  watch,
  onChange,
  runId,
}: {
  /** A particular run, such as a list being checked; otherwise the latest check of every product. */
  runId?: number | null;
  /** Bumped when a check has just been started, so the panel looks straight away. */
  watch?: number;
  /** Called every so often while it runs, and once when it finishes, to refresh results. */
  onChange?: () => void;
}) {
  const [progress, setProgress] = useState<RunProgress | null>(null);
  const [running, setRunning] = useState(false);
  const wasRunning = useRef(false);
  const ticks = useRef(0);

  useEffect(() => {
    let cancelled = false;
    let timer: number | null = null;
    const look = async () => {
      try {
        const next = await api.runProgress(runId);
        if (cancelled) return;
        setProgress(next.progress);
        setRunning(next.running);
        ticks.current += 1;
        // Fresh results every half minute while it works, and once at the end.
        if (next.running && ticks.current % 10 === 0) onChange?.();
        if (wasRunning.current && !next.running) onChange?.();
        wasRunning.current = next.running;
        timer = window.setTimeout(look, next.running ? 3000 : 15000);
      } catch {
        if (!cancelled) timer = window.setTimeout(look, 15000);
      }
    };
    void look();
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [watch, runId]);

  if (!progress) return null;
  // A finished check stays on screen for a while, then gets out of the way.
  if (!running && progress.finishedAt && Date.now() - new Date(progress.finishedAt).getTime() > 30 * 60_000) return null;

  const entries = progress.competitors;
  // Weighted by pages: a competitor with 8,000 pages to read is most of the
  // work, and one with a few hundred finishing first says little about the rest.
  // One still finding its pages counts as an average-sized one meanwhile.
  const known = entries.filter((entry) => entry.pagesTotal > 0);
  const typical = known.length > 0 ? known.reduce((sum, entry) => sum + entry.pagesTotal, 0) / known.length : 1;
  // A competitor that finished with nothing to read was no work at all.
  const weight = (entry: RunProgressCompetitor) =>
    entry.pagesTotal > 0
      ? workOf(entry)
      : entry.stage === 'done' || entry.stage === 'failed'
        ? (entry.pricesTotal ?? 0)
        : typical + (entry.pricesTotal ?? 0);
  const totalWeight = entries.reduce((sum, entry) => sum + weight(entry), 0);
  const overall =
    totalWeight === 0 ? 0 : entries.reduce((sum, entry) => sum + weight(entry) * fractionOf(entry), 0) / totalWeight;
  const elapsed = (Date.now() - new Date(progress.startedAt).getTime()) / 1000;
  // Every competitor reads at the same time, so the check ends when the
  // slowest one does: the time left is the longest of theirs, each from its
  // own pace. Shown once every one still reading has a pace to judge by.
  const reading = entries.filter(
    (entry) =>
      entry.stage === 'reading' || entry.stage === 'searching' || entry.stage === 'waiting' || entry.stage === 'repricing',
  );
  const lefts = reading.map(secondsLeft);
  const remaining =
    running && reading.length > 0 && lefts.every((left) => left != null)
      ? Math.max(...(lefts as number[]))
      : running && reading.length === 0
        ? 60
        : null;
  const found = entries.reduce((sum, entry) => sum + entry.matched, 0);

  return (
    <div className="run-progress" role="status" aria-live="polite">
      <div className="feed-progress__head">
        <strong>
          {running
            ? `${progress.kind === 'list' ? 'Checking your list' : 'Checking every product'} — ${Math.round(overall * 100)}% done`
            : progress.competitors.some((entry) => entry.stage === 'failed')
              ? progress.kind === 'list'
                ? 'The check of this list stopped before finishing'
                : 'The last check of every product stopped before finishing'
              : progress.kind === 'list'
                ? 'Check of this list finished'
                : 'Check of every product finished'}
        </strong>
        <span className="small muted">
          {running ? `${duration(elapsed)} so far` : `took ${duration((new Date(progress.finishedAt!).getTime() - new Date(progress.startedAt).getTime()) / 1000)}`}
          {remaining !== null && ` · about ${duration(remaining)} left`}
          {found > 0 && ` · ${found.toLocaleString('en-GB')} matches found`}
        </span>
      </div>
      <div className="feed-progress__bar feed-progress__bar--main">
        <span style={{ width: `${(running ? overall : 1) * 100}%` }} />
      </div>
      <ul className="feed-progress__sites">
        {entries.map((entry) => (
          <li key={entry.slug}>
            <span className="feed-progress__site">{entry.name}</span>
            <div className={`feed-progress__bar${entry.stage === 'failed' ? ' feed-progress__bar--failed' : ''}`}>
              <span style={{ width: `${fractionOf(entry) * 100}%` }} />
            </div>
            <span className="small muted">
              {describe(entry)}
              {entry.note && <> · {entry.note}</>}
            </span>
          </li>
        ))}
      </ul>
      {running && progress.kind === 'list' && (
        <p className="xs muted" style={{ margin: 0 }}>
          Each competitor's site is searched for every product on the list, two pages at a time. Prices fill in below as
          they are found; you can leave this page and come back.
        </p>
      )}
      {running && progress.kind !== 'list' && (
        <p className="xs muted" style={{ margin: 0 }}>
          Runs on the server — you can leave this page and come back. Prices appear in the table as each competitor
          finishes. Each competitor starts by re-checking today's price of every product already matched there, so
          overnight price changes come in first. Then it reads their range for products not yet found — slow the first
          time, much quicker after, because only their new pages and a seventh of the rest need reading again.
        </p>
      )}
    </div>
  );
}
