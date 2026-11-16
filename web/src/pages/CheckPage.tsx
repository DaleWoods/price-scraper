import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  api,
  ApiError,
  formatMoney,
  relativeTime,
  type BatchResult,
  type FeedIngestReport,
  type FeedJob,
  type FeedProgressItem,
  type LookupCompetitor,
  type LookupResult,
  type RecentBatch,
  type RecentLookup,
} from '../api';
import { CompetitorLabel, CompetitorLogo } from '../components/CompetitorLogo';
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
      <section className="hero">
        <div className="hero__text">
          <h2 className="hero__title">Is anyone selling it for less?</h2>
          <p className="hero__lead">
            Paste a product link from Goldsmiths, Mappin &amp; Webb or Watches of Switzerland — or a SKU, manufacturer
            reference or barcode. We'll find the exact same product at every competitor.
          </p>
        </div>
        <form className="check-form hero__form" onSubmit={submit}>
            <input
              className="input check-form__input"
              value={input}
              onChange={(event) => setInput(event.target.value)}
              placeholder="e.g. 17331581, O21030422004001, or https://www.goldsmiths.co.uk/…"
              aria-label="Product to check"
              autoFocus
            />
            <button type="submit" className="btn btn--primary btn--lg" disabled={submitting || !input.trim()}>
              {submitting ? 'Starting…' : 'Check prices'}
            </button>
        </form>
        <p className="hero__note xs">
          Exact matches only — the same barcode or the same manufacturer reference. Anything less certain is left out.
        </p>
      </section>

      {error && (
        <Alert tone="warn" title="Couldn't check that">
          {error}
        </Alert>
      )}

      {result && <ResultCard result={result} onRecheck={() => void check(result.product.sku)} />}

      {batchId && <BatchCard batchId={batchId} />}

      {!result && !productId && !batchId && <RecentCard recent={recent} onOpen={setParams} />}

      <div className="check-grid">
        <ListCard onStarted={(id) => setParams({ list: String(id) })} />
        <FeedsCard />
      </div>
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
  const [filter, setFilter] = useState<'all' | 'dearer' | 'cheapest' | 'none'>('all');
  const [sortByGap, setSortByGap] = useState(false);

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

  const competitors =
    batch.products[0]?.competitors.map((c) => ({ slug: c.slug, name: c.name, hasLogo: c.hasLogo })) ?? [];
  // The biggest saving a competitor offers on each product: negative when
  // someone is cheaper than us, as a share of our price.
  const worstGap = (product: LookupResult): number | null => {
    const ours = product.product.price;
    const prices = product.competitors.filter((c) => c.status === 'found' && c.price != null).map((c) => c.price!);
    if (ours == null || ours <= 0 || prices.length === 0) return null;
    return (Math.min(...prices) - ours) / ours;
  };
  const isDearer = (product: LookupResult) => (worstGap(product) ?? 0) < -0.00001;
  const isFound = (product: LookupResult) => product.competitors.some((c) => c.status === 'found');
  const cheaperSomewhere = batch.products.filter(isDearer).length;
  const foundSomewhere = batch.products.filter(isFound).length;
  const weAreCheapest = batch.products.filter((product) => isFound(product) && !isDearer(product)).length;
  const notFound = batch.products.length - foundSomewhere;

  let shown = batch.products.filter((product) =>
    filter === 'dearer'
      ? isDearer(product)
      : filter === 'cheapest'
        ? isFound(product) && !isDearer(product)
        : filter === 'none'
          ? !isFound(product)
          : true,
  );
  if (sortByGap) shown = [...shown].sort((a, b) => (worstGap(a) ?? Infinity) - (worstGap(b) ?? Infinity));
  const done = batch.status === 'done';

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
          <span className="muted">Checked {relativeTime(batch.createdAt)}</span>
        )}
        <span className="grow" />
        {batch.products.length > 0 && (
          <button type="button" className="btn btn--sm" onClick={download}>
            Download CSV
          </button>
        )}
      </div>

      {batch.products.length > 0 && (
        <div className="tallies">
          {(
            [
              ['all', 'Products checked', batch.products.length, ''],
              ['dearer', 'Cheaper elsewhere', cheaperSomewhere, 'higher'],
              ['cheapest', 'We are cheapest or level', weAreCheapest, 'lower'],
              ['none', 'Not found at any competitor', notFound, ''],
            ] as const
          ).map(([key, label, count, tone]) => (
            <button
              key={key}
              type="button"
              className={`tally${filter === key ? ' tally--active' : ''}${tone ? ` tally--${tone}` : ''}`}
              onClick={() => setFilter(key)}
              aria-pressed={filter === key}
            >
              <span className="tally__value">{count.toLocaleString('en-GB')}</span>
              <span className="tally__label">{label}</span>
            </button>
          ))}
        </div>
      )}

      {batch.unresolved.length > 0 && (
        <div style={{ padding: 'var(--sp-4) var(--sp-6) 0' }}>
          <Alert tone="warn" title={`${batch.unresolved.length} couldn't be found on our sites`}>
            <span className="mono xs">{batch.unresolved.slice(0, 40).join(', ')}</span>
            {batch.unresolved.length > 40 && <> and {batch.unresolved.length - 40} more</>}
          </Alert>
        </div>
      )}

      {batch.products.length > 0 && (
        <div className="list-tools">
          <span className="small muted">
            Showing {shown.length.toLocaleString('en-GB')} of {batch.products.length.toLocaleString('en-GB')}
            {!done && ' — prices appear as they arrive'}
          </span>
          <span className="grow" />
          <label className="small list-tools__toggle">
            <input type="checkbox" checked={sortByGap} onChange={(event) => setSortByGap(event.target.checked)} /> Biggest
            gap first
          </label>
        </div>
      )}

      {batch.products.length > 0 && (
        <div className="table-wrap">
          <table className="table table--list">
            <thead>
              <tr>
                <th>Product</th>
                <th className="num">Our price</th>
                {competitors.map((c) => (
                  <th key={c.slug} className="num">
                    <span className="th-competitor">
                      <CompetitorLogo slug={c.slug} displayName={c.name} hasLogo={c.hasLogo} size="sm" />
                      {c.name}
                    </span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {shown.map((product) => (
                <tr key={product.product.id}>
                  <td>
                    <div className="list-product">
                      {product.product.imageUrl ? (
                        <img className="thumb" src={product.product.imageUrl} alt="" loading="lazy" />
                      ) : (
                        <span className="thumb thumb--empty" aria-hidden>
                          ◇
                        </span>
                      )}
                      <div>
                        <div className="xs list-product__brand">{product.product.brand}</div>
                        <a className="cell-primary" href={`/check?product=${product.product.id}`}>
                          {product.product.name}
                        </a>
                        <div className="cell-secondary mono xs">{product.product.sku}</div>
                      </div>
                    </div>
                  </td>
                  <td className="num">
                    <strong>{formatMoney(product.product.price)}</strong>
                  </td>
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
    <span className="price-cell">
      <a className={`price price--link ${tone}`} href={entry.url ?? undefined} target="_blank" rel="noreferrer">
        {formatMoney(entry.price)} ↗
      </a>
      <GapPill price={entry.price} ours={ours} compact />
    </span>
  );
}

/* ---------- Everything we sell: the Google feeds --------------------------------- */

const SITE_NAMES: Record<string, string> = {
  '197': 'Goldsmiths',
  '439': 'Mappin & Webb',
  '470': 'Watches of Switzerland',
};

/** Downloading counts for a quarter of each file's share of the bar, importing the rest. */
function itemFraction(item: FeedProgressItem): number {
  switch (item.stage) {
    case 'done':
    case 'skipped':
    case 'failed':
      return 1;
    case 'waiting':
      return 0;
    default: {
      const downloaded = item.totalBytes > 0 ? Math.min(1, item.downloadedBytes / item.totalBytes) : 0;
      return 0.25 * downloaded + 0.75 * Math.min(1, item.importFraction);
    }
  }
}

function overallFraction(items: FeedProgressItem[]): number {
  if (items.length === 0) return 0;
  // Weighted by file size: the 388 MB Goldsmiths feed is most of the work.
  const weight = (item: FeedProgressItem) => Math.max(item.totalBytes, 1);
  const total = items.reduce((sum, item) => sum + weight(item), 0);
  return items.reduce((sum, item) => sum + weight(item) * itemFraction(item), 0) / total;
}

const megabytes = (bytes: number) => `${Math.round(bytes / 1_000_000)} MB`;

function describeStage(item: FeedProgressItem): string {
  switch (item.stage) {
    case 'waiting':
      return 'Waiting';
    case 'downloading':
      return `Downloading — ${megabytes(item.downloadedBytes)} of ${megabytes(item.totalBytes)}`;
    case 'downloaded':
      return 'Downloaded, waiting to import';
    case 'importing':
      return `Importing — ${Math.round(item.importFraction * 100)}%, ${item.rowsRead.toLocaleString()} products read`;
    case 'done':
      return `Done — ${item.rowsRead.toLocaleString()} products`;
    case 'skipped':
      return 'Already up to date';
    case 'failed':
      return 'Failed';
  }
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.max(1, Math.round(seconds))} sec`;
  const minutes = Math.round(seconds / 60);
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} hr ${minutes % 60} min`;
}

function FeedProgress({ job }: { job: FeedJob }) {
  const items = job.progress ?? [];
  const fraction = overallFraction(items);
  const elapsed = job.startedAt ? (Date.now() - new Date(job.startedAt).getTime()) / 1000 : 0;
  // A time left is only worth showing once there is enough done to judge by.
  const remaining = fraction > 0.03 && elapsed > 20 ? (elapsed / fraction) * (1 - fraction) : null;

  return (
    <div className="feed-progress" role="status" aria-live="polite">
      <div className="feed-progress__head">
        <strong>{items.length === 0 ? 'Connecting to the FTP server…' : `${Math.round(fraction * 100)}% done`}</strong>
        <span className="small muted">
          {formatDuration(elapsed)} so far
          {remaining !== null && ` · about ${formatDuration(remaining)} left`}
        </span>
      </div>
      <div className="feed-progress__bar feed-progress__bar--main">
        <span style={{ width: `${fraction * 100}%` }} />
      </div>
      {items.length > 0 && (
        <ul className="feed-progress__sites">
          {items.map((item) => (
            <li key={item.fasciaCode}>
              <span className="feed-progress__site">{SITE_NAMES[item.fasciaCode] ?? item.fasciaCode}</span>
              <div className="feed-progress__bar">
                <span style={{ width: `${itemFraction(item) * 100}%` }} />
              </div>
              <span className="small muted">{describeStage(item)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function FeedsCard() {
  const toast = useToast();
  const [collecting, setCollecting] = useState(false);
  const [report, setReport] = useState<FeedIngestReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [job, setJob] = useState<FeedJob | null>(null);

  const collect = async (resume = false) => {
    setCollecting(true);
    setError(null);
    setReport(null);
    try {
      setReport(await api.fetchFeeds(false, setJob, { resume }));
    } catch (err) {
      const message = err instanceof ApiError ? err.message : 'Could not collect the feeds';
      // Not set up yet is a setting to add, not a failure; say which.
      setError(/no feed location is configured/i.test(message) ? 'not-configured' : message);
    } finally {
      setCollecting(false);
      setJob(null);
    }
  };

  // A collection already running (started before the page was opened or
  // reloaded) is picked up and followed, rather than looking idle.
  useEffect(() => {
    let cancelled = false;
    api
      .feedJob()
      .then((current) => {
        if (!cancelled && current.running) void collect(true);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

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
      {collecting && job && <FeedProgress job={job} />}
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
                  <div className="list-product">
                    <span className="thumb thumb--sm thumb--empty" aria-hidden>
                      ☰
                    </span>
                    <div>
                      <div className="cell-primary">{row.fileName ?? `List #${row.id}`}</div>
                      <div className="cell-secondary xs">List of {row.total.toLocaleString('en-GB')}</div>
                    </div>
                  </div>
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
                  <div className="list-product">
                    {row.imageUrl ? (
                      <img className="thumb thumb--sm" src={row.imageUrl} alt="" loading="lazy" />
                    ) : (
                      <span className="thumb thumb--sm thumb--empty" aria-hidden>
                        ◇
                      </span>
                    )}
                    <div>
                      <div className="cell-primary">
                        {row.brand} {row.name}
                      </div>
                      <div className="cell-secondary mono xs">{row.sku}</div>
                    </div>
                  </div>
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

/* ---------- One product's result ------------------------------------------------- */

/** How a competitor's price sits against ours: what the colour and words say. */
function gapOf(price: number | null, ours: number | null) {
  if (price == null || ours == null || ours <= 0) return null;
  const diff = Math.round((price - ours) * 100) / 100;
  const pct = (diff / ours) * 100;
  if (Math.abs(diff) < 0.01) return { tone: 'equal' as const, diff: 0, pct: 0, text: 'Same price as us' };
  return diff < 0
    ? { tone: 'higher' as const, diff, pct, text: `${formatMoney(-diff)} cheaper than us` }
    : { tone: 'lower' as const, diff, pct, text: `${formatMoney(diff)} dearer than us` };
}

const signedPct = (pct: number) => `${pct > 0 ? '+' : '−'}${Math.abs(pct).toFixed(1)}%`;

function GapPill({ price, ours, compact = false }: { price: number | null; ours: number | null; compact?: boolean }) {
  const gap = gapOf(price, ours);
  if (!gap) return null;
  if (gap.tone === 'equal') return <span className="gap gap--equal">{compact ? 'Same' : gap.text}</span>;
  return (
    <span className={`gap gap--${gap.tone}`}>
      {compact ? signedPct(gap.pct) : `${gap.text} · ${signedPct(gap.pct)}`}
    </span>
  );
}

function Verdict({ result }: { result: LookupResult }) {
  const ours = result.product.price;
  const found = result.competitors.filter((row) => row.status === 'found' && row.price != null);
  if (result.running && found.length === 0) {
    return (
      <div className="verdict verdict--neutral">
        <span className="spinner" /> Checking every competitor for this exact product…
      </div>
    );
  }
  if (found.length === 0) {
    return (
      <div className="verdict verdict--neutral">
        No competitor we can read sells this exact product — nothing to compare against.
      </div>
    );
  }
  if (ours == null) {
    return <div className="verdict verdict--neutral">Found at {found.length}, but our own price couldn't be read.</div>;
  }
  const cheaper = found.filter((row) => row.price! < ours - 0.005).sort((a, b) => a.price! - b.price!);
  const same = found.filter((row) => Math.abs(row.price! - ours) < 0.005);
  const of = `${found.length} competitor${found.length === 1 ? '' : 's'}`;

  if (cheaper.length > 0) {
    const best = cheaper[0]!;
    const gap = gapOf(best.price, ours)!;
    return (
      <div className="verdict verdict--higher">
        <span className="verdict__icon" aria-hidden>
          ↓
        </span>
        <div>
          <strong>
            {best.name} is {formatMoney(ours - best.price!)} cheaper than us ({signedPct(gap.pct)})
          </strong>
          <div className="small">
            {cheaper.length === 1
              ? `The only one of ${of} below our price.`
              : `${cheaper.length} of ${of} are below our price.`}
          </div>
        </div>
      </div>
    );
  }
  return (
    <div className={`verdict ${same.length > 0 ? 'verdict--equal' : 'verdict--lower'}`}>
      <span className="verdict__icon" aria-hidden>
        {same.length > 0 ? '=' : '✓'}
      </span>
      <div>
        <strong>{same.length > 0 ? 'Nobody is cheaper than us' : 'We are the cheapest'}</strong>
        <div className="small">
          {same.length > 0
            ? `${same.map((row) => row.name).join(', ')} match${same.length === 1 ? 'es' : ''} our price; checked against ${of}.`
            : `Every one of ${of} that sells it charges more.`}
        </div>
      </div>
    </div>
  );
}

/**
 * Every price found on one line, with ours marked: where we sit is seen at a
 * glance, before reading a single number.
 */
function PriceLadder({ result }: { result: LookupResult }) {
  const ours = result.product.price;
  const found = result.competitors.filter((row) => row.status === 'found' && row.price != null);
  if (ours == null || found.length === 0) return null;
  const prices = [ours, ...found.map((row) => row.price!)];
  const low = Math.min(...prices);
  const high = Math.max(...prices);
  const span = high - low;
  const at = (price: number) => (span === 0 ? 50 : 4 + ((price - low) / span) * 92);

  return (
    <div className="ladder" aria-label="Prices from lowest to highest">
      <div className="ladder__track">
        {found.map((row) => (
          <span
            key={row.slug}
            className={`ladder__dot ladder__dot--${gapOf(row.price, ours)?.tone ?? 'equal'}`}
            style={{ left: `${at(row.price!)}%` }}
            title={`${row.name}: ${formatMoney(row.price)}`}
          >
            <CompetitorLogo slug={row.slug} displayName={row.name} hasLogo={row.hasLogo} size="sm" />
          </span>
        ))}
        <span className="ladder__us" style={{ left: `${at(ours)}%` }} title={`Us: ${formatMoney(ours)}`}>
          Us
        </span>
      </div>
      <div className="ladder__ends xs muted">
        <span>Lowest {formatMoney(low)}</span>
        <span>Highest {formatMoney(high)}</span>
      </div>
    </div>
  );
}

function CompetitorTile({ row, ours }: { row: LookupCompetitor; ours: number | null }) {
  const tone = gapOf(row.price, ours)?.tone ?? 'equal';
  return (
    <article className={`ctile ctile--${tone}`}>
      <header className="ctile__head">
        <CompetitorLabel slug={row.slug} displayName={row.name} hasLogo={row.hasLogo} className="ctile__name" />
        {row.inStock === false ? (
          <span className="badge badge--neutral">Out of stock</span>
        ) : row.inStock ? (
          <span className="ctile__stock">In stock</span>
        ) : null}
      </header>
      <div className="ctile__price">
        {formatMoney(row.price)}
        {row.onSale && row.wasPrice != null && <span className="ctile__was">was {formatMoney(row.wasPrice)}</span>}
      </div>
      <GapPill price={row.price} ours={ours} />
      <div className="ctile__meta xs muted">
        Same {row.matchedOn === 'reference' ? 'manufacturer reference' : 'barcode'}
        {row.seenAt && <> · seen {relativeTime(row.seenAt)}</>}
      </div>
      {row.url && (
        <a className="btn btn--sm ctile__link" href={row.url} target="_blank" rel="noreferrer">
          View at {row.name} ↗
        </a>
      )}
    </article>
  );
}

function ResultCard({ result, onRecheck }: { result: LookupResult; onRecheck: () => void }) {
  const { product } = result;
  const ours = product.price;

  const found = result.competitors
    .filter((row) => row.status === 'found' && row.price != null)
    .sort((a, b) => a.price! - b.price!);
  const checking = result.competitors.filter((row) => row.status === 'checking');
  const notSold = result.competitors.filter((row) => row.status === 'not_found');
  const couldNot = result.competitors.filter(
    (row) => row.status === 'blocked' || row.status === 'error' || (row.status === 'found' && row.price == null),
  );
  const notChecked = result.competitors.filter((row) => row.status === 'not_checked');

  return (
    <Card bodyless>
      <div className="result">
        <div className="result__media">
          {product.imageUrl ? (
            <img className="result__image" src={product.imageUrl} alt={product.name} />
          ) : (
            <div className="result__image result__image--empty" aria-hidden>
              ◇
            </div>
          )}
        </div>
        <div className="result__info">
          <div className="result__brand">{product.brand}</div>
          <h2 className="result__name">{product.name}</h2>
          <div className="result__ids">
            <span className="chip">SKU {product.sku}</span>
            {product.mpn && <span className="chip">Ref {product.mpn}</span>}
            {product.gtin && <span className="chip">Barcode {product.gtin}</span>}
          </div>
          <div className="result__ours">
            <div>
              <div className="xs muted">Our price{product.siteName ? ` at ${product.siteName}` : ''}</div>
              <div className="result__amount">{formatMoney(ours)}</div>
              {product.wasPrice != null && product.wasPrice !== ours && (
                <div className="xs muted">was {formatMoney(product.wasPrice)}</div>
              )}
            </div>
            {product.url && (
              <a className="btn btn--sm" href={product.url} target="_blank" rel="noreferrer">
                View on {product.siteName ?? 'our site'} ↗
              </a>
            )}
          </div>
        </div>
      </div>

      <div className="result__body">
        <Verdict result={result} />
        <PriceLadder result={result} />

        {(found.length > 0 || checking.length > 0) && (
          <div className="ctiles">
            {found.map((row) => (
              <CompetitorTile key={row.slug} row={row} ours={ours} />
            ))}
            {checking.map((row) => (
              <article key={row.slug} className="ctile ctile--pending">
                <header className="ctile__head">
                  <CompetitorLabel slug={row.slug} displayName={row.name} hasLogo={row.hasLogo} className="ctile__name" />
                </header>
                <div className="small muted">
                  <span className="spinner" /> Checking…
                </div>
              </article>
            ))}
          </div>
        )}

        <div className="result__foot">
          <div className="result__elsewhere small">
            {notSold.length > 0 && (
              <span>
                <span className="muted">Not sold at </span>
                {notSold.map((row) => row.name).join(', ')}
              </span>
            )}
            {couldNot.length > 0 && (
              <span>
                <span className="muted">Couldn't check </span>
                {couldNot.map((row) => row.name).join(', ')}
              </span>
            )}
            {notChecked.length > 0 && (
              <span>
                <span className="muted">Not checked yet </span>
                {notChecked.map((row) => row.name).join(', ')}
              </span>
            )}
          </div>
          {!result.running && (
            <div className="result__again">
              <span className="xs muted">Checked {relativeTime(result.checkedAt)}</span>
              <button type="button" className="btn btn--sm" onClick={onRecheck}>
                Check again
              </button>
            </div>
          )}
        </div>
        {result.competitors.length === 0 && (
          <EmptyState title="No competitors switched on" body="Turn some on in Admin → Competitors." />
        )}
      </div>
    </Card>
  );
}
