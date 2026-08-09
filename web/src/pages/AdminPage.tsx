import { useCallback, useEffect, useState } from 'react';
import {
  api,
  ApiError,
  formatDateTime,
  type Competitor,
  type RobotsCheckResult,
  type SitemapCheckResult,
  type SystemStatus,
} from '../api';
import { CompetitorLogoUpload } from '../components/CompetitorLogoUpload';
import { Alert, Card, Stat, TableSkeleton, useToast } from '../components/ui';

/**
 * Administration: the things you set up or check on, rather than the things you
 * look at daily. Kept separate from the monitoring pages so those stay a
 * listing, and so this has room to grow.
 */
export function AdminPage() {
  const toast = useToast();
  const [competitors, setCompetitors] = useState<Competitor[]>([]);
  const [status, setStatus] = useState<SystemStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [competitorList, systemStatus] = await Promise.all([
        api.competitors(),
        api.systemStatus(),
      ]);
      setCompetitors(competitorList.competitors);
      setStatus(systemStatus);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load admin data');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="page">
      <p className="page__intro">
        Setup and housekeeping. Nothing here runs a scrape or changes a price — it configures how
        the app presents itself, and reports what is actually in the database.
      </p>

      {error && (
        <Alert tone="danger" title="Could not load admin data">
          {error}
        </Alert>
      )}

      <SystemStatusSection status={status} loading={loading} />
      <RobotsSection toast={toast} />
      <SitemapSection toast={toast} />
      <LogoSection competitors={competitors} loading={loading} onChange={load} toast={toast} />
    </div>
  );
}

function SystemStatusSection({
  status,
  loading,
}: {
  status: SystemStatus | null;
  loading: boolean;
}) {
  if (loading || !status) {
    return (
      <Card title="System status" subtitle="What is actually in the database">
        <TableSkeleton rows={3} />
      </Card>
    );
  }

  return (
    <>
      <div className="stat-grid">
        <Stat
          label="Products"
          value={status.catalogue.products}
          tone="accent"
          icon="◆"
          meta={`${status.catalogue.brands} brand(s)`}
        />
        <Stat
          label="Priced"
          value={status.catalogue.withPrice}
          tone={status.catalogue.awaitingPrice > 0 ? 'info' : 'lower'}
          icon="£"
          meta={
            status.catalogue.awaitingPrice > 0
              ? `${status.catalogue.awaitingPrice} awaiting a price`
              : 'All products priced'
          }
        />
        <Stat
          label="Competitors"
          value={`${status.competitors.enabled} / ${status.competitors.total}`}
          tone="accent"
          icon="🏬"
          meta="Enabled for scraping"
        />
        <Stat
          label="Confirmed matches"
          value={status.matching.confirmed}
          tone={status.matching.pending > 0 ? 'higher' : 'equal'}
          icon={status.matching.pending > 0 ? '▲' : '✓'}
          meta={
            status.matching.pending > 0
              ? `${status.matching.pending} awaiting review`
              : 'Nothing awaiting review'
          }
        />
      </div>

      <Card title="System status" subtitle="What is actually in the database">
        <div className="spec-grid">
          <Detail label="Catalogue last updated" value={formatWhen(status.catalogue.lastImportedAt)} />
          <Detail
            label="Products with a confirmed match"
            value={`${status.matching.productsMatched} of ${status.catalogue.products}`}
          />
          <Detail label="Rejected matches" value={String(status.matching.rejected)} />
          <Detail label="Price observations" value={String(status.observations.total)} />
          <Detail label="Last observation" value={formatWhen(status.observations.lastObservedAt)} />
          <Detail
            label="Scrape runs"
            value={
              status.runs.total === 0
                ? 'None yet'
                : `${status.runs.total} (last ${status.runs.lastRunStatus ?? 'unknown'})`
            }
          />
          <Detail label="Last run" value={formatWhen(status.runs.lastRunAt)} />
          <Detail label="Competitors with a logo" value={String(status.competitors.withLogo)} />
          <Detail
            label="Delisted products"
            value={
              status.catalogue.delisted === 0
                ? 'None'
                : `${status.catalogue.delisted} (not scanned)`
            }
          />
        </div>

        <details style={{ marginTop: 'var(--sp-4)' }}>
          <summary className="small muted" style={{ cursor: 'pointer' }}>
            {status.schema.migrations.length} database migration(s) applied
          </summary>
          <ul className="small mono muted" style={{ margin: 'var(--sp-2) 0 0', paddingLeft: 18 }}>
            {status.schema.migrations.map((migration) => (
              <li key={migration}>{migration}</li>
            ))}
          </ul>
        </details>
      </Card>
    </>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="spec">
      <div className="spec__key">{label}</div>
      <div className="spec__value">{value}</div>
    </div>
  );
}

