import { useCallback, useEffect, useState } from 'react';
import {
  api,
  ApiError,
  formatMoney,
  relativeTime,
  type Fascia,
  type MovementReport,
  type PriceMovement,
} from '../api';
import { Alert, Card, EmptyState, Stat, TableSkeleton, useToast } from '../components/ui';
import { EvidenceStrip } from '../components/EvidenceStrip';
import { CompetitorLabel } from '../components/CompetitorLogo';

/**
 * What moved, and what it did to us.
 *
 * The comparison page answers "where do we stand"; this one answers "what
 * changed to put us there", which is the question someone acts on. A
 * competitor cutting their price and us raising ours produce the same gap and
 * call for opposite responses, so both sides are shown and labelled.
 */
const WINDOWS = [
  { days: 1, label: 'Last 24 hours' },
  { days: 7, label: 'Last 7 days' },
  { days: 30, label: 'Last 30 days' },
  { days: 90, label: 'Last 90 days' },
];

/**
 * A price change, coloured by what it means for us rather than by its
 * direction.
 *
 * Everywhere else in this app green means we are in the better position and
 * red means we are not, so a competitor *cutting* their price has to read red
 * — it is the one that needs attention — and a competitor raising theirs
 * green. Colouring by direction instead would put the alarming change in the
 * reassuring colour, and contradict the summary tiles directly above it.
 *
 * One of our own changes is neither: moving our price is a margin decision,
 * not a win or a loss, so it stays neutral and the arrow carries the meaning.
 */
function Direction({ movement }: { movement: PriceMovement }) {
  if (movement.deltaAbs == null) return <span className="muted">—</span>;

  const cut = movement.deltaAbs < 0;
  const tone =
    movement.side === 'ours' ? 'badge--neutral' : cut ? 'badge--higher' : 'badge--lower';

  return (
    <span
      className={`badge ${tone}`}
      title={
        movement.side === 'ours'
          ? 'Our own price change'
          : cut
            ? 'They got cheaper — worth a look'
            : 'They got dearer — better for us'
      }
    >
      {cut ? '▼' : '▲'} {formatMoney(Math.abs(movement.deltaAbs))}
      {movement.deltaPct != null && ` (${Math.abs(movement.deltaPct).toFixed(1)}%)`}
    </span>
  );
}

