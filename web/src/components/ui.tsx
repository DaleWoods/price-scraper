import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import type { PricePosition } from '../api';

/* ---------- Price-position badge ----------------------------------------
   One visual language for price position, used in every table and panel:
   lower = we undercut them (good), higher = they undercut us (needs action).
   ------------------------------------------------------------------------ */

const POSITION_COPY: Record<PricePosition, string> = {
  lower: 'We are cheaper',
  equal: 'Level',
  higher: 'They are cheaper',
};

export function PositionBadge({
  position,
  compact = false,
}: {
  position: PricePosition | null;
  compact?: boolean;
}) {
  if (!position) {
    return (
      <span className="badge badge--neutral" title="No competitor price recorded yet">
        No data
      </span>
    );
  }
  return (
    <span className={`badge badge--${position}`} title={POSITION_COPY[position]}>
      <span className="badge__dot" />
      {compact ? position : POSITION_COPY[position]}
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
  active,
  onClick,
}: {
  label: string;
  value: ReactNode;
  meta?: ReactNode;
  tone?: 'lower' | 'equal' | 'higher' | 'accent';
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
      <div className="stat__label">{label}</div>
      <div className="stat__value">{value}</div>
      {meta && <div className="stat__meta">{meta}</div>}
    </>
  );

  if (!onClick) return <div className={className}>{content}</div>;
  return (
    <button type="button" className={className} onClick={onClick} style={{ textAlign: 'left' }}>
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
