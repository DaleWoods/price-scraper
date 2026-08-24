import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { formatDateTime, relativeTime, type PricePosition } from '../api';

/* ---------- Price-position badge ----------------------------------------
   One visual language for price position, used in every table and panel:
   lower = we undercut them (good), higher = they undercut us (needs action).
   ------------------------------------------------------------------------ */

const POSITION_COPY: Record<PricePosition, string> = {
  lower: 'We are cheaper',
  equal: 'Level',
  higher: 'They are cheaper',
};

/** A glyph as well as a colour — position never depends on hue alone. */
const POSITION_GLYPH: Record<PricePosition, string> = {
  lower: '▼',
  equal: '=',
  higher: '▲',
};

export function PositionBadge({
  position,
  compact = false,
  reason = 'no-competitor-price',
}: {
  position: PricePosition | null;
  compact?: boolean;
  /** Why there is no position — two very different causes that must read differently. */
  reason?: 'no-competitor-price' | 'awaiting-our-price';
}) {
  if (!position) {
    return reason === 'awaiting-our-price' ? (
      <span className="badge badge--warn" title="Imported, but no price of ours has been loaded yet">
        <span className="badge__glyph" aria-hidden>
          ⏳
        </span>
        No price yet
      </span>
    ) : (
      <span className="badge badge--neutral" title="No competitor price recorded yet">
        Not matched
      </span>
    );
  }

  return (
    <span className={`badge badge--${position}`} title={POSITION_COPY[position]}>
      <span className="badge__glyph" aria-hidden>
        {POSITION_GLYPH[position]}
      </span>
      {compact ? position : POSITION_COPY[position]}
    </span>
  );
}

/* ---------- Price age -----------------------------------------------------
   There is no scheduler yet (Spec Phase 0) — a competitor's price is only as
   fresh as the last manual run, so it can sit untouched for weeks. A "they
   are cheaper" figure is only trustworthy if its age is visible alongside it,
   not just its value.
   ------------------------------------------------------------------------ */

/** A price younger than this reads as current — no colouring needed. */
const PRICE_AGE_AGEING_DAYS = 3;
/** A price this old or older is flagged outright rather than just tinted. */
const PRICE_AGE_STALE_DAYS = 14;

function priceAgeTone(observedAt: string): 'fresh' | 'ageing' | 'stale' {
  const days = (Date.now() - new Date(observedAt).getTime()) / 86_400_000;
  if (days >= PRICE_AGE_STALE_DAYS) return 'stale';
  if (days >= PRICE_AGE_AGEING_DAYS) return 'ageing';
  return 'fresh';
}

/** How long ago a competitor price was actually observed, coloured by age. */
export function PriceAge({ observedAt }: { observedAt: string | null }) {
  if (!observedAt) return <span className="muted">never</span>;
  const tone = priceAgeTone(observedAt);
  return (
    <span
      className={`price-age price-age--${tone}`}
      title={`Observed ${formatDateTime(observedAt)}${tone === 'stale' ? ' — this price may no longer be current' : ''}`}
    >
      {tone !== 'fresh' && <span className="price-age__dot" aria-hidden />}
      {relativeTime(observedAt)}
    </span>
  );
}

/**
 * A stable colour per brand so the eye can group rows without reading them.
 * Derived from the name rather than assigned by position, so filtering the table
 * never repaints a brand.
 */
const BRAND_HUES = [265, 200, 158, 32, 340, 12, 190, 95];

export function BrandChip({ brand }: { brand: string }) {
  let hash = 0;
  for (let i = 0; i < brand.length; i += 1) hash = (hash * 31 + brand.charCodeAt(i)) >>> 0;
  const hue = BRAND_HUES[hash % BRAND_HUES.length] ?? 265;

  return (
    <span className="brand-chip">
      <span className="brand-chip__dot" style={{ background: `hsl(${hue} 62% 52%)` }} aria-hidden />
      {brand}
    </span>
  );
}

export function ConfidenceMeter({ value }: { value: number }) {
  const tone = value >= 85 ? 'high' : value >= 55 ? 'mid' : 'low';
  return (
    <div className="confidence" title={`Match confidence ${value}/100`}>
      <div className="confidence__track">
        <div className={`confidence__fill confidence__fill--${tone}`} style={{ width: `${value}%` }} />
      </div>
      <span className="confidence__value">{value}</span>
    </div>
  );
}

