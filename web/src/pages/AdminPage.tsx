import { useCallback, useEffect, useState } from 'react';
import {
  api,
  ApiError,
  formatDateTime,
  type BlockDiagnosis,
  type Competitor,
  type CompetitorVerification,
  type RobotsCheckResult,
  type SitemapCheckResult,
  type SitemapCheckRow,
  type AlertSettings,
  type ScrapeHealthResponse,
  type SystemStatus,
  type TestUrlResult,
} from '../api';
import { CompetitorLogoUpload } from '../components/CompetitorLogoUpload';
import { CompetitorLabel } from '../components/CompetitorLogo';
import { errorKindLabel } from '../errorKinds';
import { Alert, Card, EmptyState, PriceAge, Stat, TableSkeleton, useToast } from '../components/ui';

/**
 * Administration: the things you set up or check on, rather than the things you
 * look at daily. Kept separate from the monitoring pages so those stay a
 * listing, and so this has room to grow.
 *
 * Competitor setup lives here too. It was its own page, but everything on it —
 * which retailers we watch, their logos, whether a page can be read at all —
 * was setup rather than monitoring, and it read as a second admin page sitting
 * next to the first.
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
        Setup and housekeeping: what is in the database, which competitors we watch, and whether
        their sites can be read at all. Nothing here runs a scrape or changes a price — the one
        page that fetches anything is the URL tester, and it stores nothing.
      </p>

      {error && (
        <Alert tone="danger" title="Could not load admin data">
          {error}
        </Alert>
      )}

      <SystemStatusSection status={status} loading={loading} />
      <ScrapeHealthSection />
      <AlertSettingsSection toast={toast} />
      <CompetitorsSection
        competitors={competitors}
        loading={loading}
        onChange={load}
        toast={toast}
      />
      <VerificationSection competitors={competitors} toast={toast} />
      <RobotsSection toast={toast} />
      <SitemapSection toast={toast} />
      <UrlTesterSection competitors={competitors} />

      <Alert tone="warn" title="Before enabling a new competitor">
        Review that retailer's terms of use and confirm sign-off, tune the selectors with the tester
        above, and start with a small product limit. If a site actively blocks automated access, treat
        that as a signal to drop the source — not something to work around.
      </Alert>
    </div>
  );
}

/**
 * Which retailers we watch, and how each one is presented.
 *
 * Adding one is a JSON file plus a re-sync, never a code change, so the table
 * is a view of the config rather than an editor for it. What is settable is
 * whether a competitor takes part in runs — off keeps its history — and its
 * logo. Logos used to be a second card listing the same eleven retailers a
 * second time, which is one list too many now that everything is on one page.
 */
