import { useEffect, useRef, useState, type DragEvent } from 'react';
import { api, ApiError, type Fascia, type FeedImportResult } from '../api';
import { Alert, Card, Stat, useToast } from '../components/ui';

export function ImportPage() {
  const toast = useToast();
  const inputRef = useRef<HTMLInputElement>(null);
  const [fascias, setFascias] = useState<Fascia[]>([]);
  const [fasciaCode, setFasciaCode] = useState('');
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<FeedImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const response = await api.fascias();
        setFascias(response.fascias);
        setFasciaCode((current) => current || (response.fascias[0]?.code ?? ''));
      } catch {
        /* the selector stays empty; the upload attempt explains why */
      }
    })();
  }, []);

  const upload = async (selected: File) => {
    if (!fasciaCode) {
      setError('Choose which site this feed is for before uploading.');
      return;
    }
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const response = await api.importFeed(selected, fasciaCode);
      setResult(response);
      toast(
        `${response.fascia.name}: ${response.pricesWritten} price(s) from ` +
          `${response.productsCreated + response.productsUpdated} product(s).`,
        'ok',
      );
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Feed import failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page">
      <p className="page__intro">
        The Google feed each site sends is the single source for products and prices. Importing one
        replaces everything previously loaded for that site — the products in the file become
        exactly what we hold and scan for it.
      </p>

      <Card title="Import Google feed" subtitle="Products and prices together — one feed per site">
        <div className="filter-bar" style={{ marginBottom: 'var(--sp-4)' }}>
          <div className="field">
            <label className="label" htmlFor="feed-fascia">
              Which site is this feed for?
            </label>
            <select
              id="feed-fascia"
              className="select"
              value={fasciaCode}
              onChange={(event) => setFasciaCode(event.target.value)}
            >
              {fascias.length === 0 && <option value="">No sites configured</option>}
              {fascias.map((fascia) => (
                <option key={fascia.code} value={fascia.code}>
                  {fascia.name} ({fascia.code})
                  {fascia.priced > 0 ? ` — ${fascia.priced} priced` : ''}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div
          onDragOver={(event: DragEvent) => {
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event: DragEvent) => {
            event.preventDefault();
            setDragging(false);
            const dropped = event.dataTransfer.files?.[0];
            if (dropped) {
              setFile(dropped);
              void upload(dropped);
            }
          }}
          onClick={() => inputRef.current?.click()}
          className={`dropzone${dragging ? ' dropzone--active' : ''}`}
        >
          <div style={{ fontSize: 34, marginBottom: 'var(--sp-2)' }}>🛒</div>
          <div style={{ fontWeight: 620, color: 'var(--text-strong)' }}>
            {file ? file.name : 'Drop the Google feed here'}
          </div>
          <div className="small muted" style={{ marginTop: 4 }}>
            or click to choose a file
          </div>
          <input
            ref={inputRef}
            type="file"
            accept=".tsv,.csv,.txt,.xls,.xlsx"
            hidden
            onChange={(event) => {
              const selected = event.target.files?.[0];
              if (selected) {
                setFile(selected);
                void upload(selected);
              }
            }}
          />
        </div>

        {busy && (
          <div className="row muted" style={{ marginTop: 'var(--sp-4)' }}>
            <span className="spinner" /> Importing feed…
          </div>
        )}

        <p className="small muted" style={{ marginTop: 'var(--sp-4)' }}>
          Upload each site's feed separately — the price recorded is the one that site shows, so a
          product sold by more than one keeps a price per site. Where a{' '}
          <span className="mono">sale_price</span> is present and genuinely cheaper it becomes the
          price, with the regular price kept as the "was" figure.
        </p>
      </Card>

      {error && (
        <Alert tone="danger" title="Feed import failed">
          {error}
        </Alert>
      )}

      {result && (
        <>
          <div className="stat-grid">
            <Stat
              label="Products"
              value={result.productsCreated + result.productsUpdated}
              tone="accent"
              icon="◆"
              meta={`${result.productsCreated} new, ${result.productsUpdated} updated`}
            />
            <Stat
              label="Prices written"
              value={result.pricesWritten}
              tone="lower"
              icon="£"
              meta={`${result.fascia.name}${result.onSale > 0 ? ` · ${result.onSale} on sale` : ''}`}
            />
            <Stat
              label="Usable EAN / MPN"
              value={result.withUsableIdentifier}
              tone={result.damagedGtin + result.damagedMpn > 0 ? 'higher' : 'equal'}
              icon={result.damagedGtin + result.damagedMpn > 0 ? '▲' : '✓'}
              meta="Strongest matching key"
            />
            <Stat
              label="No longer listed"
              value={result.productsDelisted}
              tone={result.productsDelisted > 0 ? 'info' : 'equal'}
              icon={result.productsDelisted > 0 ? '⊘' : '✓'}
              meta={
                result.productsRelisted > 0
                  ? `${result.productsRelisted} came back`
                  : 'Absent from this feed'
              }
            />
          </div>

          {result.damagedGtin + result.damagedMpn > 0 && (
            <Alert
              tone="warn"
              title={`${result.damagedGtin + result.damagedMpn} identifier(s) were destroyed before upload`}
            >
              {result.damagedGtin} GTIN and {result.damagedMpn} MPN values arrived as scientific
              notation such as <span className="mono">7.32E+11</span> — what Excel does to long
              numbers. They were not stored: a mangled barcode cannot match a real one, and could
              collide with another mangled one. Exporting the feed without opening it in Excel would
              give us the strongest matching key available.
            </Alert>
          )}

          {(result.stalePricesRemoved > 0 || result.productsDelisted > 0) && (
            <Alert
              tone="info"
              title={`${result.fascia.name} now lists exactly the ${result.pricesWritten} product(s) in this file`}
            >
              {result.stalePricesRemoved} price(s) from an earlier {result.fascia.name} feed were
              removed, and {result.productsDelisted} product(s) are no longer listed by any site, so
              scans and the comparison will skip them. Nothing was deleted — their recorded price
              history is kept, and a later feed containing them puts them straight back.
            </Alert>
          )}

          {result.priceHidden > 0 && (
            <Alert tone="info" title={`${result.priceHidden} product(s) have no visible price`}>
              Marked <span className="mono">price_visible=FALSE</span>, so no price is shown to
              customers and none was recorded — there is nothing to compare against.
            </Alert>
          )}

          {result.outOfStock > 0 && (
            <Alert tone="info" title={`${result.outOfStock} product(s) are out of stock`}>
              No price was recorded for these, the same as a hidden price — only what is actually
              sellable is worth comparing. A product with no price anywhere is treated as
              discontinued: it drops out of scans and the comparison, though its recorded price
              history is kept, and it comes straight back if a later feed lists it in stock again.
            </Alert>
          )}

          <Card
            title="Stock position"
            subtitle="As stated by the feed — only 'in stock' rows get a price recorded"
          >
            <div className="spec-grid">
              {Object.entries(result.availability).map(([state, count]) => (
                <div className="spec" key={state}>
                  <div className="spec__key">{state}</div>
                  <div className="spec__value">{count}</div>
                </div>
              ))}
            </div>
          </Card>

          {result.errors.length > 0 && (
            <Card title="Rows that failed" subtitle="Fix these and re-upload" bodyless>
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th style={{ width: 90 }}>Row</th>
                      <th style={{ width: 180 }}>ID</th>
                      <th>Problem</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.errors.map((row) => (
                      <tr key={`${row.row}-${row.id ?? ''}`}>
                        <td className="num mono">{row.row}</td>
                        <td className="mono">{row.id ?? '—'}</td>
                        <td className="small">{row.error}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
