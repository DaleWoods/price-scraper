import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  api,
  ApiError,
  formatMoney,
  relativeTime,
  type LookupCompetitor,
  type LookupResult,
  type RecentLookup,
} from '../api';
import { CompetitorLabel } from '../components/CompetitorLogo';
import { Alert, Card, EmptyState } from '../components/ui';

/**
 * Check a product: the whole app in one box.
 *
 * Paste one of our product URLs, or a SKU, reference or barcode. The product
 * is read from our own site — nothing to type in — and every enabled
 * competitor is checked for the exact same product. Only exact matches are
 * shown: the same barcode, or the same manufacturer reference on a page that
 * names the brand.
 */
export function CheckPage() {
  const [params, setParams] = useSearchParams();
  const productId = Number(params.get('product')) || null;

  const [input, setInput] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<LookupResult | null>(null);
  const [recent, setRecent] = useState<RecentLookup[]>([]);
  const timer = useRef<number | null>(null);

  const loadRecent = useCallback(() => {
    api
      .recentLookups()
      .then((response) => setRecent(response.recent))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    loadRecent();
  }, [loadRecent]);

  // Load the product in the address, and keep reloading while it is being
  // checked, so prices appear as each competitor answers.
  useEffect(() => {
    if (!productId) {
      setResult(null);
      return;
    }
    let cancelled = false;
    const load = async () => {
      try {
        const next = await api.lookupResult(productId);
        if (cancelled) return;
        setResult(next);
        if (next.running) timer.current = window.setTimeout(load, 2500);
        else loadRecent();
      } catch (err) {
        if (!cancelled) setError(err instanceof ApiError ? err.message : 'Could not load that product');
      }
    };
    void load();
    return () => {
      cancelled = true;
      if (timer.current) window.clearTimeout(timer.current);
    };
  }, [productId, loadRecent]);

  const check = async (value: string) => {
    const text = value.trim();
    if (!text) return;
    setSubmitting(true);
    setError(null);
    try {
      const { productId: id } = await api.lookup(text);
      setResult(null);
      setParams({ product: String(id) });
      // Same product checked again: the effect will not re-run on its own.
      if (id === productId) {
        setResult(await api.lookupResult(id));
        setParams({ product: String(id), t: String(Date.now()) });
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not start the check');
    } finally {
      setSubmitting(false);
    }
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    void check(input);
  };

  return (
    <div className="page">
      <Card>
        <form className="check-form" onSubmit={submit}>
          <input
            className="input check-form__input"
            value={input}
            onChange={(event) => setInput(event.target.value)}
            placeholder="Paste a product URL from our site, or a SKU, manufacturer reference or barcode"
            aria-label="Product to check"
            autoFocus
          />
          <button type="submit" className="btn btn--primary" disabled={submitting || !input.trim()}>
            {submitting ? 'Starting…' : 'Check prices'}
          </button>
        </form>
        <p className="small muted" style={{ margin: 'var(--sp-3) 0 0' }}>
          We read the product from our own website, then look for the exact same product at each
          competitor — same barcode or same manufacturer reference. Anything less certain is left out.
        </p>
      </Card>

      {error && (
        <Alert tone="warn" title="Couldn't check that">
          {error}
        </Alert>
      )}

      {result && <ResultCard result={result} onRecheck={() => void check(result.product.sku)} />}

      {!result && !productId && recent.length > 0 && (
        <Card title="Recently checked" bodyless>
          <div className="table-wrap">
            <table className="table">
              <tbody>
                {recent.map((row) => (
                  <tr
                    key={row.productId}
                    className="table__row--clickable"
                    onClick={() => setParams({ product: String(row.productId) })}
                  >
                    <td>
                      <div className="cell-primary">
                        {row.brand} {row.name}
                      </div>
                      <div className="cell-secondary mono xs">{row.sku}</div>
                    </td>
                    <td className="num">
                      {row.found > 0 ? (
                        <span className="badge badge--info">
                          {row.found} competitor{row.found === 1 ? '' : 's'}
                        </span>
                      ) : (
                        <span className="badge badge--neutral">none found</span>
                      )}
                    </td>
                    <td className="num muted">{relativeTime(row.lookedUpAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}

function ResultCard({ result, onRecheck }: { result: LookupResult; onRecheck: () => void }) {
  const { product } = result;
  const ours = product.price;

  const order: Record<string, number> = { found: 0, checking: 1, error: 2, blocked: 3, not_found: 4, not_checked: 5 };
  const rows = [...result.competitors].sort(
    (a, b) => order[a.status]! - order[b.status]! || (a.price ?? 0) - (b.price ?? 0),
  );
  const found = rows.filter((row) => row.status === 'found');
  const cheapest = found.reduce<LookupCompetitor | null>(
    (best, row) => (row.price != null && (!best || row.price < (best.price ?? Infinity)) ? row : best),
    null,
  );

  return (
    <Card bodyless>
      <div className="check-product">
        {product.imageUrl ? (
          <img className="check-product__image" src={product.imageUrl} alt="" />
        ) : (
          <div className="check-product__image check-product__image--empty" aria-hidden>
            ◇
          </div>
        )}
        <div className="grow">
          <div className="topbar__eyebrow">{product.brand}</div>
          <h2 className="check-product__name">{product.name}</h2>
          <div className="mono xs muted">
            SKU {product.sku}
            {product.mpn && <> · Ref {product.mpn}</>}
            {product.gtin && <> · Barcode {product.gtin}</>}
          </div>
          {product.url && (
            <a className="small" href={product.url} target="_blank" rel="noreferrer">
              View on {product.siteName ?? 'our site'} ↗
            </a>
          )}
        </div>
        <div className="check-product__price">
          <div className="xs muted">Our price{product.siteName ? ` · ${product.siteName}` : ''}</div>
          <div className="check-product__amount">{formatMoney(ours)}</div>
          {product.wasPrice != null && <div className="xs muted">was {formatMoney(product.wasPrice)}</div>}
        </div>
      </div>

      <div className="check-summary">
        {result.running ? (
          <span>
            <span className="spinner" /> Checking competitors…
          </span>
        ) : found.length === 0 ? (
          <span>No competitor we can read sells this exact product.</span>
        ) : (
          <span>
            Found at <strong>{found.length}</strong> competitor{found.length === 1 ? '' : 's'}.
            {cheapest && ours != null && cheapest.price != null && (
              <>
                {' '}
                {cheapest.price < ours ? (
                  <strong className="text-higher">
                    {cheapest.name} is {formatMoney(ours - cheapest.price)} cheaper than us.
                  </strong>
                ) : cheapest.price === ours ? (
                  <>Nobody is cheaper than us.</>
                ) : (
                  <strong className="text-lower">We are the cheapest.</strong>
                )}
              </>
            )}
          </span>
        )}
        <span className="grow" />
        {!result.running && (
          <>
            <span className="xs muted">Checked {relativeTime(result.checkedAt)}</span>
            <button type="button" className="btn btn--sm" onClick={onRecheck}>
              Check again
            </button>
          </>
        )}
      </div>

      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Competitor</th>
              <th className="num">Their price</th>
              <th>Compared with ours</th>
              <th>Stock</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.slug}>
                <td>
                  <CompetitorLabel slug={row.slug} displayName={row.name} hasLogo={false} className="cell-primary" />
                  {row.title && <div className="cell-secondary xs truncate">{row.title}</div>}
                </td>
                <td className="num">
                  {row.price != null ? (
                    <>
                      <strong>{formatMoney(row.price)}</strong>
                      {row.onSale && row.wasPrice != null && (
                        <div className="xs muted">was {formatMoney(row.wasPrice)}</div>
                      )}
                    </>
                  ) : (
                    <span className="muted">—</span>
                  )}
                </td>
                <td>
                  <Comparison row={row} ours={ours} />
                </td>
                <td className="small">
                  {row.status === 'found'
                    ? row.inStock === false
                      ? 'Out of stock'
                      : row.inStock
                        ? 'In stock'
                        : '—'
                    : ''}
                </td>
                <td className="num">
                  {row.url && (
                    <a className="btn btn--sm" href={row.url} target="_blank" rel="noreferrer">
                      View ↗
                    </a>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length === 0 && (
        <EmptyState title="No competitors switched on" body="Turn some on in Admin → Competitors." />
      )}
    </Card>
  );
}

function Comparison({ row, ours }: { row: LookupCompetitor; ours: number | null }) {
  switch (row.status) {
    case 'checking':
      return (
        <span className="small muted">
          <span className="spinner" /> Checking…
        </span>
      );
    case 'not_found':
      return <span className="small muted">Not sold there</span>;
    case 'not_checked':
      return <span className="small muted">Not checked yet</span>;
    case 'blocked':
      return <span className="badge badge--warn">Couldn't check — site turned us away</span>;
    case 'error':
      return <span className="badge badge--warn">{row.note ?? "Couldn't check this time"}</span>;
    case 'found': {
      if (row.price == null || ours == null) return <span className="muted">—</span>;
      const diff = Math.round((row.price - ours) * 100) / 100;
      if (Math.abs(diff) < 0.01) return <span className="badge badge--equal">Same price</span>;
      const pct = Math.abs((diff / ours) * 100).toFixed(1);
      return diff < 0 ? (
        <span className="badge badge--higher">
          {formatMoney(-diff)} cheaper than us ({pct}%)
        </span>
      ) : (
        <span className="badge badge--lower">
          {formatMoney(diff)} dearer than us ({pct}%)
        </span>
      );
    }
  }
}
