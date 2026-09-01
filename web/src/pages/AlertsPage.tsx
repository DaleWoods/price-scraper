import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, formatMoney, relativeTime, type AlertRow } from '../api';
import { Alert, Card, EmptyState, TableSkeleton, useToast } from '../components/ui';
import { CompetitorLabel } from '../components/CompetitorLogo';

/** The three alert types (Spec §5.5), and how each is presented. */
const TYPE_COPY: Record<string, { label: string; badge: string; hint: string }> = {
  undercut: {
    label: 'Undercut',
    badge: 'badge--higher',
    hint: 'A competitor is cheaper than us at one of our sites.',
  },
  price_drop: {
    label: 'Price drop',
    badge: 'badge--warn',
    hint: "A competitor cut their own price sharply — not necessarily below ours.",
  },
  listing_gone: {
    label: 'Listing gone',
    badge: 'badge--neutral',
    hint: 'A product we had matched is out of stock there, or the page has gone.',
  },
};

const STATE_COPY: Record<string, { label: string; empty: string }> = {
  open: { label: 'open', empty: 'Nothing needs attention. New alerts appear as runs find them.' },
  acknowledged: { label: 'acknowledged', empty: 'Nothing has been acknowledged yet.' },
  resolved: { label: 'resolved', empty: 'Nothing has resolved yet — resolved means a competitor stopped undercutting you.' },
  all: { label: 'total', empty: 'No alerts have ever been raised.' },
};

/**
 * Alerts (Spec §5.5). Three types, all raised by scrape runs rather than
 * entered by hand: an undercut (a competitor cheaper than us at one of our
 * sites), a price drop (a competitor cutting their own price sharply), and a
 * listing gone (a matched product out of stock or 404ing there). Undercut and
 * listing_gone resolve themselves when they stop being true; a price drop is a
 * point-in-time event, so it is acknowledged rather than resolved.
 */
export function AlertsPage({ onQueueChange }: { onQueueChange: () => void }) {
  const toast = useToast();
  const [state, setState] = useState('open');
  const [type, setType] = useState('all');
  const [alerts, setAlerts] = useState<AlertRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await api.alerts(state, type);
      setAlerts(response.alerts);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load alerts');
    } finally {
      setLoading(false);
    }
  }, [state, type]);

  useEffect(() => {
    void load();
  }, [load]);

  const acknowledge = async (alertRow: AlertRow) => {
    setBusyId(alertRow.id);
    try {
      await api.acknowledgeAlert(alertRow.id);
      setAlerts((current) => current.filter((row) => row.id !== alertRow.id));
      onQueueChange();
      toast(`Acknowledged — ${alertRow.internal_sku}.`, 'ok');
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not acknowledge that alert', 'error');
    } finally {
      setBusyId(null);
    }
  };

  const acknowledgeAll = async () => {
    setBulkBusy(true);
    try {
      const result = await api.acknowledgeAllAlerts();
      await load();
      onQueueChange();
      toast(`Acknowledged ${result.acknowledged} alert(s).`, 'ok');
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not acknowledge alerts', 'error');
    } finally {
      setBulkBusy(false);
    }
  };

  const copy = STATE_COPY[state] ?? STATE_COPY.open!;

  return (
    <div className="page">
      <p className="page__intro">
        Three things raise an alert: a competitor going <strong>cheaper than us</strong> at one of
        our sites, a competitor <strong>cutting their own price</strong> sharply, and a product we
        had matched <strong>going out of stock or disappearing</strong> from their site. The first
        and last <strong>resolve automatically</strong> once they stop being true, so you never need
        to chase whether an alert still stands. How big a gap is worth raising one is set under
        Admin. Acknowledging just marks that you have seen it; it changes no price or match.
      </p>

      {error && <Alert tone="danger" title="Could not load alerts">{error}</Alert>}

      <Card
        title="Alerts"
        subtitle={`${alerts.length} ${copy.label}`}
        actions={
          <>
            <select
              className="select"
              value={type}
              onChange={(event) => setType(event.target.value)}
              aria-label="Alert type"
            >
              <option value="all">All types</option>
              <option value="undercut">Undercut</option>
              <option value="price_drop">Price drop</option>
              <option value="listing_gone">Listing gone</option>
            </select>
            <select className="select" value={state} onChange={(event) => setState(event.target.value)}>
              <option value="open">Open</option>
              <option value="acknowledged">Acknowledged</option>
              <option value="resolved">Resolved</option>
              <option value="all">All</option>
            </select>
            {state === 'open' && alerts.length > 0 && (
              <button type="button" className="btn btn--sm" onClick={() => void acknowledgeAll()} disabled={bulkBusy}>
                {bulkBusy ? 'Acknowledging…' : 'Acknowledge all'}
              </button>
            )}
          </>
        }
        bodyless
      >
        {loading ? (
          <TableSkeleton columns={4} />
        ) : alerts.length === 0 ? (
          <EmptyState mark="✓" title={`No ${copy.label} alerts`} body={copy.empty} />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Product</th>
                  <th>Type</th>
                  <th>Competitor</th>
                  <th className="num">Difference</th>
                  <th className="num">Raised</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {alerts.map((row) => (
                  <tr key={row.id}>
                    <td>
                      <div className="cell-primary truncate" style={{ maxWidth: 260 }}>
                        {row.product_name}
                      </div>
                      <div className="cell-secondary mono">
                        {row.internal_sku}
                        {row.fascia_name ? ` · ${row.fascia_name}` : ''}
                        {row.delisted_at ? ' · delisted' : ''}
                      </div>
                      {row.type !== 'undercut' && (
                        <div className="cell-secondary xs">{row.message}</div>
                      )}
                    </td>
                    <td>
                      <span
                        className={`badge ${TYPE_COPY[row.type]?.badge ?? 'badge--neutral'}`}
                        title={TYPE_COPY[row.type]?.hint ?? row.type}
                      >
                        {TYPE_COPY[row.type]?.label ?? row.type}
                      </span>
                    </td>
                    <td>
                      <CompetitorLabel
                        slug={row.competitor_slug}
                        displayName={row.competitor_name}
                        hasLogo={row.competitor_has_logo}
                        className="cell-primary"
                      />
                    </td>
                    <td className="num price">
                      {row.delta_abs == null
                        ? '—'
                        : `${formatMoney(row.delta_abs)} (${row.delta_pct?.toFixed(1) ?? '—'}%)`}
                    </td>
                    <td className="num muted xs nowrap">{relativeTime(row.created_at)}</td>
                    <td className="num nowrap">
                      {row.state === 'open' ? (
                        <button
                          type="button"
                          className="btn btn--sm btn--ghost"
                          disabled={busyId === row.id}
                          onClick={() => void acknowledge(row)}
                        >
                          {busyId === row.id ? 'Saving…' : 'Acknowledge'}
                        </button>
                      ) : (
                        <span className={`badge badge--${row.state === 'resolved' ? 'lower' : 'neutral'}`}>
                          {row.state}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
