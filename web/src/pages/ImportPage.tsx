import { useEffect, useRef, useState, type DragEvent } from 'react';
import { api, ApiError, type Fascia, type FeedImportResult, type ImportResult } from '../api';
import { Alert, Card, Stat, useToast } from '../components/ui';

const REQUIRED_COLUMNS = ['SKU', 'product name', 'brand (or a category column)'];
const OPTIONAL_COLUMNS = ['EAN / MPN', 'price', 'currency', 'categories', 'product URL'];

export function ImportPage() {
  const toast = useToast();
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const upload = async (selected: File) => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const response = await api.importCatalogue(selected);
      setResult(response);
      toast(`Imported ${response.created} new and ${response.updated} updated product(s).`, 'ok');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Import failed');
    } finally {
      setBusy(false);
    }
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    const dropped = event.dataTransfer.files?.[0];
    if (dropped) {
      setFile(dropped);
      void upload(dropped);
    }
  };

  return (
    <div className="page">
      <p className="page__intro">
        Upload the single master-catalogue export from SAP Commerce. There is no per-website split —
        one export covers Goldsmiths, Mappin &amp; Webb and Watches of Switzerland together. Existing
        SKUs are updated rather than duplicated, and prices already loaded are never overwritten by a
        content-only export.
      </p>

      <Card title="Upload export" subtitle="CSV or Excel (.xls / .xlsx), up to 25 MB">
        <div
          onDragOver={(event) => {
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          onClick={() => inputRef.current?.click()}
          className={`dropzone${dragging ? ' dropzone--active' : ''}`}
        >
          <div style={{ fontSize: 34, marginBottom: 'var(--sp-2)' }}>📥</div>
          <div style={{ fontWeight: 620, color: 'var(--text-strong)' }}>
            {file ? file.name : 'Drop your catalogue export here'}
          </div>
          <div className="small muted" style={{ marginTop: 4 }}>
            or click to choose a file
          </div>
          <input
            ref={inputRef}
            type="file"
            accept=".csv,.tsv,.txt,.xls,.xlsx,.xlsm,.xltx"
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
            <span className="spinner" /> Importing…
          </div>
        )}

        <div style={{ marginTop: 'var(--sp-5)' }} className="stack stack--tight">
          <div className="label">Required columns</div>
          <div className="row row--wrap" style={{ gap: 6 }}>
            {REQUIRED_COLUMNS.map((column) => (
              <span key={column} className="badge badge--info mono">
                {column}
              </span>
            ))}
          </div>
          <div className="label" style={{ marginTop: 'var(--sp-3)' }}>
            Optional columns
          </div>
          <div className="row row--wrap" style={{ gap: 6 }}>
            {OPTIONAL_COLUMNS.map((column) => (
              <span key={column} className="badge badge--neutral mono">
                {column}
              </span>
            ))}
          </div>
          <p className="small muted" style={{ marginTop: 'var(--sp-3)' }}>
            Every other column is imported as a <strong>spec attribute</strong> — dial colour, case
            size, metal type, carat weight and so on. The set is open, so you do not need to trim the
            export to a fixed list; the extra attributes are what make matching reliable when a
            competitor does not publish an EAN.
          </p>
          <p className="small muted" style={{ marginTop: 'var(--sp-2)' }}>
            The import adapts to a raw SAP loadsheet: the brand is derived from the category path when
            there is no brand column, a populated MPN wins over an empty EAN column, the page title is
            preferred over a collection name that repeats across variants, and size and metal are read
            out of the title. Site-configuration flags and marketing copy are skipped.
          </p>
          <p className="small muted" style={{ marginTop: 'var(--sp-2)' }}>
            <strong>Price is optional.</strong> The catalogue export carries product content; prices
            arrive as their own file keyed on SKU. Products without one import as fully matchable
            records and show as “no price yet” until a price file lands.
          </p>
        </div>
      </Card>

      {error && (
        <Alert tone="danger" title="Import failed">
          {error}
        </Alert>
      )}



      <FeedImportCard />

      {result && (
        <>
          <div className="stat-grid">
            <Stat label="Rows read" value={result.totalRows} tone="accent" icon="◆" />
            <Stat label="Created" value={result.created} tone="lower" icon="+" />
            <Stat label="Updated" value={result.updated} tone="teal" icon="↻" />
            <Stat
              label="Failed"
              value={result.failed}
              tone={result.failed > 0 ? 'higher' : 'equal'}
              icon={result.failed > 0 ? '▲' : '✓'}
              meta={result.failed > 0 ? 'Listed below' : 'All rows valid'}
            />
          </div>

          {!result.priceColumnFound && (
            <Alert tone="info" title="No price column in this file">
              {result.awaitingPrice} product(s) now have no price of ours. Matching, discovery and
              competitor scraping all work without it — the comparison shows “no price yet” until a
              price file keyed on SKU is loaded.
            </Alert>
          )}

          <Card title="How your columns were mapped" subtitle="What the importer decided, so nothing is a surprise">
            <div className="spec-grid">
              {Object.entries(result.columnMapping).map(([field, column]) => (
                <div className="spec" key={field}>
                  <div className="spec__key">{field.replace(/_/g, ' ')}</div>
                  <div className="spec__value">{column}</div>
                </div>
              ))}
            </div>
            {result.ignoredColumns.length > 0 && (
              <details style={{ marginTop: 'var(--sp-4)' }}>
                <summary className="small muted" style={{ cursor: 'pointer' }}>
                  {result.ignoredColumns.length} column(s) skipped — show why
                </summary>
                <ul className="small muted" style={{ marginTop: 'var(--sp-2)', paddingLeft: 'var(--sp-5)' }}>
                  {result.ignoredColumns.map((entry) => (
                    <li key={entry.column}>
                      <span className="mono">{entry.column}</span> — {entry.reason}
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </Card>

          {result.duplicateSkusCollapsed > 0 && (
            <Alert tone="warn" title="Duplicate SKUs in the file">
              {result.duplicateSkusCollapsed} row(s) repeated a SKU already present in this file. The
              last occurrence won.
            </Alert>
          )}

          {result.specColumnsDetected.length > 0 && (
            <Card title="Spec attributes detected" subtitle="Imported as extensible match attributes">
              <div className="row row--wrap" style={{ gap: 6 }}>
                {result.specColumnsDetected.map((column) => (
                  <span key={column} className="badge badge--promo mono">
                    {column}
                  </span>
                ))}
              </div>
            </Card>
          )}

          {result.errors.length > 0 && (
            <Card title="Rows that failed validation" subtitle="Fix these and re-upload" bodyless>
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th style={{ width: 90 }}>Row</th>
                      <th style={{ width: 180 }}>SKU</th>
                      <th>Problem</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.errors.map((row) => (
                      <tr key={`${row.row}-${row.internalSku ?? ''}`}>
                        <td className="num mono">{row.row}</td>
                        <td className="mono">{row.internalSku ?? '—'}</td>
                        <td className="small">{row.errors.join('; ')}</td>
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



/**
 * Google Shopping feed import — one feed per fascia, carrying both the product
 * content and the price that site actually shows.
 *
 * Replaces the catalogue price column and the SAP price loadsheet: these are the
 * prices live on the website, so no condition-record precedence has to be
 * reconstructed to arrive at them.
 */
function FeedImportCard() {
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
    <>
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
              label="Rows skipped"
              value={result.skippedBlank + result.skippedHeaderRepeat}
              tone="info"
              icon="⊘"
              meta="Blank padding and repeated headers"
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

          {result.priceHidden > 0 && (
            <Alert tone="info" title={`${result.priceHidden} product(s) have no visible price`}>
              Marked <span className="mono">price_visible=FALSE</span>, so no price is shown to
              customers and none was recorded — there is nothing to compare against.
            </Alert>
          )}

          <Card title="Stock position" subtitle="As stated by the feed">
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
    </>
  );
}