export function ReportPage() {
  const toast = useToast();
  const [fascias, setFascias] = useState<Fascia[]>([]);
  const [fascia, setFascia] = useState('');
  const [days, setDays] = useState(1);
  const [side, setSide] = useState('all');
  const [undercutsOnly, setUndercutsOnly] = useState(false);
  const [report, setReport] = useState<MovementReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const { fascias: loaded } = await api.fascias();
        setFascias(loaded);
        setFascia((current) => current || loaded[0]?.code || '');
      } catch {
        // The report still renders; it just cannot offer a site to choose.
      }
    })();
  }, []);

  const load = useCallback(async () => {
    if (!fascia) return;
    setLoading(true);
    setError(null);
    try {
      setReport(await api.report({ fascia, days, side, undercutsOnly }));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not build the report');
    } finally {
      setLoading(false);
    }
  }, [fascia, days, side, undercutsOnly]);

  useEffect(() => {
    void load();
  }, [load]);

  const summary = report?.summary;

  return (
    <div className="page">
      <p className="page__intro">
        Every price that moved — <strong>theirs and ours</strong> — in the chosen period, and what it
        did to where we stand. A competitor cutting their price and us raising ours leave the same
        gap and call for opposite responses, so both are shown here and labelled. Prices are
        compared against the site you pick, because the same product is a different price at each of
        ours.
      </p>

      <EvidenceStrip fascia={fascia} />

      {error && (
        <Alert tone="danger" title="Could not build the report">
          {error}
        </Alert>
      )}

      {summary && (
        <div className="stat-grid">
          <Stat
            label="They cut a price"
            value={summary.competitorCuts}
            tone={summary.competitorCuts > 0 ? 'higher' : 'info'}
            icon="▼"
          />
          <Stat label="They raised one" value={summary.competitorRises} tone="lower" icon="▲" />
          <Stat
            label="Newly undercutting us"
            value={summary.newlyUndercut}
            tone={summary.newlyUndercut > 0 ? 'higher' : 'lower'}
            icon="⚠"
          />
          <Stat
            label="No longer undercut"
            value={summary.undercutResolved}
            tone="lower"
            icon="✓"
          />
          <Stat label="We changed a price" value={summary.ourChanges} tone="accent" icon="✎" />
          <Stat label="Products affected" value={summary.productsAffected} tone="info" icon="◼" />
        </div>
      )}

      <Card
        title="What moved"
        subtitle={
          report
            ? `${report.movements.length} change(s)${report.truncated ? ' (showing the most recent)' : ''}`
            : 'Loading…'
        }
        actions={
          <>
            <select
              className="select"
              value={fascia}
              onChange={(event) => setFascia(event.target.value)}
              aria-label="Our site"
            >
              {fascias.map((entry) => (
                <option key={entry.code} value={entry.code}>
                  {entry.name}
                </option>
              ))}
            </select>
            <select
              className="select"
              value={days}
              onChange={(event) => setDays(Number(event.target.value))}
              aria-label="Period"
            >
              {WINDOWS.map((window) => (
                <option key={window.days} value={window.days}>
                  {window.label}
                </option>
              ))}
            </select>
            <select
              className="select"
              value={side}
              onChange={(event) => setSide(event.target.value)}
              aria-label="Whose prices"
            >
              <option value="all">Theirs and ours</option>
              <option value="competitor">Competitors only</option>
              <option value="ours">Ours only</option>
            </select>
            <label className="small" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <input
                type="checkbox"
                checked={undercutsOnly}
                onChange={(event) => setUndercutsOnly(event.target.checked)}
              />
              Only where they beat us
            </label>
            <a
              className="btn btn--sm"
              href={api.reportCsvUrl({ fascia, days, side, undercutsOnly })}
              onClick={() => toast('Downloading the report…', 'info')}
            >
              Export CSV
            </a>
          </>
        }
        bodyless
      >
        {loading ? (
          <TableSkeleton columns={6} />
        ) : !report || report.movements.length === 0 ? (
          <EmptyState
            mark="—"
            title="Nothing moved"
            body={
              side === 'ours'
                ? 'None of our prices changed in this period.'
                : 'No competitor price changed in this period. If that seems unlikely, check the nightly job has been running — Admin will say when it last did.'
            }
          />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Product</th>
                  <th>Who</th>
                  <th className="num">Was</th>
                  <th className="num">Now</th>
                  <th className="num">Change</th>
                  <th className="num">Our price</th>
                  <th className="num">Where we stand</th>
                  <th className="num">When</th>
                </tr>
              </thead>
              <tbody>
                {report.movements.map((movement, index) => (
                  <tr key={`${movement.side}-${movement.productId}-${movement.competitorId}-${index}`}>
                    <td>
                      <div className="cell-primary truncate" style={{ maxWidth: 240 }}>
                        {movement.productName}
                      </div>
                      <div className="cell-secondary mono">{movement.internalSku}</div>
                    </td>
                    <td>
                      {movement.side === 'ours' ? (
                        <span className="badge badge--accent">Us</span>
                      ) : (
                        <CompetitorLabel
                          slug={movement.competitorSlug ?? ''}
                          displayName={movement.competitorName ?? ''}
                          hasLogo={movement.competitorHasLogo}
                          className="cell-primary"
                        />
                      )}
                    </td>
                    <td className="num price muted">
                      {movement.previousPrice == null ? '—' : formatMoney(movement.previousPrice)}
                    </td>
                    <td className="num price">
                      {movement.price == null ? '—' : formatMoney(movement.price)}
                    </td>
                    <td className="num">
                      <Direction movement={movement} />
                    </td>
                    <td className="num price muted">
                      {movement.ourPrice == null ? '—' : formatMoney(movement.ourPrice)}
                    </td>
                    <td className="num">
                      {movement.position == null ? (
                        <span className="muted xs">—</span>
                      ) : (
                        <span className={`badge badge--${movement.position}`}>
                          {movement.position === 'higher'
                            ? 'they are cheaper'
                            : movement.position === 'lower'
                              ? 'we are cheaper'
                              : 'level'}
                        </span>
                      )}
                    </td>
                    <td className="num muted xs nowrap">{relativeTime(movement.changedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {report && (
        <p className="small muted">
          Built {relativeTime(report.generatedAt)} against{' '}
          <strong>{report.fascia?.name ?? 'no site'}</strong>. Our own price changes appear only from
          the point this history started being kept; competitor prices go back as far as we have
          been scanning them. For one product's full history over time, open it on{' '}
          <strong>Price comparison</strong> — the drawer there charts every competitor against our
          price.
        </p>
      )}
    </div>
  );
}