export function Card({
  title,
  subtitle,
  actions,
  children,
  bodyless = false,
}: {
  title?: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  bodyless?: boolean;
}) {
  return (
    <section className="card">
      {(title || actions) && (
        <header className="card__header">
          <div className="grow">
            {title && <div className="card__title">{title}</div>}
            {subtitle && <div className="card__subtitle">{subtitle}</div>}
          </div>
          {actions && <div className="card__actions">{actions}</div>}
        </header>
      )}
      {bodyless ? children : <div className="card__body">{children}</div>}
    </section>
  );
}

export function Stat({
  label,
  value,
  meta,
  tone,
  icon,
  active,
  onClick,
}: {
  label: string;
  value: ReactNode;
  meta?: ReactNode;
  tone?: 'lower' | 'equal' | 'higher' | 'accent' | 'teal' | 'info';
  /** Paired with the label so a tinted tile never carries meaning by colour alone. */
  icon?: ReactNode;
  active?: boolean;
  onClick?: () => void;
}) {
  const className = [
    'stat',
    tone ? `stat--${tone}` : '',
    onClick ? 'stat--interactive' : '',
    active ? 'stat--active' : '',
  ]
    .filter(Boolean)
    .join(' ');

  const content = (
    <>
      <div className="stat__head">
        {icon && (
          <span className="stat__icon" aria-hidden>
            {icon}
          </span>
        )}
        <span className="stat__label">{label}</span>
      </div>
      <div className="stat__value">{value}</div>
      {meta && <div className="stat__meta">{meta}</div>}
    </>
  );

  if (!onClick) return <div className={className}>{content}</div>;
  return (
    <button type="button" className={className} onClick={onClick} aria-pressed={Boolean(active)}>
      {content}
    </button>
  );
}

export function EmptyState({
  mark = '◇',
  title,
  body,
  action,
}: {
  mark?: string;
  title: string;
  body?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <div className="empty__mark">{mark}</div>
      <div className="empty__title">{title}</div>
      {body && <div className="empty__body">{body}</div>}
      {action}
    </div>
  );
}

export function Alert({
  tone = 'info',
  title,
  children,
}: {
  tone?: 'info' | 'ok' | 'warn' | 'danger';
  title?: ReactNode;
  children: ReactNode;
}) {
  const icon = { info: 'ℹ', ok: '✓', warn: '⚠', danger: '⚠' }[tone];
  return (
    <div className={`alert alert--${tone}`} role={tone === 'danger' ? 'alert' : undefined}>
      <span className="alert__icon" aria-hidden>
        {icon}
      </span>
      <div className="alert__body">
        {title && <div className="alert__title">{title}</div>}
        <div>{children}</div>
      </div>
    </div>
  );
}

export function TableSkeleton({ rows = 6, columns = 6 }: { rows?: number; columns?: number }) {
  return (
    <div style={{ padding: 'var(--sp-4)' }}>
      {Array.from({ length: rows }).map((_, rowIndex) => (
        <div key={rowIndex} className="row" style={{ padding: '10px 4px', gap: 'var(--sp-6)' }}>
          {Array.from({ length: columns }).map((__, columnIndex) => (
            <div
              key={columnIndex}
              className="skeleton"
              style={{ flex: columnIndex === 0 ? 3 : 1, opacity: 1 - rowIndex * 0.1 }}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

/* ---------- Toasts ---------- */

interface Toast {
  id: number;
  message: string;
  tone: 'ok' | 'error' | 'info';
}

const ToastContext = createContext<(message: string, tone?: Toast['tone']) => void>(() => {});

export function useToast() {
  return useContext(ToastContext);
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const push = useCallback((message: string, tone: Toast['tone'] = 'info') => {
    const id = Date.now() + Math.random();
    setToasts((current) => [...current, { id, message, tone }]);
    setTimeout(() => setToasts((current) => current.filter((toast) => toast.id !== id)), 6000);
  }, []);

  const value = useMemo(() => push, [push]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toast-stack" role="status" aria-live="polite">
        {toasts.map((toast) => (
          <div key={toast.id} className={`toast toast--${toast.tone}`}>
            <span aria-hidden>{toast.tone === 'ok' ? '✓' : toast.tone === 'error' ? '✕' : '•'}</span>
            <span>{toast.message}</span>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
