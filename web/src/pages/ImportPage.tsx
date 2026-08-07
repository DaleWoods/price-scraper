import { useRef, useState, type DragEvent } from 'react';
import { api, ApiError, type ImportResult } from '../api';
import { Alert, Card, Stat, useToast } from '../components/ui';

const REQUIRED_COLUMNS = ['internal_sku', 'brand', 'product_name', 'our_price'];
const OPTIONAL_COLUMNS = ['ean_mpn', 'currency', 'category', 'our_product_url'];

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
        SKUs are updated rather than duplicated.
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
          style={{
            border: `2px dashed ${dragging ? 'var(--brass-500)' : 'var(--border-strong)'}`,
            background: dragging ? 'var(--brass-100)' : 'var(--surface-sunken)',
            borderRadius: 'var(--radius)',
            padding: 'var(--sp-10)',
            textAlign: 'center',
            cursor: 'pointer',
            transition: 'all 160ms var(--ease)',
          }}
        >
          <div style={{ fontSize: 28, opacity: 0.5, marginBottom: 'var(--sp-3)' }}>↑</div>
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
        </div>
      </Card>

      {error && (
        <Alert tone="danger" title="Import failed">
          {error}
        </Alert>
      )}

      {result && (
        <>
          <div className="stat-grid">
            <Stat label="Rows read" value={result.totalRows} tone="accent" />
            <Stat label="Created" value={result.created} tone="lower" />
            <Stat label="Updated" value={result.updated} />
            <Stat
              label="Failed"
              value={result.failed}
              tone={result.failed > 0 ? 'higher' : undefined}
              meta={result.failed > 0 ? 'Listed below' : 'All rows valid'}
            />
          </div>

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
