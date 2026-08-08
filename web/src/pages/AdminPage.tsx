import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, formatDateTime, type Competitor, type SystemStatus } from '../api';
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
