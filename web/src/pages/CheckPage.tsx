import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  api,
  ApiError,
  formatMoney,
  relativeTime,
  type BatchResult,
  type FeedIngestReport,
  type LookupCompetitor,
  type LookupResult,
  type RecentBatch,
  type RecentLookup,
} from '../api';
import { CompetitorLabel } from '../components/CompetitorLogo';
import { Alert, Card, EmptyState, useToast } from '../components/ui';
import { parseSkuList } from '../skuList';

/**
 * Check prices: the whole app on one page.
 *
 * Three ways in, one per box: one product (a URL from our site, a SKU, a
 * reference or a barcode); a list of them uploaded as a file; or everything we
 * sell, by collecting today's Google feeds and checking the lot. Products are
 * read from our own website, so nothing has to be typed in, and only exact
 * matches are shown — the same barcode, or the same manufacturer reference on
 * a page that names the brand.
 */
export function CheckPage() {
  const [params, setParams] = useSearchParams();
  const productId = Number(params.get('product')) || null;
  const batchId = Number(params.get('list')) || null;

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
  }, [productId, params, loadRecent]);

  const check = async (value: string) => {
    const text = value.trim();
    if (!text) return;
    setSubmitting(true);
    setError(null);
    try {
      const { productId: id } = await api.lookup(text);
      setResult(null);
      // The timestamp makes a re-check of the same product reload it too.
      setParams({ product: String(id), t: String(Date.now()) });
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
      <div className="check-grid">
        <Card title="One product" subtitle="A product URL from our site, or a SKU, manufacturer reference or barcode">
          <form className="check-form" onSubmit={submit}>
            <input
              className="input check-form__input"
              value={input}
              onChange={(event) => setInput(event.target.value)}
              placeholder="e.g. 17331581, O21030422004001, or https://www.goldsmiths.co.uk/…"
              aria-label="Product to check"
              autoFocus
            />
            <button type="submit" className="btn btn--primary" disabled={submitting || !input.trim()}>
              {submitting ? 'Starting…' : 'Check prices'}
            </button>
          </form>
        </Card>

        <ListCard onStarted={(id) => setParams({ list: String(id) })} />
      </div>

      <FeedsCard />

      <p className="small muted" style={{ margin: 0 }}>
        We read each product from our own website, then look for the exact same product at each
        competitor — same barcode or same manufacturer reference. Anything less certain is left out.
      </p>

      {error && (
        <Alert tone="warn" title="Couldn't check that">
          {error}
        </Alert>
      )}

      {result && <ResultCard result={result} onRecheck={() => void check(result.product.sku)} />}

      {batchId && <BatchCard batchId={batchId} />}

      {!result && !productId && !batchId && <RecentCard recent={recent} onOpen={setParams} />}
    </div>
  );
}

/* ---------- A list of products ------------------------------------------------- */

function ListCard({ onStarted }: { onStarted: (batchId: number) => void }) {
  const [values, setValues] = useState<string[]>([]);
  const [fileName, setFileName] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      setValues(parseSkuList(String(reader.result ?? '')));
      setFileName(file.name);
      setError(null);
    };
    reader.readAsText(file);
  };

  const start = async () => {
    setStarting(true);
    setError(null);
    try {
      const { batchId } = await api.lookupBatch(values, fileName);
      setValues([]);
      setFileName(null);
      onStarted(batchId);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not start the check');
    } finally {
      setStarting(false);
    }
  };

  return (
    <Card title="A list of products" subtitle="A CSV or text file of SKUs, references or barcodes — any mix">
      {fileName ? (
        <div className="check-form">
          <span className="badge badge--info" style={{ alignSelf: 'center' }}>
            {values.length.toLocaleString('en-GB')} value{values.length === 1 ? '' : 's'} · {fileName}
          </span>
          <span className="grow" />
          <button type="button" className="btn" onClick={() => (setValues([]), setFileName(null))}>
            Clear
          </button>
          <button
            type="button"
            className="btn btn--primary"
            disabled={starting || values.length === 0}
            onClick={() => void start()}
          >
            {starting ? 'Starting…' : `Check ${values.length.toLocaleString('en-GB')} products`}
          </button>
        </div>
      ) : (
        <label className="check-drop">
          <input
            type="file"
            accept=".csv,.txt,.tsv"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) load(file);
              event.target.value = '';
            }}
          />
          <span>Choose a file</span>
          <span className="xs muted">
            One per line, or a spreadsheet saved as CSV — only columns headed SKU, ID, GTIN, EAN, barcode,
            MPN or reference are read.
          </span>
        </label>
      )}
      {error && (
        <div style={{ marginTop: 'var(--sp-3)' }}>
          <Alert tone="warn">{error}</Alert>
        </div>
      )}
    </Card>
  );
}