function CompetitorsSection({
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
  const [fetchingLogos, setFetchingLogos] = useState(false);
  const [busyLogoSlug, setBusyLogoSlug] = useState<string | null>(null);

  const fetchLogos = async () => {
    setFetchingLogos(true);
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
      setFetchingLogos(false);
    }
  };

  const removeLogo = async (competitor: Competitor) => {
    setBusyLogoSlug(competitor.slug);
    try {
      await api.clearLogo(competitor.slug);
      await onChange();
      toast(`${competitor.display_name} logo removed.`, 'ok');
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not remove logo', 'error');
    } finally {
      setBusyLogoSlug(null);
    }
  };

  const toggle = async (competitor: Competitor) => {
    try {
      await api.toggleCompetitor(competitor.slug, !competitor.enabled);
      toast(`${competitor.display_name} ${competitor.enabled ? 'disabled' : 'enabled'}.`, 'ok');
      await onChange();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not update that competitor', 'error');
    }
  };

  const sync = async () => {
    try {
      const response = await api.syncCompetitors();
      toast(`Synced ${response.synced.length} competitor definition(s) from config.`, 'ok');
      await onChange();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Sync failed', 'error');
    }
  };

  const withLogo = competitors.filter((competitor) => competitor.has_logo).length;

  return (
    <Card
      title="Competitors"
      subtitle={
        loading
          ? 'Defined in the competitors directory — adding one is a config file plus a sync'
          : `Defined in the competitors directory — adding one is a config file plus a sync. ` +
            `${withLogo} of ${competitors.length} have a logo; the rest show a monogram.`
      }
      actions={
        <>
          <button
            type="button"
            className="btn btn--sm"
            onClick={() => void fetchLogos()}
            disabled={fetchingLogos}
          >
            {fetchingLogos ? 'Fetching…' : 'Fetch logos'}
          </button>
          <button type="button" className="btn btn--sm" onClick={() => void sync()}>
            Re-sync from config
          </button>
        </>
      }
      bodyless
    >
      {loading ? (
        <TableSkeleton columns={6} />
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Competitor</th>
                <th>Logo</th>
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
                        onChange={onChange}
                      />
                      <div style={{ minWidth: 0 }}>
                        <div className="cell-primary">{competitor.display_name}</div>
                        <div className="cell-secondary mono">{competitor.slug}</div>
                      </div>
                    </div>
                  </td>
                  <td className="xs muted" style={{ maxWidth: 190 }}>
                    {!competitor.has_logo ? (
                      'Monogram'
                    ) : (
                      <div className="row-actions">
                        <span>
                          {competitor.logo_url ? (
                            <>
                              Fetched from{' '}
                              <span className="mono">{hostOf(competitor.logo_url)}</span>
                            </>
                          ) : (
                            'Uploaded by hand'
                          )}
                        </span>
                        <button
                          type="button"
                          className="btn btn--sm btn--ghost"
                          disabled={busyLogoSlug === competitor.slug}
                          onClick={() => void removeLogo(competitor)}
                        >
                          {busyLogoSlug === competitor.slug ? 'Removing…' : 'Remove logo'}
                        </button>
                      </div>
                    )}
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
          <p className="small muted" style={{ padding: 'var(--sp-4)', margin: 0 }}>
            Click a badge to upload or replace a logo — PNG, SVG, JPEG, WebP, GIF or ICO, up to
            2MB. <strong>Fetch logos</strong> pulls them from each retailer's own site, which needs
            outbound access to those domains. A monogram is a working state, not a gap to fill.
          </p>
        </div>
      )}
    </Card>
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
          label="Priced at every site"
          value={
            status.fasciaCoverage.length === 0
              ? 0
              : Math.min(...status.fasciaCoverage.map((f) => f.priced))
          }
          tone={status.fasciaCoverage.some((f) => f.missing > 0) ? 'info' : 'lower'}
          icon="£"
          meta={
            status.fasciaCoverage.some((f) => f.missing > 0)
              ? 'Coverage differs by site — see below'
              : 'Every site has a price for all products'
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
          {status.fasciaCoverage.map((f) => (
            <Detail
              key={f.code}
              label={`${f.name} priced`}
              value={f.missing > 0 ? `${f.priced} (${f.missing} without)` : `${f.priced} — complete`}
            />
          ))}
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
/**
 * What is worth raising an alert about (Spec §5.5).
 *
 * The undercut thresholds are ANDed, and both default to zero — so out of the
 * box every undercut alerts, and setting just one of them applies just that
 * one. The form says so, because "or" is the more natural reading of two
 * fields side by side and getting it wrong means silently missing alerts.
 */
function AlertSettingsSection({
  toast,
}: {
  toast: (message: string, tone?: 'ok' | 'error' | 'info') => void;
}) {
  const [settings, setSettings] = useState<AlertSettings | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api
      .alertSettings()
      .then(setSettings)
      .catch(() => undefined);
  }, []);

  const save = async () => {
    if (!settings) return;
    setSaving(true);
    try {
      setSettings(await api.saveAlertSettings(settings));
      toast('Alert thresholds saved.', 'ok');
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not save thresholds', 'error');
    } finally {
      setSaving(false);
    }
  };

  const patch = (change: Partial<AlertSettings>) =>
    setSettings((current) => (current ? { ...current, ...change } : current));

  return (
    <Card
      title="Alert thresholds"
      subtitle="How big a difference has to be before anyone is told about it"
      actions={
        <button
          type="button"
          className="btn btn--sm btn--accent"
          onClick={() => void save()}
          disabled={saving || !settings}
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
      }
    >
      {!settings ? (
        <p className="small muted" style={{ margin: 0 }}>
          Loading…
        </p>
      ) : (
        <>
          <div className="filter-bar">
            <div className="field">
              <label className="label" htmlFor="undercut-pct">
                Undercut at least (%)
              </label>
              <input
                id="undercut-pct"
                className="input"
                type="number"
                min={0}
                max={100}
                step="0.5"
                style={{ width: 140 }}
                value={settings.undercutMinPct}
                onChange={(event) => patch({ undercutMinPct: Number(event.target.value) })}
              />
            </div>
            <div className="field">
              <label className="label" htmlFor="undercut-abs">
                …and at least (£)
              </label>
              <input
                id="undercut-abs"
                className="input"
                type="number"
                min={0}
                step="1"
                style={{ width: 140 }}
                value={settings.undercutMinAbs}
                onChange={(event) => patch({ undercutMinAbs: Number(event.target.value) })}
              />
            </div>
            <div className="field">
              <label className="label" htmlFor="drop-pct">
                Price drop at least (%)
              </label>
              <input
                id="drop-pct"
                className="input"
                type="number"
                min={0}
                max={100}
                step="0.5"
                style={{ width: 140 }}
                value={settings.priceDropMinPct}
                disabled={!settings.priceDropEnabled}
                onChange={(event) => patch({ priceDropMinPct: Number(event.target.value) })}
              />
            </div>
            <div className="field">
              <span className="label">Also alert on</span>
              <label className="row small" style={{ gap: 8, cursor: 'pointer', marginTop: 8 }}>
                <input
                  type="checkbox"
                  checked={settings.priceDropEnabled}
                  onChange={(event) => patch({ priceDropEnabled: event.target.checked })}
                />
                Competitor price drops
              </label>
              <label className="row small" style={{ gap: 8, cursor: 'pointer', marginTop: 4 }}>
                <input
                  type="checkbox"
                  checked={settings.listingGoneEnabled}
                  onChange={(event) => patch({ listingGoneEnabled: event.target.checked })}
                />
                Listings gone or out of stock
              </label>
            </div>
          </div>

          <p className="small muted" style={{ marginTop: 'var(--sp-4)', marginBottom: 0 }}>
            An undercut alert needs <strong>both</strong> undercut figures to be met, not either —
            leave one at zero to ignore it. Raising a threshold quietly resolves alerts that no
            longer qualify rather than leaving them open. A price drop is measured against that
            competitor's own previous price, not against ours.
          </p>
        </>
      )}
    </Card>
  );
}

/**
 * Scrape health per competitor (Spec §3).
 *
 * The number that needs explaining is the success rate: it counts only what we
 * actually asked for. Most of our range is not carried by most competitors, so
 * the great majority of run items are "skipped" — not failures, questions we
 * never put. Including them would make a healthy competitor read as single
 * digits, so they are shown as their own figure instead.
 */
/**
 * How each kind of wall reads in the health table.
 *
 * `ours` marks the ones we caused and can fix ourselves — those are shown in
 * the milder tone, because treating a self-inflicted rate limit with the same
 * alarm as a hard bot gate would send someone off looking for a vendor when
 * the answer is one config value.
 */
const BLOCK_CAUSE_COPY: Record<string, { label: string; hint: string; ours: boolean }> = {
  rate_limited: {
    label: 'rate limited',
    hint: 'We asked too fast. Raise the delay for this competitor — they are willing to serve us.',
    ours: true,
  },
  ua_or_waf: {
    label: 'refused outright',
    hint: 'No challenge page, usually our user agent. Try a real contact address or the browser identity first.',
    ours: true,
  },
  bot_challenge: {
    label: 'bot challenge',
    hint: 'A gate on what we are, not how fast we ask. Politeness will not clear it.',
    ours: false,
  },
  soft_block: {
    label: 'soft block',
    hint: 'A normal 200 hiding an interstitial. The selectors are probably fine.',
    ours: false,
  },
  geo_or_legal: {
    label: 'legally blocked',
    hint: 'Unavailable to us for legal or regional reasons. No tool answers this.',
    ours: false,
  },
  login_required: {
    label: 'needs an account',
    hint: 'The price is only shown to signed-in customers, so it cannot be compared automatically.',
    ours: false,
  },
  unclassified: {
    label: 'refused, cause unclear',
    hint: 'Not a pattern we recognise. Look at the response before deciding anything.',
    ours: false,
  },
};

/** How each verdict reads, and how loudly. */
const VERDICT_COPY: Record<string, { label: string; tone: string; mark: string }> = {
  ready: { label: 'Working', tone: 'badge--lower', mark: '\u2713' },
  needs_config: { label: 'Needs config', tone: 'badge--warn', mark: '!' },
  blocked: { label: 'Refused us', tone: 'badge--higher', mark: '\u26d4' },
  no_sitemap: { label: 'No product list', tone: 'badge--warn', mark: '?' },
  unreachable: { label: 'Unreachable', tone: 'badge--neutral', mark: '\u2014' },
};

/**
 * Check every competitor against the live web and say, per competitor, whether
 * this app can actually read prices from them.
 *
 * Runs them one at a time from the browser rather than in one server call.
 * Eleven competitors each fetching robots, a sitemap and three product pages
 * is minutes of work: as a single request it would sit behind a proxy timeout
 * and lose every result including the ones already gathered. One at a time,
 * rows fill in as they finish and a failure costs one competitor.
 */
function VerificationSection({
  competitors,
  toast,
}: {
  competitors: Competitor[];
  toast: (message: string, tone?: 'ok' | 'error' | 'info') => void;
}) {
  const [results, setResults] = useState<Record<string, CompetitorVerification>>({});
  const [running, setRunning] = useState<string | null>(null);
  const [queue, setQueue] = useState<string[]>([]);

  const checkAll = async () => {
    setResults({});
    const slugs = competitors.map((competitor) => competitor.slug);
    setQueue(slugs);

    let ready = 0;
    for (const slug of slugs) {
      setRunning(slug);
      try {
        const result = await api.verifyCompetitor(slug);
        setResults((current) => ({ ...current, [slug]: result }));
        if (result.verdict === 'ready') ready += 1;
      } catch (err) {
        toast(
          err instanceof ApiError ? `${slug}: ${err.message}` : `Could not check ${slug}`,
          'error',
        );
      }
    }
    setRunning(null);
    setQueue([]);
    toast(`Checked ${slugs.length} competitor(s) — ${ready} can be read right now.`, 'ok');
  };

  const checkOne = async (slug: string) => {
    setRunning(slug);
    try {
      const result = await api.verifyCompetitor(slug);
      setResults((current) => ({ ...current, [slug]: result }));
    } catch (err) {
      toast(err instanceof ApiError ? err.message : `Could not check ${slug}`, 'error');
    } finally {
      setRunning(null);
    }
  };

  const checked = Object.values(results);
  const readyCount = checked.filter((row) => row.verdict === 'ready').length;
  const blockedCount = checked.filter((row) => row.verdict === 'blocked').length;
  const busy = running !== null;

  return (
    <Card
      title="Can we read each competitor?"
      subtitle="Checks the live sites: are we allowed in, can we find their products, can we read a price"
      actions={
        <button
          type="button"
          className="btn btn--primary"
          onClick={() => void checkAll()}
          disabled={busy || competitors.length === 0}
        >
          {busy && <span className="spinner" />}
          {busy ? `Checking ${running}…` : 'Check every competitor'}
        </button>
      }
    >
      <p className="small muted">
        Every competitor except one was configured <strong>without internet access</strong>, so
        nothing about them has ever been confirmed against a real site. This is the check that
        confirms it. It fetches a handful of real pages per competitor and takes about half a minute
        each, so give it a few minutes for all of them.
      </p>
      <p className="small muted">
        <strong>If every single one comes back "unreachable", that is this app's own internet
        access, not the retailers.</strong> Do not conclude anything about a competitor from that —
        check where the app is running first.
      </p>

      {checked.length > 0 && (
        <div className="stat-grid" style={{ marginTop: 'var(--sp-4)' }}>
          <Stat label="Can be read now" value={readyCount} tone="lower" icon="✓" />
          <Stat label="Refused us" value={blockedCount} tone={blockedCount > 0 ? 'higher' : 'info'} icon="⛔" />
          <Stat label="Checked" value={`${checked.length}/${competitors.length}`} tone="info" icon="…" />
        </div>
      )}

      <div className="table-wrap" style={{ marginTop: 'var(--sp-4)' }}>
        <table className="table">
          <thead>
            <tr>
              <th>Competitor</th>
              <th>Verdict</th>
              <th>What it means, and what to do</th>
              <th className="num">Pages found</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {competitors.map((competitor) => {
              const row = results[competitor.slug];
              const isRunning = running === competitor.slug;
              const isQueued = queue.includes(competitor.slug) && !row && !isRunning;

              return (
                <tr key={competitor.slug}>
                  <td>
                    <CompetitorLabel
                      slug={competitor.slug}
                      displayName={competitor.display_name}
                      hasLogo={competitor.has_logo}
                      className="cell-primary"
                    />
                    <div className="cell-secondary xs">
                      {competitor.enabled ? 'enabled' : 'not enabled'}
                    </div>
                  </td>
                  <td>
                    {isRunning ? (
                      <span className="badge badge--neutral">checking…</span>
                    ) : isQueued ? (
                      <span className="badge badge--neutral">queued</span>
                    ) : row ? (
                      <span className={`badge ${VERDICT_COPY[row.verdict]?.tone ?? 'badge--neutral'}`}>
                        {VERDICT_COPY[row.verdict]?.label ?? row.verdict}
                      </span>
                    ) : (
                      <span className="muted xs">not checked</span>
                    )}
                  </td>
                  <td className="xs" style={{ maxWidth: 420 }}>
                    {row ? (
                      <>
                        <div>{row.headline}</div>
                        <div className="muted" style={{ marginTop: 4 }}>
                          {row.whatToDo}
                        </div>
                        {row.samples.some((sample) => sample.price != null) && (
                          <div style={{ marginTop: 6 }}>
                            <strong>Check these against the site:</strong>
                            {row.samples
                              .filter((sample) => sample.price != null)
                              .map((sample) => (
                                <div key={sample.url} className="truncate">
                                  <a href={sample.url} target="_blank" rel="noreferrer">
                                    {sample.title ?? sample.url}
                                  </a>{' '}
                                  — we read{' '}
                                  <strong>
                                    {sample.currency === 'GBP' || sample.currency == null ? '£' : ''}
                                    {sample.price}
                                  </strong>
                                </div>
                              ))}
                          </div>
                        )}
                      </>
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                  <td className="num muted xs">{row ? row.sitemap.urlsFound.toLocaleString() : '—'}</td>
                  <td className="num">
                    <button
                      type="button"
                      className="btn btn--sm btn--ghost"
                      onClick={() => void checkOne(competitor.slug)}
                      disabled={busy}
                    >
                      {row ? 'Re-check' : 'Check'}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function ScrapeHealthSection() {
  const [days, setDays] = useState(7);
  const [report, setReport] = useState<ScrapeHealthResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .scrapeHealth(days)
      .then((response) => {
        if (!cancelled) {
          setReport(response);
          setError(null);
        }
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof ApiError ? err.message : 'Could not load health');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [days]);

  /** Colour by how much of what we asked actually worked. */
  const rateTone = (pct: number | null): string => {
    if (pct === null) return 'badge--neutral';
    if (pct >= 90) return 'badge--lower';
    if (pct >= 50) return 'badge--warn';
    return 'badge--danger';
  };

  const rows = report?.competitors ?? [];

  return (
    <Card
      title="Scrape health"
      subtitle="How much of what we asked each competitor actually worked, and what is failing"
      actions={
        <select
          className="select"
          style={{ width: 150 }}
          value={days}
          onChange={(event) => setDays(Number(event.target.value))}
          aria-label="Health window"
        >
          <option value={7}>Last 7 days</option>
          <option value={30}>Last 30 days</option>
          <option value={90}>Last 90 days</option>
        </select>
      }
      bodyless
    >
      {error && (
        <div style={{ padding: 'var(--sp-4) var(--sp-6)' }}>
          <Alert tone="danger" title="Could not load scrape health">
            {error}
          </Alert>
        </div>
      )}

      {loading && !report ? (
        <TableSkeleton columns={6} />
      ) : rows.length === 0 ? (
        <EmptyState title="No competitors configured" body="Add one to start measuring." />
      ) : (
        <>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Competitor</th>
                  <th>Worked</th>
                  <th className="num">Asked</th>
                  <th className="num">Not stocked</th>
                  <th>Failing on</th>
                  <th className="num">Last worked</th>
                  <th className="num">Typical</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.competitorId} style={{ opacity: row.enabled ? 1 : 0.55 }}>
                    <td>
                      <CompetitorLabel
                        slug={row.competitorSlug}
                        displayName={row.competitorName}
                        hasLogo={false}
                        className="cell-primary"
                      />
                      {!row.enabled && <div className="cell-secondary xs">disabled</div>}
                    </td>
                    <td>
                      {row.successPct === null ? (
                        <span className="badge badge--neutral" title="Nothing has been attempted in this window">
                          not scanned
                        </span>
                      ) : (
                        <span className={`badge ${rateTone(row.successPct)}`}>
                          {row.successPct}%
                        </span>
                      )}
                    </td>
                    <td className="num">{row.attempts}</td>
                    <td className="num muted" title="Products this competitor was never asked about">
                      {row.skipped}
                    </td>
                    <td className="xs muted" style={{ maxWidth: 260 }}>
                      {row.topErrors.length === 0 ? (
                        '—'
                      ) : (
                        <>
                          {errorKindLabel(row.topErrors[0]!.kind)} ({row.topErrors[0]!.count})
                          {row.robotsDisallowed > 0 && (
                            <div title="Honouring their robots.txt is policy, not a breakage">
                              {row.robotsDisallowed} declined by robots.txt
                            </div>
                          )}
                          {row.blockCauses.map((block) => (
                            <div
                              key={block.cause}
                              className={
                                BLOCK_CAUSE_COPY[block.cause]?.ours ? 'price-age--ageing' : 'price-age--stale'
                              }
                              title={BLOCK_CAUSE_COPY[block.cause]?.hint ?? block.cause}
                            >
                              {BLOCK_CAUSE_COPY[block.cause]?.label ?? block.cause} ({block.count})
                            </div>
                          ))}
                        </>
                      )}
                    </td>
                    <td className="num muted xs nowrap">
                      {row.lastOkAt ? <PriceAge observedAt={row.lastOkAt} /> : 'never'}
                    </td>
                    <td className="num muted xs nowrap">
                      {row.medianDurationMs == null ? '—' : `${(row.medianDurationMs / 1000).toFixed(1)}s`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{ padding: 'var(--sp-4) var(--sp-6)' }}>
            <Alert tone="info" title="“Worked” only counts what we actually asked">
              Most of our range is not carried by most competitors, so the great majority of targets
              are never asked about at all — those are the <strong>Not stocked</strong> column, and
              they are not failures. The percentage is of the pages we did try to read. A competitor
              reading <strong>not scanned</strong> has had nothing attempted in this window, which is
              a different thing from failing everything.
            </Alert>
          </div>
        </>
      )}
    </Card>
  );
}

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

          <div style={{ marginTop: 'var(--sp-4)' }}>
            <Alert tone="info" title="Search blocked is the expected answer, not a problem">
              Almost every retailer disallows their own search pages — it is expensive to serve and
              worthless to index — so a column of <em>disallowed</em> is normal and was expected.
              Prices are read from the sitemaps they publish for crawlers instead, which is what the
              Sitemaps card below measures. The row that actually limits us is{' '}
              <strong>unreachable</strong>: a site that will not answer at all cannot be read by any
              route.
            </Alert>
          </div>
          <p className="small muted" style={{ marginTop: 'var(--sp-4)', marginBottom: 0 }}>
            Checked as <span className="mono">{result.userAgent}</span>, from wherever this app is
            deployed. A retailer that blocks datacentre traffic may show as unreachable here while
            being perfectly reachable from an office network.
          </p>
        </>
      )}
    </Card>
  );
}

/**
 * Fetch one competitor page and show exactly what came back.
 *
 * The quickest way to tell a layout change from a genuine absence: a run says
 * "no price found", this says which stage broke — robots.txt, navigation or
 * extraction. Nothing is stored.
 */
function UrlTesterSection({ competitors }: { competitors: Competitor[] }) {
  const [slug, setSlug] = useState('');
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<TestUrlResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [diagnosis, setDiagnosis] = useState<BlockDiagnosis | null>(null);

  // Pick a default once competitors arrive, without overriding a later choice.
  useEffect(() => {
    setSlug((current) => current || competitors[0]?.slug || '');
  }, [competitors]);

  const run = async () => {
    setBusy(true);
    setResult(null);
    setError(null);
    setDiagnosis(null);
    try {
      setResult(await api.testUrl(slug, url));
    } catch (err) {
      setError(err instanceof ApiError ? `${err.kind ?? 'error'}: ${err.message}` : 'Test failed');
      if (err instanceof ApiError && err.diagnosis) setDiagnosis(err.diagnosis);
    } finally {
      setBusy(false);
    }
  };

  return (
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
            value={slug}
            onChange={(event) => setSlug(event.target.value)}
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
            value={url}
            onChange={(event) => setUrl(event.target.value)}
          />
        </div>
        <button
          type="button"
          className="btn btn--primary"
          onClick={() => void run()}
          disabled={busy || !url || !slug}
        >
          {busy && <span className="spinner" />}
          {busy ? 'Fetching…' : 'Test extraction'}
        </button>
      </div>

      <p className="small muted" style={{ marginTop: 'var(--sp-4)' }}>
        Use this to tune selectors against the live site before enabling a competitor. A failure here
        tells you exactly which stage broke — robots.txt, navigation, or extraction.
        {result?.unblocker &&
          (result.unblocker.configured ? (
            <>
              {' '}
              An unblocking service (<strong>{result.unblocker.provider}</strong>) is configured, and
              is tried only when a site refuses us outright — never for a slow page or a bad
              selector. A run may spend at most {result.unblocker.maxCallsPerRun} paid calls.
            </>
          ) : (
            <> No unblocking service is configured, so every request goes out from this host.</>
          ))}
      </p>

      {error && (
        <div style={{ marginTop: 'var(--sp-4)' }}>
          <Alert tone="danger" title="Extraction failed">
            {error}
          </Alert>
        </div>
      )}

      {diagnosis && (
        <div style={{ marginTop: 'var(--sp-3)' }}>
          <Alert
            tone={diagnosis.cause === 'rate_limited' ? 'warn' : 'info'}
            title={`What blocked us: ${diagnosis.label}`}
          >
            {diagnosis.remedy}
            {diagnosis.retryAfterSeconds != null && (
              <>
                {' '}
                They asked us to wait <strong>{diagnosis.retryAfterSeconds}s</strong> before trying
                again.
              </>
            )}
            {diagnosis.vendor && (
              <>
                {' '}
                The protection in front of the site identifies itself as{' '}
                <strong>{diagnosis.vendor}</strong>.
              </>
            )}
          </Alert>
        </div>
      )}

      {result != null && (
        <div style={{ marginTop: 'var(--sp-4)' }}>
          <Alert tone="ok" title="Extraction succeeded">
            Review the parsed values below — check the price matches what the page displays.
            {result.renderedWith === 'http' && (
              <> This page was read with a plain web request, the cheap and fast route.</>
            )}
            {result.renderedWith === 'browser' && (
              <>
                {' '}
                {result.escalated
                  ? 'A plain web request could not read a price here, so a full browser was started instead. If that is true of every page on this site, pin its rendering to "browser" so it stops paying for the failed attempt each time.'
                  : 'This competitor is configured to always use a full browser.'}
              </>
            )}
            {result.renderedWith === 'unblocker' && (
              <>
                {' '}
                This site refused us directly, so the page was read through the{' '}
                <strong>unblocking service</strong> — the only route here that costs money per
                request. It working is the answer to "is the subscription set up correctly".
              </>
            )}
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
            {JSON.stringify(result, null, 2)}
          </pre>
        </div>
      )}
    </Card>
  );
}

/**
 * Turn a survey row into a plain verdict.
 *
 * "URLs seen: —" on its own is unreadable: it covers a site that blocks us, a
 * site whose sitemap 404s, and a site whose sitemap is simply an index this
 * bounded survey did not walk. Those need different responses, so say which.
 */
function sitemapVerdict(row: SitemapCheckRow): {
  label: string;
  tone: 'lower' | 'higher' | 'warn' | 'neutral';
  detail: string;
} {
  const fetched = row.fetched ?? [];
  const failures = fetched.filter((file) => !file.ok);
  const read = fetched.filter((file) => file.ok);
  const indexes = read.filter((file) => file.isIndex);

  if ((row.totalUrls ?? 0) > 0) {
    return {
      label: 'Usable',
      tone: 'lower',
      detail: `${read.length} file(s) read. Discovery walks the whole tree, so the live count is higher.`,
    };
  }

  if (row.error) {
    // The survey never got as far as a sitemap.
    return {
      label: /robots\.txt/i.test(row.error) ? 'Blocked at robots.txt' : 'No route',
      tone: 'higher',
      detail: row.error,
    };
  }

  if (indexes.length > 0) {
    return {
      label: 'Index only',
      tone: 'warn',
      detail:
        `An index of further sitemaps was read, and the ${read.length - indexes.length} child file(s) ` +
        'this survey opened held no page URLs. The survey stops after a few children by design, so ' +
        'this is untested rather than unusable — a run walks the whole tree.',
    };
  }

  if (failures.length > 0) {
    return {
      label: 'Sitemap unreadable',
      tone: 'higher',
      detail: failures[0]?.error ?? 'the declared sitemap could not be fetched',
    };
  }

  if ((row.declared?.length ?? 0) === 0) {
    return { label: 'None published', tone: 'higher', detail: 'No sitemap declared, and no sitemap.xml at the usual path.' };
  }

  return { label: 'Empty', tone: 'warn', detail: 'The sitemap was read but listed no page URLs.' };
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
            <Stat
              label="No route found"
              value={result.summary.failed}
              tone="info"
              icon="?"
              meta="See the verdict per row"
            />
          </div>

          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Competitor</th>
                  <th className="num">URLs seen</th>
                  <th>Verdict</th>
                  <th>Sitemaps</th>
                  <th>Sample URL</th>
                </tr>
              </thead>
              <tbody>
                {result.results.map((row) => {
                  const verdict = sitemapVerdict(row);
                  return (
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
                    <td className="xs" style={{ maxWidth: 260 }}>
                      <span className={`badge badge--${verdict.tone}`}>{verdict.label}</span>
                      <div className="cell-secondary xs">{verdict.detail}</div>
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
                  );
                })}
              </tbody>
            </table>
          </div>

          <div style={{ marginTop: 'var(--sp-4)' }}>
            <Alert tone="info" title="A blank count is not the same as a dead source">
              This survey reads the index and a few children only — a large retailer's full tree
              runs to millions of URLs and is not worth walking to answer "is there a route". A run
              harvests the whole tree, so <em>Index only</em> means untested here, not unusable.{' '}
              <em>Sitemap unreadable</em> and <em>Blocked at robots.txt</em> are the real problems,
              and a few of those still leaves plenty to compare against.
            </Alert>
          </div>
        </>
      )}
    </Card>
  );
}
