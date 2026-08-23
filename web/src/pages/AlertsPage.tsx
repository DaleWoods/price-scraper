import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, formatMoney, relativeTime, type AlertRow } from '../api';
import { Alert, Card, EmptyState, TableSkeleton, useToast } from '../components/ui';
import { CompetitorLabel } from '../components/CompetitorLogo';

const STATE_COPY: Record<string, { label: string; empty: string }> = {
  open: { label: 'open', empty: 'Nothing currently undercuts you. New alerts appear as runs find them.' },
  acknowledged: { label: 'acknowledged', empty: 'Nothing has been acknowledged yet.' },
  resolved: { label: 'resolved', empty: 'Nothing has resolved yet — resolved means a competitor stopped undercutting you.' },
  all: { label: 'total', empty: 'No alerts have ever been raised.' },
};

/**
 * Undercut alerts: a competitor's confirmed price has dropped below ours at
 * one of our sites. Raised and resolved automatically by every scrape run —
 * nothing here is a manual entry.
 */
export function AlertsPage({ onQueueChange }: { onQueueChange: () => void }) {
  const toast = useToast();
  const [state, setState] = useState('open');
  const [alerts, setAlerts] = useState<AlertRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await api.alerts(state);
      setAlerts(response.alerts);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load alerts');
    } finally {
      setLoading(false);
    }
  }, [state]);

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
        Raised the moment a confirmed competitor price drops below ours at one of our sites, and{' '}
        <strong>resolved automatically</strong> the moment it no longer does — you never need to chase
        whether an alert is still true. Acknowledging one just marks that you have seen it; it does not
        change any price or match.
      </p>

      {error && <Alert tone="danger" title="Could not load alerts">{error}</Alert>}

      <Card
        title="Undercut alerts"
        subtitle={`${alerts.length} ${copy.label}`}
        actions={
          <>
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
                  <th>Competitor</th>
                  <th className="num">Undercut</th>
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
