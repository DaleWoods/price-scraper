import { useCallback, useEffect, useState } from 'react';
import {
  api,
  ApiError,
  formatMoney,
  type Fascia,
  type PositionAnalysis,
  type BasisSplit,
  type CoverageGapReport,
  type PositionBreakdown,
  type PositionTrendPoint,
  type StockOpportunity,
} from '../api';
import { Alert, Card, EmptyState, Stat, TableSkeleton } from '../components/ui';
import { EvidenceStrip } from '../components/EvidenceStrip';

/**
 * Where we sit in the market, in aggregate.
 *
 * Price comparison and What moved are per product — the right unit for someone
 * about to change a price. This is the unit for deciding a range or going into
 * a supplier conversation: not "this watch is £40 dearer" but "we are above the
 * market on three quarters of TAG Heuer, and it has been getting worse".
 */

/** A proportional bar: cheaper / level / dearer, left to right. */
function PositionBar({ row }: { row: PositionBreakdown }) {
  if (row.compared === 0) return <span className="muted">—</span>;
  const pct = (n: number) => `${(n / row.compared) * 100}%`;

  return (
    <div
      className="position-bar"
      title={`${row.lower} cheaper · ${row.equal} level · ${row.higher} dearer`}
    >
      <span className="position-bar__seg position-bar__seg--lower" style={{ width: pct(row.lower) }} />
      <span className="position-bar__seg position-bar__seg--equal" style={{ width: pct(row.equal) }} />
      <span className="position-bar__seg position-bar__seg--higher" style={{ width: pct(row.higher) }} />
    </div>
  );
}

