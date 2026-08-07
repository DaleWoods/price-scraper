import { useCallback, useEffect, useState } from 'react';
import {
  api,
  ApiError,
  formatDateTime,
  relativeTime,
  type Competitor,
  type RunItem,
  type ScrapeRun,
} from '../api';
import { Alert, Card, EmptyState, TableSkeleton, useToast } from '../components/ui';

const MODE_COPY: Record<string, string> = {
  prices: 'Scrape prices for confirmed matches only',
  discover: 'Search for candidate matches for unmatched products',
  both: 'Scrape confirmed matches, then look for new candidates',
};

const ERROR_KIND_COPY: Record<string, string> = {
  robots_disallowed: 'Blocked by robots.txt',
  blocked: 'Site actively blocked us',
  not_found: 'Listing 404s',
  layout_changed: 'Page layout changed',
  no_price_found: 'No price on the page',
  implausible_price: 'Price failed sanity check',
  timeout: 'Timed out',
  http_error: 'HTTP error',
  navigation_failed: 'Navigation failed',
  brand_not_stocked: 'Brand not stocked',
};

export function RunsPage() {
  const toast = useToast();
  const [runs, setRuns] = useState<ScrapeRun[]>([]);
  const [activeRunId, setActiveRunId] = useState<number | null>(null);
  const [competitors, setCompetitors] = useState<Competitor[]>([]);
  const [selectedRun, setSelectedRun] = useState<{ run: ScrapeRun; items: RunItem[] } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [mode, setMode] = useState('both');
  const [competitorId, setCompetitorId] = useState('');
  const [limit, setLimit] = useState('25');

  const load = useCallback(async () => {
    try {
      const response = await api.runs();
      setRuns(response.runs);
      setActiveRunId(response.activeRunId);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load runs');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    void api
      .competitors()
      .then((response) => setCompetitors(response.competitors))
      .catch(() => undefined);
  }, [load]);

  // Poll while a run is in flight so counters move without a manual refresh.
  useEffect(() => {
    if (activeRunId === null) return;
    const timer = setInterval(() => void load(), 4000);
    return () => clearInterval(timer);
  }, [activeRunId, load]);

  const start = async () => {
    try {
      const { run } = await api.startRun({
        mode,
        competitorId: competitorId ? Number(competitorId) : null,
        limit: limit ? Number(limit) : null,
      });
      toast(`Run #${run.id} started.`, 'ok');
      void load();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not start the run', 'error');
    }
  };

  const openRun = async (id: number) => {
    try {
      setSelectedRun(await api.run(id));
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not load that run', 'error');
    }
  };

  return (
    <div className="page">
      <p className="page__intro">
        The MVP has no scheduler — runs are triggered here by hand. Every target produces a row, so a
        competitor changing their layout shows up as a scrape error rather than a silently wrong price.
      </p>

      {error && <Alert tone="danger" title="Could not load runs">{error}</Alert>}

      <Card title="Run now" subtitle={MODE_COPY[mode]}>
        <div className="filter-bar">
          <div className="field">
            <label className="label" htmlFor="mode">
              Mode
            </label>
            <select id="mode" className="select" value={mode} onChange={(event) => setMode(event.target.value)}>
              <option value="both">Prices + discovery</option>
              <option value="prices">Prices only</option>
              <option value="discover">Discovery only</option>
            </select>
          </div>
          <div className="field">
            <label className="label" htmlFor="competitor">
              Competitor
            </label>
            <select
              id="competitor"
              className="select"
              value={competitorId}
              onChange={(event) => setCompetitorId(event.target.value)}
            >
              <option value="">All enabled</option>
              {competitors
                .filter((competitor) => competitor.enabled)
                .map((competitor) => (
                  <option key={competitor.id} value={competitor.id}>
                    {competitor.display_name}
                  </option>
                ))}
            </select>
          </div>
          <div className="field">
            <label className="label" htmlFor="limit">
              Product limit
            </label>
            <input
              id="limit"
              className="input"
              type="number"
              min={1}
              value={limit}
              onChange={(event) => setLimit(event.target.value)}
              style={{ width: 110 }}
            />
          </div>
          <button
            type="button"
            className="btn btn--accent"
            onClick={start}
            disabled={activeRunId !== null}
          >
            {activeRunId !== null ? (
              <>
                <span className="spinner" /> Run #{activeRunId} in progress
              </>
            ) : (
              'Start run'
            )}
          </button>
        </div>

        <p className="small muted" style={{ marginTop: 'var(--sp-4)' }}>
          Requests are rate-limited per domain with randomised delays, and robots.txt is checked before
          every fetch. Keep the product limit low for the first runs against a new competitor.
        </p>
      </Card>

      <Card title="Recent runs" bodyless>
        {loading ? (
          <TableSkeleton columns={6} />
        ) : runs.length === 0 ? (
          <EmptyState mark="↻" title="No runs yet" body="Trigger your first run above." />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Run</th>
                  <th>Status</th>
                  <th>Competitor</th>
                  <th className="num">OK</th>
                  <th className="num">Errors</th>
                  <th className="num">Skipped</th>
                  <th className="num">Started</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((run) => (
                  <tr key={run.id} className="table__row--clickable" onClick={() => void openRun(run.id)}>
                    <td className="cell-primary mono">#{run.id}</td>
                    <td>
                      <span
                        className={`badge badge--${
                          run.status === 'completed' ? 'lower' : run.status === 'failed' ? 'higher' : 'warn'
                        }`}
                      >
                        {run.status === 'running' && <span className="badge__dot" />}
                        {run.status}
                      </span>
                    </td>
                    <td className="small muted">{run.competitor_name ?? 'All enabled'}</td>
                    <td className="num">{run.ok_count}</td>
                    <td className="num" style={{ color: run.error_count > 0 ? 'var(--pos-higher-fg)' : undefined }}>
                      {run.error_count}
                    </td>
                    <td className="num muted">{run.skipped_count}</td>
                    <td className="num xs muted nowrap">{relativeTime(run.started_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {selectedRun && (
        <Card
          title={`Run #${selectedRun.run.id} detail`}
          subtitle={`Started ${formatDateTime(selectedRun.run.started_at)} · errors listed first`}
          actions={
            <button type="button" className="btn btn--sm btn--ghost" onClick={() => setSelectedRun(null)}>
              Close
            </button>
          }
          bodyless
        >
          {selectedRun.run.error && (
            <div style={{ padding: 'var(--sp-4) var(--sp-6) 0' }}>
              <Alert tone="danger" title="Run failed">
                {selectedRun.run.error}
              </Alert>
            </div>
          )}
          {selectedRun.items.length === 0 ? (
            <EmptyState title="No items recorded" body="This run had nothing to do." />
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Product</th>
                    <th>Competitor</th>
                    <th>Status</th>
                    <th>Detail</th>
                    <th className="num">Took</th>
                  </tr>
                </thead>
                <tbody>
                  {selectedRun.items.map((item) => (
                    <tr key={item.id}>
                      <td>
                        <div className="cell-primary truncate" style={{ maxWidth: 220 }}>
                          {item.product_name ?? '—'}
                        </div>
                        <div className="cell-secondary mono">{item.internal_sku ?? ''}</div>
                      </td>
                      <td className="small muted">{item.competitor_name ?? '—'}</td>
                      <td>
                        <span
                          className={`badge badge--${
                            item.status === 'ok' ? 'lower' : item.status === 'error' ? 'higher' : 'neutral'
                          }`}
                        >
                          {item.status === 'error' && item.error_kind
                            ? (ERROR_KIND_COPY[item.error_kind] ?? item.error_kind)
                            : item.status}
                        </span>
                      </td>
                      <td className="xs muted" style={{ maxWidth: 420 }}>
                        {item.error ?? '—'}
                        {item.url && (
                          <div>
                            <a href={item.url} target="_blank" rel="noreferrer noopener">
                              {item.url.slice(0, 70)}…
                            </a>
                          </div>
                        )}
                      </td>
                      <td className="num xs muted">{item.duration_ms ? `${(item.duration_ms / 1000).toFixed(1)}s` : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}
    </div>
  );
}