function formatWhen(value: string | null): string {
  return value ? formatDateTime(value) : 'Never';
}

/**
 * Full logo management: upload for any competitor, remove from those that have
 * one. The Competitors table keeps a quick click-to-upload on each badge, but
 * this is where the whole set is managed together.
 */
function LogoSection({
  competitors,
  loading,
  onChange,
  toast,
}: {
  competitors: Competitor[];
  loading: boolean;
  onChange: () => Promise<void>;
  toast: (message: string, tone?: 'ok' | 'error' | 'info') => void;
}) {
  const [fetching, setFetching] = useState(false);
  const [busySlug, setBusySlug] = useState<string | null>(null);

  const withLogo = competitors.filter((competitor) => competitor.has_logo).length;

  const fetchLogos = async () => {
    setFetching(true);
    try {
      const result = await api.refreshLogos();
      await onChange();
      if (result.fetched > 0) toast(`Fetched ${result.fetched} logo(s).`, 'ok');
      else if (result.failed > 0)
        toast(`No logos reachable (${result.failed} failed) — monogram badges kept.`, 'info');
      else toast('All logos already cached.', 'ok');
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Logo fetch failed', 'error');
    } finally {
      setFetching(false);
    }
  };

  const remove = async (competitor: Competitor) => {
    setBusySlug(competitor.slug);
    try {
      await api.clearLogo(competitor.slug);
      await onChange();
      toast(`${competitor.display_name} logo removed.`, 'ok');
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not remove logo', 'error');
    } finally {
      setBusySlug(null);
    }
  };

  return (
    <Card
      title="Competitor logos"
      subtitle={
        loading
          ? 'Loading…'
          : `${withLogo} of ${competitors.length} competitors have a logo; the rest show a monogram`
      }
      actions={
        <button type="button" className="btn btn--sm" onClick={() => void fetchLogos()} disabled={fetching}>
          {fetching ? 'Fetching…' : 'Fetch logos'}
        </button>
      }
    >
      {loading ? (
        <TableSkeleton rows={4} />
      ) : (
        <>
          <ul className="logo-admin">
            {competitors.map((competitor) => (
              <li key={competitor.id} className="logo-admin__row">
                <CompetitorLogoUpload
                  slug={competitor.slug}
                  displayName={competitor.display_name}
                  hasLogo={competitor.has_logo}
                  onChange={onChange}
                />
                <div className="logo-admin__name">
                  <div className="cell-primary">{competitor.display_name}</div>
                  <div className="cell-secondary xs">
                    {!competitor.has_logo ? (
                      <span className="muted">Monogram — click the badge to upload</span>
                    ) : competitor.logo_url ? (
                      <>
                        Fetched from <span className="mono">{hostOf(competitor.logo_url)}</span>
                      </>
                    ) : (
                      'Uploaded by hand'
                    )}
                  </div>
                </div>
                {competitor.has_logo && (
                  <button
                    type="button"
                    className="btn btn--sm"
                    disabled={busySlug === competitor.slug}
                    onClick={() => void remove(competitor)}
                  >
                    {busySlug === competitor.slug ? 'Removing…' : 'Remove'}
                  </button>
                )}
              </li>
            ))}
          </ul>
          <p className="small muted" style={{ marginBottom: 0 }}>
            Click a badge to upload or replace a logo — PNG, SVG, JPEG, WebP, GIF or ICO, up to
            2MB. <strong>Fetch logos</strong> pulls them from each retailer's own site, which needs
            outbound access to those domains. A monogram is a working state, not a gap to fill.
          </p>
        </>
      )}
    </Card>
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * What each competitor's robots.txt actually permits.
 *
 * A run reporting "blocked" for every source does not distinguish a site that
 * refuses us outright from one that merely closes the route we chose. This reads
 * the rules and shows both the search decision and any sitemaps the site
 * publishes — a sitemap being the crawler-sanctioned way to the same product
 * pages when search is disallowed.
 */
function RobotsSection({ toast }: { toast: (m: string, tone?: 'ok' | 'error' | 'info') => void }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<RobotsCheckResult | null>(null);

  const run = async () => {
    setBusy(true);
    try {
      const response = await api.robotsCheck();
      setResult(response);
      toast(
        `${response.summary.searchAllowed} of ${response.results.length} allow the search route.`,
        response.summary.searchAllowed > 0 ? 'ok' : 'info',
      );
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'robots.txt check failed', 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card
      title="Crawl permissions"
      subtitle="What each competitor's robots.txt allows — reads the rules only, scrapes nothing"
      actions={
        <button type="button" className="btn btn--sm" onClick={() => void run()} disabled={busy}>
          {busy ? 'Checking…' : 'Check robots.txt'}
        </button>
      }
    >
      {!result ? (
        <p className="small muted" style={{ margin: 0 }}>
          Run this to see which sources are usable and by what route. It needs outbound access to
          the competitor domains, so it reports what your deployment can reach.
        </p>
      ) : (
        <>
          <div className="stat-grid" style={{ marginBottom: 'var(--sp-4)' }}>
            <Stat
              label="Search allowed"
              value={result.summary.searchAllowed}
              tone={result.summary.searchAllowed > 0 ? 'lower' : 'higher'}
              icon={result.summary.searchAllowed > 0 ? '✓' : '▲'}
            />
            <Stat label="Search blocked" value={result.summary.searchBlocked} tone="higher" icon="⛔" />
            <Stat label="Unreachable" value={result.summary.unreachable} tone="info" icon="?" />
            <Stat
              label="Publish sitemaps"
              value={result.summary.withSitemaps}
              tone="accent"
              icon="🗺"
              meta="Alternative route"
            />
          </div>

          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Competitor</th>
                  <th>robots.txt</th>
                  <th>Search route</th>
                  <th>Sitemaps</th>
                  <th>Disallowed paths</th>
                </tr>
              </thead>
              <tbody>
                {result.results.map((row) => (
                  <tr key={row.slug}>
                    <td>
                      <div className="cell-primary">{row.name}</div>
                      <div className="cell-secondary mono xs">{row.origin ?? row.slug}</div>
                    </td>
                    <td className="small">
                      {row.error ? (
                        <span className="badge badge--higher">error</span>
                      ) : row.status === 'ok' ? (
                        <span className="badge badge--lower">read</span>
                      ) : row.status === 'absent' ? (
                        <span className="badge badge--neutral">none published</span>
                      ) : (
                        <span className="badge badge--higher">unreachable</span>
                      )}
                      {row.failureDetail && (
                        <div className="cell-secondary xs">{row.failureDetail}</div>
                      )}
                      {row.crawlDelaySeconds != null && (
                        <div className="cell-secondary xs">crawl-delay {row.crawlDelaySeconds}s</div>
                      )}
                    </td>
                    <td className="small">
                      {row.probe?.[0] ? (
                        <span className={`badge badge--${row.probe[0].allowed ? 'lower' : 'higher'}`}>
                          {row.probe[0].allowed ? 'allowed' : 'disallowed'}
                        </span>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="xs">
                      {row.sitemaps && row.sitemaps.length > 0 ? (
                        <span className="mono">{row.sitemaps.length} declared</span>
                      ) : (
                        <span className="muted">none</span>
                      )}
                    </td>
                    <td className="xs mono muted" style={{ maxWidth: 280 }}>
                      {row.disallowRules && row.disallowRules.length > 0
                        ? row.disallowRules.slice(0, 6).join('  ')
                        : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <p className="small muted" style={{ marginTop: 'var(--sp-4)', marginBottom: 0 }}>
            Checked as <span className="mono">{result.userAgent}</span>. A disallowed search route
            does not necessarily mean the source is unusable — most retailers close internal search
            while leaving product pages open, and publish a sitemap listing them.
          </p>
        </>
      )}
    </Card>
  );
}

/**
 * What each competitor's sitemaps actually contain.
 *
 * Where search is disallowed this is the route the site publishes for crawlers,
 * so this answers the practical question: is there a usable path to their
 * product pages, and what do those URLs look like?
 */
function SitemapSection({ toast }: { toast: (m: string, tone?: 'ok' | 'error' | 'info') => void }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<SitemapCheckResult | null>(null);

  const run = async () => {
    setBusy(true);
    try {
      const response = await api.sitemapCheck();
      setResult(response);
      toast(
        `${response.summary.withUsableSitemap} of ${response.results.length} have a readable sitemap.`,
        response.summary.withUsableSitemap > 0 ? 'ok' : 'info',
      );
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Sitemap check failed', 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card
      title="Sitemaps"
      subtitle="The crawler-sanctioned route to product pages when search is closed"
      actions={
        <button type="button" className="btn btn--sm" onClick={() => void run()} disabled={busy}>
          {busy ? 'Surveying…' : 'Survey sitemaps'}
        </button>
      }
    >
      {!result ? (
        <p className="small muted" style={{ margin: 0 }}>
          Reads each competitor's robots.txt for declared sitemaps, fetches them, and reports what
          they contain. Bounded to the index and a few children — a large retailer's full tree runs
          to millions of URLs. Every fetch is still checked against robots.txt.
        </p>
      ) : (
        <>
          <div className="stat-grid" style={{ marginBottom: 'var(--sp-4)' }}>
            <Stat
              label="Usable sitemaps"
              value={result.summary.withUsableSitemap}
              tone={result.summary.withUsableSitemap > 0 ? 'lower' : 'higher'}
              icon={result.summary.withUsableSitemap > 0 ? '✓' : '▲'}
            />
            <Stat label="Declare sitemaps" value={result.summary.declaringSitemaps} tone="accent" icon="🗺" />
            <Stat label="No route found" value={result.summary.failed} tone="info" icon="?" />
          </div>

          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Competitor</th>
                  <th className="num">URLs seen</th>
                  <th>Sitemaps</th>
                  <th>Sample URL</th>
                </tr>
              </thead>
              <tbody>
                {result.results.map((row) => (
                  <tr key={row.slug}>
                    <td>
                      <div className="cell-primary">{row.name}</div>
                      {row.error && <div className="cell-secondary xs">{row.error}</div>}
                    </td>
                    <td className="num">
                      {row.totalUrls ? (
                        <span className="badge badge--lower">{row.totalUrls}</span>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                    <td className="xs mono muted" style={{ maxWidth: 300 }}>
                      {row.declared && row.declared.length > 0
                        ? row.declared.slice(0, 3).map((s) => <div key={s}>{s}</div>)
                        : '—'}
                    </td>
                    <td className="xs mono muted" style={{ maxWidth: 320 }}>
                      {row.sampleUrls?.[0] ?? '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Card>
  );
}
