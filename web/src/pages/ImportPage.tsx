import { useRef, useState, type DragEvent } from 'react';
import {
  api,
  ApiError,
  type ImportResult,
  type LoadsheetImportResult,
  type PriceImportResult,
} from '../api';
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

      <LoadsheetImportCard />

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

/**
 * The SAP price loadsheet: one row per condition record, many rows per product.
 *
 * Unlike the simple SKU+price file, this needs no pre-filtering — the rules for
 * which row wins (store-specific over sales-org-wide, sale over regular when it
 * is genuinely cheaper) are applied here rather than in a spreadsheet, so they
 * are consistent and can be checked against the Pricing documentation.
 */
function LoadsheetImportCard() {
  const toast = useToast();
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<LoadsheetImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);

  const upload = async (selected: File) => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const response = await api.importLoadsheet(selected);
      setResult(response);
      toast(`Priced ${response.productsPriced} product(s) across ${response.fascias.length} fascias.`, 'ok');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Loadsheet import failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Card title="Load SAP price loadsheet" subtitle="One selling price per UK fascia, worked out here">
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
          <div style={{ fontSize: 34, marginBottom: 'var(--sp-2)' }}>🏷️</div>
          <div style={{ fontWeight: 620, color: 'var(--text-strong)' }}>
            {file ? file.name : 'Drop the price loadsheet here'}
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
            <span className="spinner" /> Working out prices…
          </div>
        )}

        <p className="small muted" style={{ marginTop: 'var(--sp-4)' }}>
          Send it <strong>unfiltered</strong> — rows for other sales organisations and other stores
          are discarded here, and the sales-org-wide rows are needed as the fallback price. Prices
          are taken as gross (VAT inclusive), so they compare directly with competitor site prices.
        </p>
      </Card>

      {error && (
        <Alert tone="danger" title="Loadsheet import failed">
          {error}
        </Alert>
      )}

      {result && (
        <>
          <div className="stat-grid">
            <Stat label="Rows read" value={result.totalRows} tone="accent" icon="◆" />
            <Stat
              label="Rows used"
              value={result.rowsConsidered}
              tone="info"
              icon="✓"
              meta={`${result.rowsNotOurs} for other orgs or stores`}
            />
            <Stat label="Products priced" value={result.productsPriced} tone="lower" icon="£" />
            <Stat
              label="Still unpriced"
              value={result.productsWithoutAnyPrice}
              tone={result.productsWithoutAnyPrice > 0 ? 'higher' : 'equal'}
              icon={result.productsWithoutAnyPrice > 0 ? '▲' : '✓'}
              meta="No price at any fascia"
            />
          </div>

          <Card title="What was left out" subtitle="Every row is accounted for">
            <div className="spec-grid">
              <div className="spec">
                <div className="spec__key">Other org, channel or store</div>
                <div className="spec__value">{result.rowsNotOurs}</div>
              </div>
              <div className="spec">
                <div className="spec__key">Net (ex-VAT) rows</div>
                <div className="spec__value">{result.rowsNet}</div>
              </div>
              {result.rowsByIgnoredKschl.map((entry) => (
                <div className="spec" key={entry.kschl}>
                  <div className="spec__key">Condition type {entry.kschl}</div>
                  <div className="spec__value">{entry.rows}</div>
                </div>
              ))}
            </div>
            <p className="small muted" style={{ marginBottom: 0, marginTop: 'var(--sp-3)' }}>
              Prices come from <strong>VKP0</strong> (UK RRP) and <strong>VKA0</strong> (UK sale)
              only. <strong>VKP1</strong> is the net twin of VKP0 and is excluded — treating it as a
              second regular price would put an ex-VAT figure into a gross comparison.
            </p>
          </Card>

          <Card title="Per fascia" subtitle="How many products each of our sites now has a price for">
            <div className="spec-grid">
              {result.fascias.map((fascia) => (
                <div className="spec" key={fascia.code}>
                  <div className="spec__key">
                    {fascia.name} ({fascia.code})
                  </div>
                  <div className="spec__value">
                    {fascia.priced} priced
                    {fascia.missing > 0 ? `, ${fascia.missing} without` : ''}
                  </div>
                </div>
              ))}
            </div>
          </Card>

          {result.warnings.noValidityDates > 0 && (
            <Alert tone="warn" title={`${result.warnings.noValidityDates} price(s) had no usable validity dates`}>
              The start/end columns held a time such as <span className="mono">00:00.0</span> rather
              than a date — usually Excel formatting a datetime as a time on export. These prices
              were imported anyway, but an expired price cannot be told from a live one until the
              export carries real dates.
            </Alert>
          )}

          {result.warnings.precedenceAmbiguous.length > 0 && (
            <Alert
              tone="warn"
              title={`${result.warnings.precedenceAmbiguous.length} price(s) worth checking against the live site`}
            >
              These have a sales-organisation-wide sale price but a fascia-specific regular price.
              The sale was applied, but the Pricing documentation notes the live site may return the
              regular price instead in this case.{' '}
              <span className="mono">
                {result.warnings.precedenceAmbiguous
                  .slice(0, 8)
                  .map((entry) => `${entry.sku} (${entry.fascia})`)
                  .join(', ')}
              </span>
            </Alert>
          )}

          {result.warnings.saleNotCheaper.length > 0 && (
            <Alert
              tone="info"
              title={`${result.warnings.saleNotCheaper.length} "sale" price(s) were not actually cheaper`}
            >
              A VKA0 sale row was priced at or above the regular price, so the regular price was
              used — that is what a customer would pay.{' '}
              <span className="mono">
                {result.warnings.saleNotCheaper
                  .slice(0, 8)
                  .map((entry) => `${entry.sku} (${entry.fascia})`)
                  .join(', ')}
              </span>
            </Alert>
          )}

          {result.unknownSkuCount > 0 && (
            <Alert tone="warn" title={`${result.unknownSkuCount} SKU(s) are not in the catalogue`}>
              Priced in the loadsheet but no matching product — import the catalogue first, or check
              these are products we list.{' '}
              <span className="mono">{result.unknownSkus.slice(0, 12).join(', ')}</span>
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
                      <tr key={`${row.row}-${row.code ?? ""}`}>
                        <td className="num mono">{row.row}</td>
                        <td className="mono">{row.code ?? "—"}</td>
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
