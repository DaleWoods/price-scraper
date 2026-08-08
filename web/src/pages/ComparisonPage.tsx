import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  api,
  ApiError,
  formatDateTime,
  formatMoney,
  formatPct,
  relativeTime,
  type ComparisonResponse,
  type ComparisonRow,
  type PricePosition,
} from '../api';
import {
  Alert,
  BrandChip,
  Card,
  EmptyState,
  PositionBadge,
  Stat,
  TableSkeleton,
  useToast,
} from '../components/ui';
import { CompetitorLabel } from '../components/CompetitorLogo';

type PositionFilter = PricePosition | 'unmatched' | 'awaiting_price' | '';

/**
 * The distinguishing detail of a catalogue row — size, metal, reference — which
 * otherwise sits at the far end of a long, near-identical product name.
 */
function productDetail(product: ComparisonRow['product']): string {
  const specs = product.specs ?? {};
  return [specs.case_size, specs.case_material, specs.carat_weight, product.ean_mpn]
    .filter(Boolean)
    .join(' · ');
}

export function ComparisonPage() {
  const toast = useToast();
  const [data, setData] = useState<ComparisonResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [facets, setFacets] = useState<{ brands: string[]; categories: string[] }>({
    brands: [],
    categories: [],
  });
  const [selected, setSelected] = useState<ComparisonRow | null>(null);

  const [search, setSearch] = useState('');
  const [brand, setBrand] = useState('');
  const [category, setCategory] = useState('');
  const [position, setPosition] = useState<PositionFilter>('');

  const filters = useMemo(
    () => ({ search: search || null, brand: brand || null, category: category || null, position: position || null }),
    [search, brand, category, position],
  );

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await api.comparison({ ...filters, limit: 200 }));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load the comparison view');
    } finally {
      setLoading(false);
    }
  }, [filters]);

  useEffect(() => {
    // Debounced so typing in the search box doesn't fire a request per keystroke.
    const timer = setTimeout(() => void load(), 250);
    return () => clearTimeout(timer);
  }, [load]);

  useEffect(() => {
    void api
      .facets()
      .then(setFacets)
      .catch(() => undefined);
  }, []);

  const summary = data?.summary;
  const rows = data?.rows ?? [];

  const exportUrl = useMemo(() => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(filters)) if (value) params.set(key, String(value));
    const query = params.toString();
    return `/api/comparison/export.csv${query ? `?${query}` : ''}`;
  }, [filters]);

  const togglePosition = (next: PositionFilter) => setPosition((current) => (current === next ? '' : next));

  const runNow = async () => {
    try {
      const { run } = await api.startRun({ mode: 'prices' });
      toast(`Scrape run #${run.id} started — prices for confirmed matches.`, 'ok');
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not start the run', 'error');
    }
  };

  return (
    <div className="page">
      <p className="page__intro">
        Our price against each competitor's latest observed price. Position is measured against the
        cheapest in-stock competitor — <strong>they are cheaper</strong> is the column that needs action.
      </p>

      <div className="stat-grid">
        <Stat
          label="Products"
          value={summary?.products ?? '—'}
          meta={`${summary?.withCompetitorPrice ?? 0} with a competitor price`}
          tone="accent"
          icon="◆"
        />
        <Stat
          label="We are cheaper"
          value={summary?.lower ?? '—'}
          meta="We undercut the market"
          tone="lower"
          icon="▼"
          active={position === 'lower'}
          onClick={() => togglePosition('lower')}
        />
        <Stat
          label="Level"
          value={summary?.equal ?? '—'}
          meta="Matched on price"
          tone="equal"
          icon="="
          active={position === 'equal'}
          onClick={() => togglePosition('equal')}
        />
        <Stat
          label="They are cheaper"
          value={summary?.higher ?? '—'}
          meta="Undercut by a competitor"
          tone="higher"
          icon="▲"
          active={position === 'higher'}
          onClick={() => togglePosition('higher')}
        />
        <Stat
          label="Match coverage"
          value={`${summary?.matchCoveragePct?.toFixed(0) ?? 0}%`}
          meta={`${summary?.unmatched ?? 0} with no competitor price`}
          tone="teal"
          icon="◎"
          active={position === 'unmatched'}
          onClick={() => togglePosition('unmatched')}
        />
        {(summary?.awaitingOurPrice ?? 0) > 0 && (
          <Stat
            label="Awaiting our price"
            value={summary?.awaitingOurPrice ?? 0}
            meta="Imported, no price loaded yet"
            tone="info"
            icon="⏳"
            active={position === 'awaiting_price'}
            onClick={() => togglePosition('awaiting_price')}
          />
        )}
      </div>

      {error && <Alert tone="danger" title="Could not load prices">{error}</Alert>}

      <Card
        title="Comparison"
        subtitle={data ? `${rows.length} of ${data.total} products` : undefined}
        actions={
          <>
            <a className="btn btn--sm" href={exportUrl} download>
              Export CSV
            </a>
            <button type="button" className="btn btn--sm btn--accent" onClick={runNow}>
              Run now
            </button>
          </>
        }
        bodyless
      >
        <div className="card__body" style={{ paddingBottom: 'var(--sp-4)' }}>
          <div className="filter-bar">
            <div className="field field--grow">
              <label className="label" htmlFor="search">
                Search
              </label>
              <input
                id="search"
                className="input"
                placeholder="SKU, brand, product name or EAN"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            </div>
            <div className="field">
              <label className="label" htmlFor="brand">
                Brand
              </label>
              <select id="brand" className="select" value={brand} onChange={(event) => setBrand(event.target.value)}>
                <option value="">All brands</option>
                {facets.brands.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label className="label" htmlFor="category">
                Category
              </label>
              <select
                id="category"
                className="select"
                value={category}
                onChange={(event) => setCategory(event.target.value)}
              >
                <option value="">All categories</option>
                {facets.categories.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label className="label" htmlFor="position">
                Position
              </label>
              <select
                id="position"
                className="select"
                value={position}
                onChange={(event) => setPosition(event.target.value as PositionFilter)}
              >
                <option value="">Any position</option>
                <option value="lower">We are cheaper</option>
                <option value="equal">Level</option>
                <option value="higher">They are cheaper</option>
                <option value="unmatched">No competitor price</option>
                <option value="awaiting_price">Awaiting our price</option>
              </select>
            </div>
            {(search || brand || category || position) && (
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                onClick={() => {
                  setSearch('');
                  setBrand('');
                  setCategory('');
                  setPosition('');
                }}
              >
                Clear
              </button>
            )}
          </div>
        </div>

        {loading && !data ? (
          <TableSkeleton />
        ) : rows.length === 0 ? (
          <EmptyState
            title="Nothing to compare yet"
            body={
              <>
                Import your catalogue, confirm some matches in the review queue, then trigger a run.
                Prices appear here once a confirmed match has been scraped.
              </>
            }
          />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Product</th>
                  <th>Brand</th>
                  <th className="num">Our price</th>
                  <th>Best competitor</th>
                  <th className="num">Their price</th>
                  <th className="num">Δ £</th>
                  <th className="num">Δ %</th>
                  <th>Position</th>
                  <th>Matches</th>
                  <th className="num">Seen</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr
                    key={row.product.id}
                    className="table__row--clickable"
                    onClick={() => setSelected(row)}
                  >
                    <td>
                      <div className="cell-primary truncate" style={{ maxWidth: 300 }}>
                        {row.product.product_name}
                      </div>
                      <div className="cell-secondary">
                        <span className="mono">{row.product.internal_sku}</span>
                        {productDetail(row.product) && (
                          <span> · {productDetail(row.product)}</span>
                        )}
                      </div>
                    </td>
                    <td className="nowrap">
                      <BrandChip brand={row.product.brand} />
                    </td>
                    <td className="num">
                      {row.product.our_price == null ? (
                        <span className="price--missing" title="No price file loaded for this SKU yet">
                          not loaded
                        </span>
                      ) : (
                        <span className="price">
                          {formatMoney(row.product.our_price, row.product.currency)}
                        </span>
                      )}
                    </td>
                    <td className="nowrap muted small">{row.bestCompetitorName ?? '—'}</td>
                    <td className="num price">{formatMoney(row.bestCompetitorPrice, row.product.currency)}</td>
                    <td className="num price">
                      {row.deltaAbs == null
                        ? '—'
                        : `${row.deltaAbs > 0 ? '+' : ''}${formatMoney(row.deltaAbs, row.product.currency)}`}
                    </td>
                    <td className="num">{formatPct(row.deltaPct)}</td>
                    <td>
                      <PositionBadge
                        position={row.position}
                        reason={row.ourPriceMissing ? 'awaiting-our-price' : 'no-competitor-price'}
                      />
                    </td>
                    <td className="nowrap">
                      <span className="badge badge--neutral" title={`${row.matchStatus.confirmed} confirmed match(es)`}>
                        ✓ {row.matchStatus.confirmed}
                      </span>
                      {row.matchStatus.pending > 0 && (
                        <span
                          className="badge badge--warn"
                          style={{ marginLeft: 4 }}
                          title={`${row.matchStatus.pending} awaiting review`}
                        >
                          ⏳ {row.matchStatus.pending}
                        </span>
                      )}
                    </td>
                    <td className="num muted xs nowrap">{relativeTime(row.observedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {selected && <ProductDrawer row={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}

function ProductDrawer({ row, onClose }: { row: ComparisonRow; onClose: () => void }) {
  const [history, setHistory] = useState<
    {
      id: number;
      competitor_name: string;
      competitor_slug: string;
      competitor_has_logo: boolean;
      price: number | null;
      observed_at: string;
    }[]
  >([]);

  useEffect(() => {
    void api
      .productHistory(row.product.id)
      .then((response) => setHistory(response.observations as never))
      .catch(() => setHistory([]));
  }, [row.product.id]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const specs = Object.entries(row.product.specs ?? {});

  return (
    <>
      <div className="drawer-backdrop" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-label={row.product.product_name}>
        <header className="drawer__header">
          <div className="grow">
            <div className="topbar__eyebrow">{row.product.brand}</div>
            <h2 style={{ fontSize: 'var(--text-lg)' }}>{row.product.product_name}</h2>
            <div className="mono" style={{ marginTop: 4 }}>
              {row.product.internal_sku}
              {row.product.ean_mpn ? ` · EAN/MPN ${row.product.ean_mpn}` : ''}
            </div>
          </div>
          <button type="button" className="btn btn--ghost btn--sm" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>

        <div className="drawer__body">
          <div className="stat-grid" style={{ gridTemplateColumns: '1fr 1fr' }}>
            <Stat
              label="Our price"
              value={row.product.our_price == null ? 'Not loaded' : formatMoney(row.product.our_price, row.product.currency)}
              meta={row.product.our_price == null ? 'Awaiting a price file' : undefined}
              tone="accent"
              icon="£"
            />
            <Stat
              label="Best competitor"
              value={formatMoney(row.bestCompetitorPrice, row.product.currency)}
              meta={row.bestCompetitorName ?? 'No competitor price'}
              tone={row.position ?? 'teal'}
              icon="◎"
            />
          </div>

          <Card title="Latest competitor prices" bodyless>
            {row.competitorPrices.length === 0 ? (
              <EmptyState
                title="No observations yet"
                body="Confirm a match for this product, then trigger a run."
              />
            ) : (
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Competitor</th>
                      <th className="num">Price</th>
                      <th>Position</th>
                      <th>Stock</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {row.competitorPrices.map((entry) => (
                      <tr key={entry.competitorId}>
                        <td>
                          <CompetitorLabel
                            slug={entry.competitorSlug}
                            displayName={entry.competitorName}
                            hasLogo={entry.competitorHasLogo}
                            className="cell-primary"
                          />
                          <div className="cell-secondary">{formatDateTime(entry.observedAt)}</div>
                        </td>
                        <td className="num">
                          <div className="price">{formatMoney(entry.price, row.product.currency)}</div>
                          {entry.wasPrice && (
                            <div className="price price--strike xs">
                              {formatMoney(entry.wasPrice, row.product.currency)}
                            </div>
                          )}
                          {entry.promo && (
                            <span className="badge badge--promo" style={{ marginTop: 4 }}>
                              Promo
                            </span>
                          )}
                        </td>
                        <td>
                          <PositionBadge position={entry.position} compact />
                        </td>
                        <td className="xs muted">
                          {entry.inStock === null ? 'Unknown' : entry.inStock ? 'In stock' : 'Out of stock'}
                        </td>
                        <td>
                          <a
                            className="btn btn--sm btn--ghost"
                            href={entry.sourceUrl}
                            target="_blank"
                            rel="noreferrer noopener"
                          >
                            View ↗
                          </a>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          {specs.length > 0 && (
            <Card title="Our spec attributes" subtitle="Used to build match confidence">
              <div className="spec-grid">
                {specs.map(([key, value]) => (
                  <div className="spec" key={key}>
                    <div className="spec__key">{key.replace(/_/g, ' ')}</div>
                    <div className="spec__value">{value}</div>
                  </div>
                ))}
              </div>
            </Card>
          )}

          <Card title="Observation history" subtitle="Most recent first" bodyless>
            {history.length === 0 ? (
              <EmptyState title="No history yet" body="Price history builds up as runs complete." />
            ) : (
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>When</th>
                      <th>Competitor</th>
                      <th className="num">Price</th>
                    </tr>
                  </thead>
                  <tbody>
                    {history.slice(0, 40).map((observation) => (
                      <tr key={observation.id}>
                        <td className="xs muted nowrap">{formatDateTime(observation.observed_at)}</td>
                        <td className="small">
                          <CompetitorLabel
                            slug={observation.competitor_slug}
                            displayName={observation.competitor_name}
                            hasLogo={observation.competitor_has_logo}
                            size="sm"
                          />
                        </td>
                        <td className="num price">
                          {formatMoney(observation.price, row.product.currency)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </div>
      </aside>
    </>
  );
}