function BreakdownTable({
  rows,
  label,
  empty,
}: {
  rows: PositionBreakdown[];
  label: string;
  empty: string;
}) {
  if (rows.length === 0) {
    return <EmptyState mark="—" title={`No ${label.toLowerCase()} to compare yet`} body={empty} />;
  }

  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th>{label}</th>
            <th className="num">Compared</th>
            <th style={{ minWidth: 160 }}>Cheaper · level · dearer</th>
            <th className="num">They beat us</th>
            <th className="num">Typical gap</th>
            <th className="num">Widest gap</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key}>
              <td className="cell-primary">{row.key}</td>
              <td className="num muted">{row.compared.toLocaleString()}</td>
              <td>
                <PositionBar row={row} />
              </td>
              <td className="num">
                <span
                  className={`badge ${
                    row.higherPct >= 50 ? 'badge--higher' : row.higherPct >= 25 ? 'badge--warn' : 'badge--lower'
                  }`}
                >
                  {row.higherPct.toFixed(1)}%
                </span>
              </td>
              <td className="num price">
                {row.medianGapAbs == null ? (
                  '—'
                ) : (
                  <span className={row.medianGapAbs > 0 ? 'price--higher' : 'price--lower'}>
                    {row.medianGapAbs > 0 ? '+' : ''}
                    {formatMoney(row.medianGapAbs)}
                    {row.medianGapPct != null && (
                      <div className="cell-secondary xs">
                        {row.medianGapPct > 0 ? '+' : ''}
                        {row.medianGapPct.toFixed(1)}%
                      </div>
                    )}
                  </span>
                )}
              </td>
              <td className="num">
                {row.worstGapAbs == null || row.worstGapAbs <= 0 ? (
                  <span className="muted">—</span>
                ) : (
                  <>
                    <span className="price price--higher">+{formatMoney(row.worstGapAbs)}</span>
                    <div className="cell-secondary mono xs">{row.worstGapSku}</div>
                  </>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** A plain bar chart of "how much of the range they beat us on", week by week. */
function TrendChart({ trend }: { trend: PositionTrendPoint[] }) {
  const points = trend.filter((point) => point.compared > 0);
  if (points.length < 2) {
    return (
      <p className="small muted">
        Not enough weeks of data to show a trend yet. This fills in as the nightly job runs.
      </p>
    );
  }

  // A fixed 0–100 axis, not one scaled to the data. Scaling to the maximum
  // makes a series sitting between 63% and 69% fill the chart and look
  // dramatic, when the honest picture is a high, fairly steady figure. On a
  // percentage chart the bar height should mean the percentage.
  return (
    <div className="trend">
      {points.map((point) => (
        <div key={point.weekStart} className="trend__col" title={`${point.compared} products compared`}>
          <div className="trend__bar-wrap">
            <div
              className="trend__bar"
              style={{ height: `${point.higherPct}%` }}
              aria-label={`${point.higherPct}% beaten in the week of ${point.weekStart}`}
            />
          </div>
          <div className="trend__value">{point.higherPct.toFixed(0)}%</div>
          <div className="trend__label">{point.weekStart.slice(5)}</div>
        </div>
      ))}
    </div>
  );
}

/** How each comparison basis reads, and what it means for the headline. */
const BASIS_COPY: Record<string, { label: string; note: string; tone: string }> = {
  like_for_like: {
    label: 'Like for like',
    note: 'Neither side on promotion — the position you actually hold.',
    tone: 'badge--lower',
  },
  ours_promotional: {
    label: 'We are on promotion',
    note: 'Any advantage here reverses when the sale ends.',
    tone: 'badge--warn',
  },
  theirs_promotional: {
    label: 'They are on promotion',
    note: 'They are discounting; your regular-price position may be fine.',
    tone: 'badge--warn',
  },
  both_promotional: {
    label: 'Both on promotion',
    note: 'A promotional skirmish rather than a standing position.',
    tone: 'badge--neutral',
  },
};

/**
 * The position split by who was on promotion.
 *
 * The figure that decides whether the headline can be trusted. A range looking
 * healthy because we are mid-sale against competitors at full price is in a
 * temporary position, not a good one, and it reverts the week the promotion
 * ends.
 */
function BasisTable({ rows }: { rows: BasisSplit[] }) {
  const total = rows.reduce((sum, row) => sum + row.compared, 0);
  if (total === 0) {
    return <p className="small muted">No comparisons yet.</p>;
  }

  const ordered = ['like_for_like', 'ours_promotional', 'theirs_promotional', 'both_promotional']
    .map((basis) => rows.find((row) => row.basis === basis))
    .filter((row): row is BasisSplit => row != null && row.compared > 0);

  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th>Basis</th>
            <th className="num">Products</th>
            <th className="num">Share</th>
            <th className="num">They beat us</th>
            <th>What it means</th>
          </tr>
        </thead>
        <tbody>
          {ordered.map((row) => (
            <tr key={row.basis}>
              <td>
                <span className={`badge ${BASIS_COPY[row.basis]?.tone ?? 'badge--neutral'}`}>
                  {BASIS_COPY[row.basis]?.label ?? row.basis}
                </span>
              </td>
              <td className="num muted">{row.compared.toLocaleString()}</td>
              <td className="num">{((row.compared / total) * 100).toFixed(0)}%</td>
              <td className="num">
                <span className={`badge ${row.higherPct >= 50 ? 'badge--higher' : 'badge--lower'}`}>
                  {row.higherPct.toFixed(1)}%
                </span>
              </td>
              <td className="xs muted">{BASIS_COPY[row.basis]?.note}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Live products nothing has compared yet, newest first. */
const GAP_REASON: Record<string, { label: string; tone: string; fix: string }> = {
  never_discovered: {
    label: 'Never looked for',
    tone: 'badge--higher',
    fix: 'No discovery run has reached it yet.',
  },
  awaiting_review: {
    label: 'Awaiting review',
    tone: 'badge--warn',
    fix: 'Candidates found — confirm or reject them on Match review.',
  },
  matched_but_unpriced: {
    label: 'Matched, no price yet',
    tone: 'badge--neutral',
    fix: 'A match is confirmed; the next scan should price it.',
  },
};

export function PositionPage() {
  const [fascias, setFascias] = useState<Fascia[]>([]);
  const [fascia, setFascia] = useState('');
  const [analysis, setAnalysis] = useState<PositionAnalysis | null>(null);
  const [gaps, setGaps] = useState<CoverageGapReport | null>(null);
  const [opportunities, setOpportunities] = useState<StockOpportunity[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const { fascias: loaded } = await api.fascias();
        setFascias(loaded);
        setFascia((current) => current || loaded[0]?.code || '');
      } catch {
        // The page still renders; it just cannot offer a site to choose.
      }
    })();
  }, []);

  const load = useCallback(async () => {
    if (!fascia) return;
    setLoading(true);
    setError(null);
    try {
      const [position, coverage, stock] = await Promise.all([
        api.position(fascia),
        api.coverageGaps(fascia),
        api.stockOpportunities(fascia),
      ]);
      setAnalysis(position);
      setGaps(coverage);
      setOpportunities(stock.opportunities);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not build the analysis');
    } finally {
      setLoading(false);
    }
  }, [fascia]);

  useEffect(() => {
    void load();
  }, [load]);

  const overall = analysis?.overall;
  const coverage =
    analysis && overall
      ? overall.compared + analysis.uncovered === 0
        ? 0
        : Math.round((overall.compared / (overall.compared + analysis.uncovered)) * 100)
      : 0;

  return (
    <div className="page">
      <p className="page__intro">
        Where we sit across the range, rather than product by product. Every figure is measured
        against the <strong>cheapest in-stock competitor</strong> for each product, at the site you
        pick. <strong>Dearer</strong> is the share where someone beats us on price — the number to
        argue with.
      </p>

      <EvidenceStrip fascia={fascia} />

      {error && (
        <Alert tone="danger" title="Could not build the analysis">
          {error}
        </Alert>
      )}

      {overall && (
        <div className="stat-grid">
          <Stat label="Products compared" value={overall.compared.toLocaleString()} tone="info" icon="◼" />
          <Stat
            label="We are cheaper"
            value={`${overall.compared ? ((overall.lower / overall.compared) * 100).toFixed(0) : 0}%`}
            tone="lower"
            icon="▼"
          />
          <Stat
            label="Level"
            value={`${overall.compared ? ((overall.equal / overall.compared) * 100).toFixed(0) : 0}%`}
            tone="equal"
            icon="="
          />
          <Stat
            label="They are cheaper"
            value={`${overall.higherPct.toFixed(0)}%`}
            tone={overall.higherPct >= 50 ? 'higher' : 'accent'}
            icon="▲"
          />
          <Stat
            label="Typical gap"
            value={overall.medianGapAbs == null ? '—' : formatMoney(overall.medianGapAbs)}
            tone={overall.medianGapAbs != null && overall.medianGapAbs > 0 ? 'higher' : 'lower'}
            icon="↔"
          />
          <Stat
            label="Range covered"
            value={`${coverage}%`}
            tone={coverage >= 50 ? 'lower' : 'accent'}
            icon="◎"
            meta={`${analysis!.uncovered.toLocaleString()} with no competitor price`}
          />
        </div>
      )}

      {analysis && analysis.uncovered > analysis.overall.compared && (
        <Alert tone="warn" title="Most of the range has no competitor price yet">
          Every percentage above describes only the {analysis.overall.compared.toLocaleString()}{' '}
          products we can actually compare. The other {analysis.uncovered.toLocaleString()} are not
          ties — nobody has priced them. Treat the shape as indicative until coverage improves.
        </Alert>
      )}

      {opportunities.length > 0 && (
        <Card
          title="Cheaper elsewhere, but nobody can buy it"
          subtitle={`${opportunities.length} product(s) where the only rival beating us is out of stock`}
          bodyless
        >
          <p className="small muted" style={{ padding: 'var(--sp-3) var(--sp-4) 0' }}>
            For as long as this lasts there is no cheaper <em>buyable</em> alternative — an argument
            for holding a price rather than following one down. Products where someone in stock
            already beats us are left out: the window only exists while nobody can fulfil.
          </p>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Product</th>
                  <th>Unavailable at</th>
                  <th className="num">Their price</th>
                  <th className="num">Ours</th>
                  <th className="num">Gap</th>
                </tr>
              </thead>
              <tbody>
                {opportunities.slice(0, 25).map((entry) => (
                  <tr key={entry.productId}>
                    <td>
                      <div className="cell-primary truncate" style={{ maxWidth: 280 }}>
                        {entry.productName}
                      </div>
                      <div className="cell-secondary mono">{entry.internalSku}</div>
                    </td>
                    <td className="nowrap">{entry.competitorName}</td>
                    <td className="num price muted">{formatMoney(entry.theirPrice)}</td>
                    <td className="num price">{formatMoney(entry.ourPrice)}</td>
                    <td className="num">
                      <span className="badge badge--lower">
                        +{formatMoney(entry.gapAbs)} ({entry.gapPct.toFixed(1)}%)
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      <Card
        title="Is the position real, or a promotion?"
        subtitle="The same comparison, split by who was discounting at the time"
      >
        {loading ? <TableSkeleton columns={5} /> : <BasisTable rows={analysis?.byBasis ?? []} />}
      </Card>

      {gaps && gaps.total > 0 && (
        <Card
          title="New lines nothing has compared yet"
          subtitle={`${gaps.total.toLocaleString()} live product(s) with no competitor price — ${gaps.newlyAdded} added in the last ${gaps.windowDays} days`}
          bodyless
        >
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Product</th>
                  <th>Brand</th>
                  <th className="num">Our price</th>
                  <th className="num">Live for</th>
                  <th>Why</th>
                </tr>
              </thead>
              <tbody>
                {gaps.gaps.slice(0, 25).map((gap) => (
                  <tr key={gap.productId}>
                    <td>
                      <div className="cell-primary truncate" style={{ maxWidth: 280 }}>
                        {gap.productName}
                      </div>
                      <div className="cell-secondary mono">
                        {gap.internalSku}
                        {gap.eanMpn && ` · ${gap.eanMpn}`}
                      </div>
                    </td>
                    <td className="nowrap">{gap.brand}</td>
                    <td className="num price">
                      {gap.ourPrice == null ? '—' : formatMoney(gap.ourPrice)}
                    </td>
                    <td className="num muted xs nowrap">
                      {gap.ageDays === 0 ? 'today' : `${gap.ageDays}d`}
                    </td>
                    <td className="xs">
                      <span className={`badge ${GAP_REASON[gap.reason]?.tone ?? 'badge--neutral'}`}>
                        {GAP_REASON[gap.reason]?.label ?? gap.reason}
                      </span>
                      <div className="cell-secondary">{GAP_REASON[gap.reason]?.fix}</div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {gaps.gaps.length > 25 && (
            <p className="small muted" style={{ padding: 'var(--sp-3)' }}>
              Showing the 25 newest of {gaps.total.toLocaleString()}. Discovery runs reach uncovered
              products first, so this list drains on its own as the nightly job works through it.
            </p>
          )}
        </Card>
      )}

      <Card
        title="How it has moved"
        subtitle="Share of the compared range where a competitor beats us, by week"
      >
        {loading ? <TableSkeleton columns={3} /> : <TrendChart trend={analysis?.trend ?? []} />}
        <p className="small muted" style={{ marginTop: 'var(--sp-3)' }}>
          Reconstructed from what we observed each week. Our own price history only begins from when
          we started keeping it, so the earliest weeks assume our current price applied then — right
          for most products, since prices rarely move week to week, but it understates how much our
          own side was moving back then.
        </p>
      </Card>

      <Card
        title="By brand"
        subtitle="Where the position is worth arguing about"
        actions={
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
        }
        bodyless
      >
        {loading ? (
          <TableSkeleton columns={6} />
        ) : (
          <BreakdownTable
            rows={analysis?.byBrand ?? []}
            label="Brand"
            empty="Confirm some matches and run a scan — brands appear here once their products have a competitor price."
          />
        )}
      </Card>

      <Card title="By category" bodyless>
        {loading ? (
          <TableSkeleton columns={6} />
        ) : (
          <BreakdownTable
            rows={analysis?.byCategory ?? []}
            label="Category"
            empty="Categories appear here once their products have a competitor price."
          />
        )}
      </Card>

      <Card
        title="By competitor"
        subtitle="How each retailer prices against us across everything we both sell"
        bodyless
      >
        {loading ? (
          <TableSkeleton columns={6} />
        ) : (
          <BreakdownTable
            rows={analysis?.byCompetitor ?? []}
            label="Competitor"
            empty="Each competitor appears here once we have prices from them."
          />
        )}
      </Card>
    </div>
  );
}
