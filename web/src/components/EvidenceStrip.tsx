import { useEffect, useState } from 'react';
import { api, formatDateTime, type EvidenceBasis } from '../api';

/**
 * What the figures on this page are drawn from.
 *
 * The first thing anyone asks of a percentage is how much it is based on, and
 * an unqualified "63% of the range is beaten" invites exactly that challenge.
 * It is also the number most likely to be embarrassing: 63% of a tenth of the
 * catalogue, read a fortnight ago, is a very different claim from 63% of all of
 * it read last night. Saying so before the question is asked costs a line and
 * buys the rest of the page its credibility.
 *
 * Shown on every analytical page so the answer is the same wherever it is
 * read — the same figures described differently in two places is how a
 * meeting stops trusting all of them.
 */
export function EvidenceStrip({ fascia }: { fascia: string }) {
  const [basis, setBasis] = useState<EvidenceBasis | null>(null);

  useEffect(() => {
    if (!fascia) return;
    let cancelled = false;
    void (async () => {
      try {
        const next = await api.evidence(fascia);
        if (!cancelled) setBasis(next);
      } catch {
        // The strip is context, not content. If it cannot load, the page is
        // still perfectly usable without it.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [fascia]);

  if (!basis) return null;

  const thin = basis.coveragePct < 25;
  const stale = basis.medianPriceAgeDays != null && basis.medianPriceAgeDays >= 7;
  const ageText =
    basis.medianPriceAgeDays == null
      ? 'no prices yet'
      : basis.medianPriceAgeDays < 1
        ? 'read today'
        : `typically ${basis.medianPriceAgeDays.toFixed(0)} day(s) old`;

  return (
    <div className={`evidence ${thin || stale ? 'evidence--thin' : ''}`}>
      <span className="evidence__label">Based on</span>
      <span>
        <strong>{basis.productsCompared.toLocaleString()}</strong> of{' '}
        {basis.productsPriced.toLocaleString()} products we price
        {basis.productsPriced > 0 && <> ({basis.coveragePct.toFixed(0)}%)</>}
      </span>
      <span aria-hidden="true">·</span>
      <span>
        <strong>{basis.competitorsContributing}</strong> of {basis.competitorsEnabled} competitor(s)
        producing prices
      </span>
      <span aria-hidden="true">·</span>
      <span>
        prices {ageText}
        {basis.oldestPriceAgeDays != null && basis.oldestPriceAgeDays >= 14 && (
          <>, oldest {basis.oldestPriceAgeDays.toFixed(0)} days</>
        )}
      </span>
      {basis.lastRunFinishedAt && (
        <>
          <span aria-hidden="true">·</span>
          <span>last scan {formatDateTime(basis.lastRunFinishedAt)}</span>
        </>
      )}
      {thin && (
        <span className="evidence__warning">
          Thin coverage — treat the percentages as indicative
        </span>
      )}
    </div>
  );
}
