import { Fragment, useCallback, useEffect, useState } from 'react';
import { api, ApiError, formatMoney, type MatchRow } from '../api';
import { Alert, Card, ConfidenceMeter, EmptyState, TableSkeleton, useToast } from '../components/ui';

const TIER_LABELS: Record<string, string> = {
  ean_mpn_exact: 'EAN/MPN exact',
  brand_spec_attributes: 'Brand + specs',
  fuzzy_name_specs: 'Fuzzy name',
  manual: 'Manually linked',
};

export function ReviewQueuePage({ onQueueChange }: { onQueueChange: () => void }) {
  const toast = useToast();
  const [status, setStatus] = useState('pending');
  const [matches, setMatches] = useState<MatchRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await api.matches(status);
      setMatches(response.matches);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load the review queue');
    } finally {
      setLoading(false);
    }
  }, [status]);

  useEffect(() => {
    void load();
  }, [load]);

  const decide = async (match: MatchRow, decision: 'confirm' | 'reject') => {
    setBusyId(match.id);
    try {
      if (decision === 'confirm') await api.confirmMatch(match.id);
      else await api.rejectMatch(match.id);

      setMatches((current) => current.filter((row) => row.id !== match.id));
      onQueueChange();
      toast(
        decision === 'confirm'
          ? `Confirmed — ${match.internal_sku} will be scraped at that URL from now on.`
          : `Rejected — ${match.internal_sku} will not be linked to that listing.`,
        'ok',
      );
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not save that decision', 'error');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="page">
      <p className="page__intro">
        Candidate matches below the auto-accept threshold land here. Confirming stores the competitor
        URL against the product, so future runs hit that page directly instead of re-searching.
      </p>

      {error && <Alert tone="danger" title="Could not load matches">{error}</Alert>}

      <Card
        title="Match review"
        subtitle={`${matches.length} ${status === 'all' ? 'total' : status}`}
        actions={
          <select className="select" value={status} onChange={(event) => setStatus(event.target.value)}>
            <option value="pending">Pending review</option>
            <option value="confirmed">Confirmed</option>
            <option value="rejected">Rejected</option>
            <option value="all">All</option>
          </select>
        }
        bodyless
      >
        {loading ? (
          <TableSkeleton columns={5} />
        ) : matches.length === 0 ? (
          <EmptyState
            mark="✓"
            title={status === 'pending' ? 'Queue is clear' : `No ${status} matches`}
            body={
              status === 'pending'
                ? 'Every candidate has been dealt with. New ones appear after a discovery run.'
                : 'Nothing to show for this filter.'
            }
          />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Our product</th>
                  <th>Candidate listing</th>
                  <th>Tier</th>
                  <th style={{ width: 140 }}>Confidence</th>
                  <th style={{ width: 190 }} />
                </tr>
              </thead>
              <tbody>
                {matches.map((match) => (
                  <Fragment key={match.id}>
                    <tr>
                      <td>
                        <div className="cell-primary truncate" style={{ maxWidth: 240 }}>
                          {match.product_name}
                        </div>
                        <div className="cell-secondary mono">
                          {match.internal_sku} · {formatMoney(match.our_price, match.currency)}
                        </div>
                      </td>
                      <td>
                        <div className="cell-primary truncate" style={{ maxWidth: 280 }}>
                          {match.competitor_title ?? '(no title extracted)'}
                        </div>
                        <div className="cell-secondary">
                          {match.competitor_name} ·{' '}
                          <a href={match.competitor_url} target="_blank" rel="noreferrer noopener">
                            open listing ↗
                          </a>
                        </div>
                      </td>
                      <td>
                        <span className="badge badge--info">
                          {TIER_LABELS[match.match_tier] ?? match.match_tier}
                        </span>
                      </td>
                      <td>
                        <ConfidenceMeter value={match.confidence} />
                      </td>
                      <td>
                        <div className="row row--end" style={{ gap: 6 }}>
                          <button
                            type="button"
                            className="btn btn--sm btn--ghost"
                            onClick={() => setExpanded(expanded === match.id ? null : match.id)}
                          >
                            {expanded === match.id ? 'Hide' : 'Why?'}
                          </button>
                          {match.status === 'pending' && (
                            <>
                              <button
                                type="button"
                                className="btn btn--sm btn--danger"
                                disabled={busyId === match.id}
                                onClick={() => void decide(match, 'reject')}
                              >
                                Reject
                              </button>
                              <button
                                type="button"
                                className="btn btn--sm btn--ok"
                                disabled={busyId === match.id}
                                onClick={() => void decide(match, 'confirm')}
                              >
                                Confirm
                              </button>
                            </>
                          )}
                          {match.status !== 'pending' && (
                            <span className={`badge badge--${match.status === 'confirmed' ? 'lower' : 'neutral'}`}>
                              {match.status}
                            </span>
                          )}
                        </div>
                      </td>
                    </tr>
                    {expanded === match.id && (
                      <tr>
                        <td colSpan={5} style={{ background: 'var(--surface-sunken)' }}>
                          <MatchEvidencePanel match={match} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

function MatchEvidencePanel({ match }: { match: MatchRow }) {
  const evidence = match.evidence ?? {};

  return (
    <div className="stack" style={{ padding: 'var(--sp-2) 0' }}>
      <div className="row row--wrap" style={{ gap: 'var(--sp-2)' }}>
        {(evidence.gatesPassed ?? []).map((gate) => (
          <span key={gate} className="badge badge--lower">
            gate ✓ {gate.replace(/_/g, ' ')}
          </span>
        ))}
        {(evidence.gatesFailed ?? []).map((gate) => (
          <span key={gate} className="badge badge--higher">
            gate ✕ {gate.replace(/_/g, ' ')}
          </span>
        ))}
        {evidence.nameSimilarity != null && (
          <span className="badge badge--neutral">
            name similarity {(evidence.nameSimilarity * 100).toFixed(0)}%
          </span>
        )}
        {match.competitor_ean && (
          <span className="badge badge--neutral">their EAN/MPN {match.competitor_ean}</span>
        )}
        {match.ean_mpn && <span className="badge badge--neutral">our EAN/MPN {match.ean_mpn}</span>}
      </div>

      <div className="spec-grid">
        {(evidence.attributeHits ?? []).map((hit) => (
          <div className="spec" key={`hit-${hit.attribute}`} style={{ borderColor: 'var(--pos-lower-border)' }}>
            <div className="spec__key">
              ✓ {hit.attribute.replace(/_/g, ' ')} · {hit.weight}
            </div>
            <div className="spec__value">{hit.ours}</div>
            <div className="xs muted">theirs: {hit.theirs || '—'}</div>
          </div>
        ))}
        {(evidence.attributeMisses ?? []).map((miss) => (
          <div className="spec" key={`miss-${miss.attribute}`}>
            <div className="spec__key">
              — {miss.attribute.replace(/_/g, ' ')} · {miss.weight}
            </div>
            <div className="spec__value">{miss.ours}</div>
            <div className="xs muted">theirs: {miss.theirs || '—'}</div>
          </div>
        ))}
      </div>

      {(evidence.notes ?? []).length > 0 && (
        <ul className="small muted" style={{ margin: 0, paddingLeft: 'var(--sp-5)' }}>
          {evidence.notes!.map((note, index) => (
            <li key={index}>{note}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
