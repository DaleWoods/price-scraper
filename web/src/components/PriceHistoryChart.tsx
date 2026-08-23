import { useMemo, useRef, useState } from 'react';
import { formatDateTime, formatMoney, type ProductHistoryEntry } from '../api';
import { hueFor } from './CompetitorLogo';

/**
 * Our price vs. each competitor's observed price, over time.
 *
 * Honest about what data actually exists: `price_observations` accumulates a
 * real history per competitor, but `fascia_prices` only ever holds the
 * *current* price — a feed import overwrites it, nothing keeps the old value.
 * So competitors get real lines; our price is a single dashed reference line,
 * not a fabricated series pretending it was always that price.
 *
 * Colors reuse `hueFor` from the competitor badges rather than a separate
 * palette — the same competitor should read as the same color everywhere in
 * the app, and inventing a second identity system for one chart would cost
 * more than it buys.
 */

const WIDTH = 640;
const HEIGHT = 220;
const PAD = { top: 16, right: 16, bottom: 28, left: 56 };
const PLOT_W = WIDTH - PAD.left - PAD.right;
const PLOT_H = HEIGHT - PAD.top - PAD.bottom;

interface SeriesPoint {
  t: number;
  price: number;
}

interface Series {
  competitorId: number;
  name: string;
  slug: string;
  color: string;
  points: SeriesPoint[];
}

function niceTicks(min: number, max: number, count = 4): number[] {
  if (min === max) return [min];
  const range = max - min;
  const rawStep = range / count;
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const residual = rawStep / magnitude;
  const step = (residual >= 5 ? 10 : residual >= 2 ? 5 : residual >= 1 ? 2 : 1) * magnitude;
  const ticks: number[] = [];
  for (let v = Math.floor(min / step) * step; v <= max + step * 0.001; v += step) {
    ticks.push(Math.round(v * 100) / 100);
  }
  return ticks;
}