function BatchCard({ batchId }: { batchId: number }) {
  const [batch, setBatch] = useState<BatchResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let handle: number | null = null;
    const load = async () => {
      try {
        const next = await api.batch(batchId);
        if (cancelled) return;
        setBatch(next);
        if (next.status === 'finding' || next.status === 'checking') handle = window.setTimeout(load, 3000);
      } catch (err) {
        if (!cancelled) setError(err instanceof ApiError ? err.message : 'Could not load that list');
      }
    };
    void load();
    return () => {
      cancelled = true;
      if (handle) window.clearTimeout(handle);
    };
  }, [batchId]);

  if (error) return <Alert tone="danger">{error}</Alert>;
  if (!batch) return null;

  const competitors = batch.products[0]?.competitors.map((c) => ({ slug: c.slug, name: c.name })) ?? [];
  const cheaperSomewhere = batch.products.filter((product) =>
    product.competitors.some(
      (c) => c.status === 'found' && c.price != null && product.product.price != null && c.price < product.product.price - 0.005,
    ),
  ).length;
  const foundSomewhere = batch.products.filter((product) => product.competitors.some((c) => c.status === 'found')).length;

  const download = () => {
    const header = ['SKU', 'Brand', 'Product', 'Reference', 'Our price', ...competitors.flatMap((c) => [`${c.name} price`, `${c.name} link`])];
    const lines = batch.products.map((product) => [
      product.product.sku,
      product.product.brand,
      product.product.name,
      product.product.mpn ?? '',
      product.product.price ?? '',
      ...competitors.flatMap((c) => {
        const entry = product.competitors.find((row) => row.slug === c.slug);
        return entry?.status === 'found' ? [entry.price ?? '', entry.url ?? ''] : ['', ''];
      }),
    ]);
    const csv = [header, ...lines]
      .map((line) => line.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(','))
      .join('\n');
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    link.download = `price-check-${batch.id}.csv`;
    link.click();
    URL.revokeObjectURL(link.href);
  };

  return (
    <Card bodyless>
      <div className="check-summary">
        <strong>{batch.fileName ?? `List #${batch.id}`}</strong>
        {batch.status === 'finding' ? (
          <span>
            <span className="spinner" /> Finding our products… {batch.processed} of {batch.total}
          </span>
        ) : batch.status === 'checking' ? (
          <span>
            <span className="spinner" /> Checking {batch.products.length} products at every competitor… prices appear
            as they arrive. A long list can take a while.
          </span>
        ) : batch.status === 'failed' ? (
          <span className="text-higher">The check failed: {batch.message}</span>
        ) : (
          <span>
            {batch.products.length} products checked · found at a competitor: <strong>{foundSomewhere}</strong> ·
            cheaper somewhere else: <strong className={cheaperSomewhere > 0 ? 'text-higher' : ''}>{cheaperSomewhere}</strong>
          </span>
        )}
        <span className="grow" />
        {batch.products.length > 0 && (
          <button type="button" className="btn btn--sm" onClick={download}>
            Download CSV
          </button>
        )}
      </div>

      {batch.unresolved.length > 0 && (
        <div style={{ padding: 'var(--sp-4) var(--sp-6) 0' }}>
          <Alert tone="warn" title={`${batch.unresolved.length} couldn't be found on our sites`}>
            <span className="mono xs">{batch.unresolved.slice(0, 40).join(', ')}</span>
            {batch.unresolved.length > 40 && <> and {batch.unresolved.length - 40} more</>}
          </Alert>
        </div>
      )}

      {batch.products.length > 0 && (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Product</th>
                <th className="num">Our price</th>
                {competitors.map((c) => (
                  <th key={c.slug} className="num">
                    {c.name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {batch.products.map((product) => (
                <tr key={product.product.id}>
                  <td>
                    <a className="cell-primary" href={`/check?product=${product.product.id}`}>
                      {product.product.brand} {product.product.name}
                    </a>
                    <div className="cell-secondary mono xs">{product.product.sku}</div>
                  </td>
                  <td className="num">{formatMoney(product.product.price)}</td>
                  {competitors.map((c) => (
                    <td key={c.slug} className="num nowrap">
                      <PriceCell entry={product.competitors.find((row) => row.slug === c.slug)} ours={product.product.price} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function PriceCell({ entry, ours }: { entry: LookupCompetitor | undefined; ours: number | null }) {
  if (!entry) return <span className="muted">—</span>;
  if (entry.status === 'checking') return <span className="spinner" />;
  if (entry.status === 'blocked' || entry.status === 'error') {
    return <span className="xs muted" title={entry.note ?? undefined}>couldn't check</span>;
  }
  if (entry.status !== 'found' || entry.price == null) return <span className="muted">—</span>;
  const tone =
    ours == null ? '' : entry.price < ours - 0.005 ? 'price--higher' : entry.price > ours + 0.005 ? 'price--lower' : '';
  return (
    <a className={`price price--link ${tone}`} href={entry.url ?? undefined} target="_blank" rel="noreferrer">
      {formatMoney(entry.price)} ↗
    </a>
  );
}

/* ---------- Everything we sell: the Google feeds --------------------------------- */

const SITE_NAMES: Record<string, string> = {
  '197': 'Goldsmiths',
  '439': 'Mappin & Webb',
  '470': 'Watches of Switzerland',
};

function FeedsCard() {
  const toast = useToast();
  const [collecting, setCollecting] = useState(false);
  const [report, setReport] = useState<FeedIngestReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  const collect = async () => {
    setCollecting(true);
    setError(null);
    try {
      setReport(await api.fetchFeeds());
    } catch (err) {
      const message = err instanceof ApiError ? err.message : 'Could not collect the feeds';
      // Not set up yet is a setting to add, not a failure; say which.
      setError(/no feed location is configured/i.test(message) ? 'not-configured' : message);
    } finally {
      setCollecting(false);
    }
  };

  const checkAll = async () => {
    try {
      const { run } = await api.startRun({ mode: 'both' });
      toast(`Checking every product against every competitor (run #${run.id}). This takes a few hours.`, 'ok');
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not start the check', 'error');
    }
  };

  return (
    <Card
      title="Everything we sell"
      subtitle="Today's Google feeds from the FTP location — the products live on our sites, with their prices"
      actions={
        <>
          <button type="button" className="btn btn--primary" disabled={collecting} onClick={() => void collect()}>
            {collecting ? 'Collecting…' : "Collect today's feeds"}
          </button>
          <button type="button" className="btn" onClick={() => void checkAll()}>
            Check every product now
          </button>
        </>
      }
    >
      {error && error !== 'not-configured' && <Alert tone="danger">{error}</Alert>}
      {(error === 'not-configured' || (report && !report.configured)) && (
        <Alert tone="warn" title="The FTP location isn't set up yet">
          The app needs the FTP address, login and the name of each site's feed file before it can collect
          them. These are added once in Render, under the service's <strong>Environment</strong> settings:{' '}
          <span className="mono xs">
            FEED_FTP_HOST, FEED_FTP_USER, FEED_FTP_PASSWORD, FEED_FTP_PROTOCOL (sftp, ftps or ftp),
            FEED_FTP_DIRECTORY
          </span>{' '}
          and one file name per site —{' '}
          <span className="mono xs">FEED_FTP_PATTERN_197</span> (Goldsmiths),{' '}
          <span className="mono xs">FEED_FTP_PATTERN_439</span> (Mappin &amp; Webb),{' '}
          <span className="mono xs">FEED_FTP_PATTERN_470</span> (Watches of Switzerland) — where{' '}
          <span className="mono xs">*</span> stands for the part that changes daily, e.g.{' '}
          <span className="mono xs">goldsmiths_*.csv</span>.
        </Alert>
      )}
      {report?.configured && (
        <ul className="check-feeds">
          {report.outcomes.map((outcome) => (
            <li key={outcome.fasciaCode}>
              <strong>{SITE_NAMES[outcome.fasciaCode] ?? outcome.fasciaCode}</strong>{' '}
              <span
                className={`badge ${
                  outcome.status === 'imported'
                    ? 'badge--lower'
                    : outcome.status === 'unchanged'
                      ? 'badge--neutral'
                      : 'badge--warn'
                }`}
              >
                {outcome.status === 'imported'
                  ? 'imported'
                  : outcome.status === 'unchanged'
                    ? 'already up to date'
                    : outcome.status === 'missing'
                      ? 'no file found'
                      : 'failed'}
              </span>{' '}
              <span className="small muted">{outcome.message}</span>
            </li>
          ))}
        </ul>
      )}
      {!report && !error && (
        <p className="small muted" style={{ margin: 0 }}>
          This also happens every night on its own, followed by a check of every product, when the nightly job is
          switched on in Admin. Use the buttons to do it now.
        </p>
      )}
    </Card>
  );
}

/* ---------- Recently checked ---------------------------------------------------- */

function RecentCard({
  recent,
  onOpen,
}: {
  recent: RecentLookup[];
  onOpen: (params: Record<string, string>) => void;
}) {
  const [batches, setBatches] = useState<RecentBatch[]>([]);
  useEffect(() => {
    api
      .recentBatches()
      .then((response) => setBatches(response.batches))
      .catch(() => undefined);
  }, []);

  if (recent.length === 0 && batches.length === 0) return null;

  return (
    <Card title="Recently checked" bodyless>
      <div className="table-wrap">
        <table className="table">
          <tbody>
            {batches.map((row) => (
              <tr key={`list-${row.id}`} className="table__row--clickable" onClick={() => onOpen({ list: String(row.id) })}>
                <td>
                  <div className="cell-primary">{row.fileName ?? `List #${row.id}`}</div>
                  <div className="cell-secondary xs">List of {row.total.toLocaleString('en-GB')}</div>
                </td>
                <td className="num">
                  <span className="badge badge--neutral">{row.products.toLocaleString('en-GB')} products</span>
                </td>
                <td className="num muted">{relativeTime(row.createdAt)}</td>
              </tr>
            ))}
            {recent.map((row) => (
              <tr key={row.productId} className="table__row--clickable" onClick={() => onOpen({ product: String(row.productId) })}>
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
