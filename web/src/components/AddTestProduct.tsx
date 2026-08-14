import { useEffect, useState } from 'react';
import { api, ApiError, type Fascia } from '../api';
import { Alert, Card, useToast } from './ui';

/**
 * Add one product by hand, then scan it.
 *
 * Products normally arrive in a Google feed, which is fine for the catalogue
 * but useless for testing: to prove the chain works you want a specific product
 * you already know a competitor lists, now, without waiting on a feed export.
 *
 * A product added here is marked manual, so a later feed import does not delist
 * it for being absent from the file. It stays until you delete it.
 */
export function AddTestProductCard({ onAdded }: { onAdded: () => void | Promise<void> }) {
  const toast = useToast();
  const [fascias, setFascias] = useState<Fascia[]>([]);
  const [busy, setBusy] = useState(false);
  const [scanAfter, setScanAfter] = useState(true);

  const [form, setForm] = useState({
    internalSku: '',
    brand: '',
    productName: '',
    eanMpn: '',
    referenceNumber: '',
    price: '',
    fascia: '',
  });

  useEffect(() => {
    void api
      .fascias()
      .then((response) => {
        setFascias(response.fascias);
        setForm((current) =>
          current.fascia ? current : { ...current, fascia: response.fascias[0]?.code ?? '' },
        );
      })
      .catch(() => undefined);
  }, []);

  const set = (key: keyof typeof form) => (value: string) =>
    setForm((current) => ({ ...current, [key]: value }));

  const ready =
    form.internalSku.trim() !== '' && form.brand.trim() !== '' && form.productName.trim() !== '';

  const submit = async () => {
    setBusy(true);
    try {
      const created = await api.addProduct(form);
      toast(`Added ${created.internalSku}.`, 'ok');

      if (scanAfter) {
        const { run } = await api.startRun({ mode: 'both', productId: created.productId });
        toast(`Run #${run.id} started for ${created.internalSku}.`, 'ok');
      }

      setForm((current) => ({
        ...current,
        internalSku: '',
        productName: '',
        eanMpn: '',
        referenceNumber: '',
        price: '',
      }));
      await onAdded();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not add that product', 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card
      title="Add a test product"
      subtitle="One product you already know a competitor lists — the quickest way to prove the chain works end to end"
    >
      <div className="filter-bar">
        <Field label="SKU" id="tp-sku" value={form.internalSku} onChange={set('internalSku')} placeholder="e.g. 37538618" />
        <Field label="Brand" id="tp-brand" value={form.brand} onChange={set('brand')} placeholder="e.g. TAG Heuer" />
        <Field
          label="Product name"
          id="tp-name"
          value={form.productName}
          onChange={set('productName')}
          placeholder="e.g. Carrera Day-Date 41mm"
          grow
        />
      </div>

      <div className="filter-bar" style={{ marginTop: 'var(--sp-3)' }}>
        <Field
          label="EAN / barcode"
          id="tp-ean"
          value={form.eanMpn}
          onChange={set('eanMpn')}
          placeholder="Strongest match signal"
        />
        <Field
          label="Manufacturer ref"
          id="tp-ref"
          value={form.referenceNumber}
          onChange={set('referenceNumber')}
          placeholder="e.g. WBN2010.BA0640"
        />
        <div className="field">
          <label className="label" htmlFor="tp-price">
            Our price
          </label>
          <input
            id="tp-price"
            className="input"
            type="number"
            min={0}
            step="0.01"
            value={form.price}
            onChange={(event) => set('price')(event.target.value)}
            style={{ width: 130 }}
          />
        </div>
        <div className="field">
          <label className="label" htmlFor="tp-fascia">
            At which site
          </label>
          <select
            id="tp-fascia"
            className="select"
            value={form.fascia}
            onChange={(event) => set('fascia')(event.target.value)}
          >
            {fascias.map((fascia) => (
              <option key={fascia.code} value={fascia.code}>
                {fascia.name}
              </option>
            ))}
          </select>
        </div>
        <button type="button" className="btn btn--primary" onClick={() => void submit()} disabled={busy || !ready}>
          {busy && <span className="spinner" />}
          {busy ? 'Adding…' : 'Add product'}
        </button>
      </div>

      <label className="row small" style={{ marginTop: 'var(--sp-4)', gap: 8, cursor: 'pointer' }}>
        <input type="checkbox" checked={scanAfter} onChange={(event) => setScanAfter(event.target.checked)} />
        Scan it immediately against every enabled competitor
      </label>

      <div style={{ marginTop: 'var(--sp-4)' }}>
        <Alert tone="info" title="Give it a barcode if you can">
          An EAN is the strongest signal we have — a competitor publishing the same barcode is
          matched automatically and with certainty. Without one, matching falls back to brand, name
          and specifications, which usually needs a human glance in Match review.
        </Alert>
      </div>

      <p className="small muted" style={{ marginTop: 'var(--sp-3)', marginBottom: 0 }}>
        A product added here is kept when you next import a feed, even though the feed will not
        mention it. Delete it from Price comparison when you are finished with it.
      </p>
    </Card>
  );
}

function Field({
  label,
  id,
  value,
  onChange,
  placeholder,
  grow,
}: {
  label: string;
  id: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  grow?: boolean;
}) {
  return (
    <div className={`field${grow ? ' field--grow' : ''}`}>
      <label className="label" htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        className="input"
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}