export function PriceHistoryChart({
  history,
  ourPrice,
  currency,
}: {
  history: ProductHistoryEntry[];
  ourPrice: number | null;
  currency: string;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [hoverX, setHoverX] = useState<number | null>(null);

  const { series, allTimes, yMin, yMax } = useMemo(() => {
    const byCompetitor = new Map<number, Series>();
    for (const entry of history) {
      if (entry.price == null) continue;
      const t = new Date(entry.observed_at).getTime();
      if (Number.isNaN(t)) continue;

      let s = byCompetitor.get(entry.competitor_id);
      if (!s) {
        s = {
          competitorId: entry.competitor_id,
          name: entry.competitor_name,
          slug: entry.competitor_slug,
          color: `hsl(${hueFor(entry.competitor_slug)} 55% 42%)`,
          points: [],
        };
        byCompetitor.set(entry.competitor_id, s);
      }
      s.points.push({ t, price: entry.price });
    }

    const series = [...byCompetitor.values()].map((s) => ({
      ...s,
      points: s.points.sort((a, b) => a.t - b.t),
    }));

    const allTimes = series.flatMap((s) => s.points.map((p) => p.t)).sort((a, b) => a - b);

    const allPrices = series.flatMap((s) => s.points.map((p) => p.price));
    if (ourPrice != null) allPrices.push(ourPrice);

    const rawMin = allPrices.length ? Math.min(...allPrices) : 0;
    const rawMax = allPrices.length ? Math.max(...allPrices) : 1;
    // A little headroom so a flat line or a single point doesn't sit on an edge.
    const pad = Math.max((rawMax - rawMin) * 0.1, rawMax * 0.02, 1);

    return { series, allTimes, yMin: rawMin - pad, yMax: rawMax + pad };
  }, [history, ourPrice]);

  const tMin = allTimes[0] ?? Date.now() - 86_400_000;
  const tMax = allTimes[allTimes.length - 1] ?? Date.now();
  const tSpan = Math.max(tMax - tMin, 1);
  const ySpan = Math.max(yMax - yMin, 1);

  const x = (t: number) => PAD.left + ((t - tMin) / tSpan) * PLOT_W;
  const y = (price: number) => PAD.top + PLOT_H - ((price - yMin) / ySpan) * PLOT_H;

  const hasData = series.some((s) => s.points.length > 0);

  const handleMove = (event: React.MouseEvent<SVGSVGElement>) => {
    const svg = svgRef.current;
    if (!svg || allTimes.length === 0) return;
    const rect = svg.getBoundingClientRect();
    const px = ((event.clientX - rect.left) / rect.width) * WIDTH;
    const targetT = tMin + ((px - PAD.left) / PLOT_W) * tSpan;

    // Snap to the nearest actual observation, not an arbitrary pixel — the
    // reader aims at a date, never at empty space between two real points.
    let nearest = allTimes[0]!;
    let bestDelta = Math.abs(nearest - targetT);
    for (const t of allTimes) {
      const delta = Math.abs(t - targetT);
      if (delta < bestDelta) {
        nearest = t;
        bestDelta = delta;
      }
    }
    setHoverX(nearest);
  };

  if (!hasData && ourPrice == null) return null;

  const yTicks = niceTicks(yMin, yMax);

  // "Last known price as of the hovered date" — a price observation is valid
  // until the next one, not interpolated between two real readings.
  const hoverRows =
    hoverX == null
      ? []
      : series
          .map((s) => {
            const asOf = [...s.points].reverse().find((p) => p.t <= hoverX);
            return asOf ? { name: s.name, color: s.color, price: asOf.price } : null;
          })
          .filter((row): row is { name: string; color: string; price: number } => row !== null);

  return (
    <div className="price-history-chart">
      {series.length > 0 && (
        <div className="price-history-chart__legend">
          {series.map((s) => {
            const latest = s.points[s.points.length - 1];
            return (
              <span key={s.competitorId} className="price-history-chart__legend-item">
                <span className="price-history-chart__swatch" style={{ background: s.color }} aria-hidden />
                {s.name}
                {latest && (
                  <span className="muted"> · {formatMoney(latest.price, currency)}</span>
                )}
              </span>
            );
          })}
          {ourPrice != null && (
            <span className="price-history-chart__legend-item">
              <span className="price-history-chart__swatch price-history-chart__swatch--ours" aria-hidden />
              Our price (current) · {formatMoney(ourPrice, currency)}
            </span>
          )}
        </div>
      )}

      <svg
        ref={svgRef}
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        className="price-history-chart__svg"
        role="img"
        aria-label="Price history over time"
        onMouseMove={handleMove}
        onMouseLeave={() => setHoverX(null)}
      >
        {yTicks.map((tick) => (
          <g key={tick}>
            <line
              x1={PAD.left}
              x2={WIDTH - PAD.right}
              y1={y(tick)}
              y2={y(tick)}
              stroke="var(--border)"
              strokeWidth={1}
            />
            <text x={PAD.left - 8} y={y(tick)} textAnchor="end" dominantBaseline="middle" className="price-history-chart__tick">
              {formatMoney(tick, currency)}
            </text>
          </g>
        ))}

        {allTimes.length > 0 && (
          <>
            <text x={PAD.left} y={HEIGHT - 8} textAnchor="start" className="price-history-chart__tick">
              {formatDateTime(new Date(tMin).toISOString())}
            </text>
            <text x={WIDTH - PAD.right} y={HEIGHT - 8} textAnchor="end" className="price-history-chart__tick">
              {formatDateTime(new Date(tMax).toISOString())}
            </text>
          </>
        )}

        {ourPrice != null && (
          <line
            x1={PAD.left}
            x2={WIDTH - PAD.right}
            y1={y(ourPrice)}
            y2={y(ourPrice)}
            stroke="var(--text-faint)"
            strokeWidth={2}
            strokeDasharray="5 4"
          />
        )}

        {series.map((s) => (
          <g key={s.competitorId}>
            {s.points.length > 1 && (
              <path
                d={s.points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${x(p.t)} ${y(p.price)}`).join(' ')}
                fill="none"
                stroke={s.color}
                strokeWidth={2}
                strokeLinejoin="round"
                strokeLinecap="round"
              />
            )}
            {s.points.map((p) => (
              <circle
                key={p.t}
                cx={x(p.t)}
                cy={y(p.price)}
                r={4}
                fill={s.color}
                stroke="var(--surface)"
                strokeWidth={2}
              />
            ))}
          </g>
        ))}

        {hoverX != null && (
          <line
            x1={x(hoverX)}
            x2={x(hoverX)}
            y1={PAD.top}
            y2={HEIGHT - PAD.bottom}
            stroke="var(--text-faint)"
            strokeWidth={1}
          />
        )}
      </svg>

      {hoverX != null && hoverRows.length > 0 && (
        <div className="price-history-chart__tooltip">
          <div className="price-history-chart__tooltip-date">{formatDateTime(new Date(hoverX).toISOString())}</div>
          {hoverRows.map((row) => (
            <div key={row.name} className="price-history-chart__tooltip-row">
              <span className="price-history-chart__swatch" style={{ background: row.color }} aria-hidden />
              <span className="muted">{row.name}</span>
              <strong>{formatMoney(row.price, currency)}</strong>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
