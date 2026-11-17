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
function fractionOf(entry: RunProgressCompetitor): number {
  switch (entry.stage) {
    case 'waiting':
      return 0;
    case 'reading':
      return entry.pagesTotal > 0 ? 0.85 * Math.min(1, entry.pagesRead / entry.pagesTotal) : 0.02;
    case 'matching':
      return 0.88;
    case 'pricing':
      return 0.93;
    default:
      return 1;
  }
}

function describe(entry: RunProgressCompetitor): string {
  switch (entry.stage) {
    case 'waiting':
      return 'Waiting its turn';
    case 'reading':
      return entry.pagesTotal > 0
        ? `Reading their range — ${entry.pagesRead.toLocaleString('en-GB')} of ${entry.pagesTotal.toLocaleString('en-GB')} pages`
        : 'Finding their product pages…';
    case 'matching':
      return 'Matching against our products…';
    case 'pricing':
      return `Recording prices — ${entry.matched.toLocaleString('en-GB')} of our products found here`;
    case 'done':
      return `Done — ${entry.matched.toLocaleString('en-GB')} of our products found here`;
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
}: {
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
        const next = await api.runProgress();
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
  }, [watch]);

  if (!progress) return null;
  // A finished check stays on screen for a while, then gets out of the way.
  if (!running && progress.finishedAt && Date.now() - new Date(progress.finishedAt).getTime() > 30 * 60_000) return null;

  const entries = progress.competitors;
  // Weighted by pages: a competitor with 8,000 pages to read is most of the
  // work, and one with a few hundred finishing first says little about the rest.
  // One still finding its pages counts as an average-sized one meanwhile.
  const known = entries.filter((entry) => entry.pagesTotal > 0);
  const typical = known.length > 0 ? known.reduce((sum, entry) => sum + entry.pagesTotal, 0) / known.length : 1;
  const weight = (entry: RunProgressCompetitor) => (entry.pagesTotal > 0 ? entry.pagesTotal : typical);
  const totalWeight = entries.reduce((sum, entry) => sum + weight(entry), 0);
  const overall =
    totalWeight === 0 ? 0 : entries.reduce((sum, entry) => sum + weight(entry) * fractionOf(entry), 0) / totalWeight;
  const elapsed = (Date.now() - new Date(progress.startedAt).getTime()) / 1000;
  const remaining = running && overall > 0.03 && elapsed > 60 ? (elapsed / overall) * (1 - overall) : null;
  const found = entries.reduce((sum, entry) => sum + entry.matched, 0);

  return (
    <div className="run-progress" role="status" aria-live="polite">
      <div className="feed-progress__head">
        <strong>
          {running
            ? `Checking every product — ${Math.round(overall * 100)}% done`
            : progress.competitors.some((entry) => entry.stage === 'failed')
              ? 'The last check of every product stopped before finishing'
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
      {running && (
        <p className="xs muted" style={{ margin: 0 }}>
          Runs on the server — you can leave this page and come back. Prices appear in the table as each competitor
          finishes.
        </p>
      )}
    </div>
  );
}
