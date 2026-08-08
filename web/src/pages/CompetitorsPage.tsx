import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, type Competitor } from '../api';
import { Alert, Card, TableSkeleton, useToast } from '../components/ui';
import { CompetitorLogoUpload } from '../components/CompetitorLogoUpload';

export function CompetitorsPage() {
  const toast = useToast();
  const [competitors, setCompetitors] = useState<Competitor[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [testSlug, setTestSlug] = useState('');
  const [testUrl, setTestUrl] = useState('');
  const [testBusy, setTestBusy] = useState(false);
  const [testResult, setTestResult] = useState<unknown>(null);
  const [testError, setTestError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await api.competitors();
      setCompetitors(response.competitors);
      if (!testSlug && response.competitors[0]) setTestSlug(response.competitors[0].slug);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load competitors');
    } finally {
      setLoading(false);
    }
    // testSlug is only used to pick a sensible default once; re-running on every
    // keystroke would fight the user's selection.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const toggle = async (competitor: Competitor) => {
    try {
      await api.toggleCompetitor(competitor.slug, !competitor.enabled);
      toast(`${competitor.display_name} ${competitor.enabled ? 'disabled' : 'enabled'}.`, 'ok');
      void load();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not update that competitor', 'error');
    }
  };

  const [logoBusy, setLogoBusy] = useState(false);

  /**
   * Logos are cached locally rather than hotlinked, so this needs egress to the
   * competitor domains. Where that is blocked the monogram badges stay, which is
   * a working state rather than a broken one — so a failure is reported as
   * information, not as an error.
   */
  const fetchLogos = async () => {
    setLogoBusy(true);
    try {
      const result = await api.refreshLogos();
      await load();
      if (result.fetched > 0) {
        toast(`Fetched ${result.fetched} logo(s).`, 'ok');
      } else {
        toast(
          result.failed > 0
            ? `No logos reachable (${result.failed} failed) — monogram badges kept.`
            : 'All logos already cached.',
          result.failed > 0 ? 'info' : 'ok',
        );
      }
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Logo fetch failed', 'error');
    } finally {
      setLogoBusy(false);
    }
  };

  const sync = async () => {
    try {
      const response = await api.syncCompetitors();
      toast(`Synced ${response.synced.length} competitor definition(s) from config.`, 'ok');
      void load();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Sync failed', 'error');
    }
  };

  const runTest = async () => {
    setTestBusy(true);
    setTestResult(null);
    setTestError(null);
    try {
      setTestResult(await api.testUrl(testSlug, testUrl));
    } catch (err) {
      setTestError(err instanceof ApiError ? `${err.kind ?? 'error'}: ${err.message}` : 'Test failed');
    } finally {
      setTestBusy(false);
    }
  };

  return (
    <div className="page">
      <p className="page__intro">
        Competitors are defined in <code className="mono">competitors/*.json</code>. Adding a retailer
        is a config file plus a sync — never a code change. Toggle a competitor off here to exclude it
        from runs without deleting its config or its history.
      </p>

      {error && <Alert tone="danger" title="Could not load competitors">{error}</Alert>}

      <Card
        title="Configured competitors"
        subtitle="Loaded from the competitors directory"
        actions={
          <>
            <button
              type="button"
              className="btn btn--sm"
              onClick={fetchLogos}
              disabled={logoBusy}
              title="Download each competitor's icon and cache it locally"
            >
              {logoBusy ? 'Fetching logos…' : 'Fetch logos'}
            </button>
            <button type="button" className="btn btn--sm" onClick={sync}>
              Re-sync from config
            </button>
          </>
        }
        bodyless
      >
        {loading ? (
          <TableSkeleton columns={5} />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Competitor</th>
                  <th>Base URL</th>
                  <th>Brands</th>
                  <th>Cadence</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {competitors.map((competitor) => (
                  <tr key={competitor.id}>
                    <td>
                      <div className="clogo-label">
                        <CompetitorLogoUpload
                          slug={competitor.slug}
                          displayName={competitor.display_name}
                          hasLogo={competitor.has_logo}
                          onChange={load}
                        />
                        <div style={{ minWidth: 0 }}>
                          <div className="cell-primary">{competitor.display_name}</div>
                          <div className="cell-secondary mono">{competitor.slug}</div>
                        </div>
                      </div>
                    </td>
                    <td className="small">
                      <a href={competitor.base_url} target="_blank" rel="noreferrer noopener">
                        {competitor.base_url.replace(/^https?:\/\//, '')}
                      </a>
                    </td>
                    <td className="xs muted" style={{ maxWidth: 260 }}>
                      {competitor.brands.length === 0 ? 'All brands' : competitor.brands.join(', ')}
                    </td>
                    <td className="small muted">{competitor.scrape_frequency}</td>
                    <td>
                      <span className={`badge badge--${competitor.enabled ? 'lower' : 'neutral'}`}>
                        {competitor.enabled ? 'Enabled' : 'Disabled'}
                      </span>
                    </td>
                    <td className="num">
                      <button type="button" className="btn btn--sm" onClick={() => void toggle(competitor)}>
                        {competitor.enabled ? 'Disable' : 'Enable'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card
        title="Test a product URL"
        subtitle="Dry run — fetches one page and shows exactly what was extracted. Nothing is stored."
      >
        <div className="filter-bar">
          <div className="field">
            <label className="label" htmlFor="test-competitor">
              Competitor
            </label>
            <select
              id="test-competitor"
              className="select"
              value={testSlug}
              onChange={(event) => setTestSlug(event.target.value)}
            >
              {competitors.map((competitor) => (
                <option key={competitor.slug} value={competitor.slug}>
                  {competitor.display_name}
                </option>
              ))}
            </select>
          </div>
          <div className="field field--grow">
            <label className="label" htmlFor="test-url">
              Product URL
            </label>
            <input
              id="test-url"
              className="input"
              placeholder="https://www.ernestjones.co.uk/…"
              value={testUrl}
              onChange={(event) => setTestUrl(event.target.value)}
            />
          </div>
          <button
            type="button"
            className="btn btn--primary"
            onClick={runTest}
            disabled={testBusy || !testUrl || !testSlug}
          >
            {testBusy && <span className="spinner" />}
            {testBusy ? 'Fetching…' : 'Test extraction'}
          </button>
        </div>

        <p className="small muted" style={{ marginTop: 'var(--sp-4)' }}>
          Use this to tune selectors against the live site before enabling a competitor. A failure here
          tells you exactly which stage broke — robots.txt, navigation, or extraction.
        </p>

        {testError && (
          <div style={{ marginTop: 'var(--sp-4)' }}>
            <Alert tone="danger" title="Extraction failed">
              {testError}
            </Alert>
          </div>
        )}

        {testResult != null && (
          <div style={{ marginTop: 'var(--sp-4)' }}>
            <Alert tone="ok" title="Extraction succeeded">
              Review the parsed values below — check the price matches what the page displays.
            </Alert>
            <pre
              className="mono"
              style={{
                marginTop: 'var(--sp-3)',
                background: 'var(--ink-900)',
                color: 'var(--text-on-dark)',
                padding: 'var(--sp-4)',
                borderRadius: 'var(--radius)',
                overflowX: 'auto',
                fontSize: 'var(--text-xs)',
                lineHeight: 1.6,
              }}
            >
              {JSON.stringify(testResult, null, 2)}
            </pre>
          </div>
        )}
      </Card>

      <Alert tone="warn" title="Before enabling a new competitor">
        Review that retailer's terms of use and confirm sign-off, tune the selectors with the tester
        above, and start with a small product limit. If a site actively blocks automated access, treat
        that as a signal to drop the source — not something to work around.
      </Alert>
    </div>
  );
}
