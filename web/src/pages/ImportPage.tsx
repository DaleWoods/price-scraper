import { useRef, useState, type DragEvent } from 'react';
import { api, ApiError, type ImportResult, type PriceImportResult } from '../api';
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

      <Card title="Upload export" subtitle="CSV or Excel (.xlsx), up to 25 MB">
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
            accept=".csv,.xlsx,.xlsm,.xltx"
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

      <PriceImportCard />

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
 * Prices arrive as their own file keyed on SKU, on a different cadence from the
 * content export. This only ever updates existing products — a price for a SKU
 * that is not in the catalogue is reported rather than turned into a phantom
 * product with no brand or name.
 */
function PriceImportCard() {
  const toast = useToast();
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<PriceImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);

  const upload = async (selected: File) => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const response = await api.importPrices(selected);
      setResult(response);
      toast(`Priced ${response.updated} product(s).`, 'ok');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Price import failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Card title="Load prices" subtitle="A separate file, joined to the catalogue on SKU">
        <div
          onDragOver={(event) => {
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => {
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
          <div style={{ fontSize: 34, marginBottom: 'var(--sp-2)' }}>💷</div>
          <div style={{ fontWeight: 620, color: 'var(--text-strong)' }}>
            {file ? file.name : 'Drop your price file here'}
          </div>
          <div className="small muted" style={{ marginTop: 4 }}>
            or click to choose a file
          </div>
          <input
            ref={inputRef}
            type="file"
            accept=".csv,.xlsx,.xlsm,.xltx"
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
            <span className="spinner" /> Applying prices…
          </div>
        )}

        <p className="small muted" style={{ marginTop: 'var(--sp-4)' }}>
          Needs a <strong>SKU</strong> column and a <strong>price</strong> column; currency is
          optional and defaults to what the product already carries. Header names are flexible —
          SKU / Product Code / Item Code, and Price / Our Price / Retail Price / RRP are all
          recognised. Only existing products are updated; unknown SKUs are listed back to you rather
          than created.
        </p>
      </Card>

      {error && (
        <Alert tone="danger" title="Price import failed">
          {error}
        </Alert>
      )}

      {result && (
        <>
          <div className="stat-grid">
            <Stat label="Rows read" value={result.totalRows} tone="accent" icon="◆" />
            <Stat label="Priced" value={result.updated} tone="lower" icon="£" />
            <Stat
              label="Unknown SKUs"
              value={result.unknownSkuCount}
              tone={result.unknownSkuCount > 0 ? 'higher' : 'equal'}
              icon={result.unknownSkuCount > 0 ? '▲' : '✓'}
              meta={result.unknownSkuCount > 0 ? 'Not in the catalogue' : 'All matched'}
            />
            <Stat
              label="Still awaiting"
              value={result.stillAwaitingPrice}
              tone="info"
              icon="⏳"
              meta="Products with no price"
            />
          </div>

          <Card title="How your columns were read">
            <div className="spec-grid">
              <div className="spec">
                <div className="spec__key">sku</div>
                <div className="spec__value">{result.columnMapping.sku}</div>
              </div>
              <div className="spec">
                <div className="spec__key">price</div>
                <div className="spec__value">{result.columnMapping.price}</div>
              </div>
              <div className="spec">
                <div className="spec__key">currency</div>
                <div className="spec__value">{result.columnMapping.currency ?? 'not supplied'}</div>
              </div>
            </div>
          </Card>

          {result.unknownSkuCount > 0 && (
            <Alert tone="warn" title={`${result.unknownSkuCount} SKU(s) are not in the catalogue`}>
              These were priced but no matching product exists — import the catalogue export first,
              or check the SKUs match.{' '}
              <span className="mono">{result.unknownSkus.slice(0, 12).join(', ')}</span>
              {result.unknownSkuCount > 12 ? ' …' : ''}
            </Alert>
          )}

          {result.errors.length > 0 && (
            <Card title="Rows that failed" subtitle="Fix these and re-upload" bodyless>
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
                      <tr key={`${row.row}-${row.sku ?? ""}`}>
                        <td className="num mono">{row.row}</td>
                        <td className="mono">{row.sku ?? "—"}</td>
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
