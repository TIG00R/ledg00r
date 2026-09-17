import { useMemo, useState } from 'react';
import { money, type Currency } from '@ledger/engine';

export interface Point {
  bucket: string; amount: number; count: number;
  native: Array<{ currency: string; amount: number }>;
}
export interface Line {
  id: string; name: string; color: string; icon: string | null;
  total: number; points: Point[];
}
export interface Ceiling {
  id: string; name: string; color: string; perBucket: number; destinationIds: string[];
}

/**
 * Spending over time, one line per destination.
 *
 * Time runs across, money runs up, and each destination is drawn in the colour it was given
 * — the same colour it wears in the log, on the ring and beside its records, so a line is
 * recognised without reading the legend. A ceiling that applies is a dashed rule in the
 * pool's own colour, at the height one bucket of it reaches.
 *
 * Every figure here is converted into the display currency at the rate the ledger holds, and
 * under it, smaller, is what was actually paid — an expense keeps the amount and the currency
 * it was in, and conversion happens when it is drawn and nowhere else.
 */
export function BudgetChart({ buckets, lines, ceilings, currency, height = 260, label }: {
  buckets: string[];
  lines: Line[];
  ceilings: Ceiling[];
  currency: Currency;
  height?: number;
  /** how a bucket key is written on the axis */
  label: (bucket: string) => string;
}) {
  const [hover, setHover] = useState<{ line: string; bucket: string } | null>(null);
  const [only, setOnly] = useState<string | null>(null);

  const shown = only ? lines.filter((l) => l.id === only) : lines;
  const peak = useMemo(() => Math.max(
    1,
    ...shown.flatMap((l) => l.points.map((p) => p.amount)),
    ...ceilings.map((c) => c.perBucket),
  ), [shown, ceilings]);

  // room at the left for the figures on the scale, and under the plot for the dates
  const PAD = { left: 62, right: 14, top: 14, bottom: 34 };
  const W = 780;
  const H = height;
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;

  const x = (bucket: string) => {
    const i = buckets.indexOf(bucket);
    if (buckets.length === 1) return PAD.left + plotW / 2;
    return PAD.left + (i / (buckets.length - 1)) * plotW;
  };
  const y = (amount: number) => PAD.top + plotH - (amount / peak) * plotH;

  /** four gridlines and the floor, at round-ish fractions of the tallest thing drawn */
  const rules = [0, 0.25, 0.5, 0.75, 1].map((f) => ({ f, value: peak * f }));

  const at = hover
    ? lines.find((l) => l.id === hover.line)?.points.find((p) => p.bucket === hover.bucket)
    : null;

  if (buckets.length === 0 || lines.length === 0) {
    return (
      <p style={{ margin: 0, fontSize: 13, color: 'var(--muted)' }}>
        Nothing was spent in this window, so there is nothing to draw.
      </p>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ overflowX: 'auto' }}>
        <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} role="img"
             aria-label={`Spending per ${buckets[0]!.length === 4 ? 'year' : 'month'}, by destination`}
             style={{ minWidth: 520, display: 'block' }}>
          {rules.map((r) => (
            <g key={r.f}>
              <line x1={PAD.left} x2={W - PAD.right} y1={y(r.value)} y2={y(r.value)}
                    stroke="var(--hairline)" strokeWidth="1" />
              <text x={PAD.left - 8} y={y(r.value) + 3.5} textAnchor="end"
                    fontSize="10" fill="var(--faint)" className="mono">
                {short(r.value, currency)}
              </text>
            </g>
          ))}

          {/* a ceiling, where one applies: the height one bucket of it reaches */}
          {ceilings.filter((c) => c.perBucket <= peak).map((c) => (
            <g key={c.id}>
              <line x1={PAD.left} x2={W - PAD.right} y1={y(c.perBucket)} y2={y(c.perBucket)}
                    stroke={c.color} strokeWidth="1.5" strokeDasharray="6 4" opacity="0.75" />
              <text x={W - PAD.right} y={y(c.perBucket) - 5} textAnchor="end"
                    fontSize="10" fill={c.color} opacity="0.9">
                {c.name} · {short(c.perBucket, currency)}
              </text>
            </g>
          ))}

          {buckets.map((b, i) => (
            <text key={b} x={x(b)} y={H - 12}
                  textAnchor={i === 0 ? 'start' : i === buckets.length - 1 ? 'end' : 'middle'}
                  fontSize="10" fill="var(--faint)">
              {label(b)}
            </text>
          ))}

          {shown.map((l) => {
            const dim = only ? false : hover != null && hover.line !== l.id;
            const path = l.points
              .map((p, i) => `${i === 0 ? 'M' : 'L'} ${x(p.bucket).toFixed(1)} ${y(p.amount).toFixed(1)}`)
              .join(' ');
            return (
              <g key={l.id} opacity={dim ? 0.22 : 1}
                 style={{ transition: 'opacity 150ms var(--ease)' }}>
                <path d={path} fill="none" stroke={l.color} strokeWidth="2"
                      strokeLinejoin="round" strokeLinecap="round" />
                {l.points.map((p) => (
                  <circle key={p.bucket} cx={x(p.bucket)} cy={y(p.amount)}
                          r={hover?.line === l.id && hover.bucket === p.bucket ? 5 : 3}
                          fill="var(--surface)" stroke={l.color} strokeWidth="2"
                          style={{ cursor: 'pointer' }}
                          onMouseEnter={() => setHover({ line: l.id, bucket: p.bucket })}
                          onMouseLeave={() => setHover(null)} />
                ))}
              </g>
            );
          })}
        </svg>
      </div>

      {/*
        * What one point actually was.
        *
        * The figure in the display currency, and under it — smaller — the amounts as they
        * were recorded. A month of spending in two currencies says both, because "E£ 4,210"
        * is a conversion and "$ 60 · E£ 1,200" is what happened.
        */}
      <div style={{ minHeight: 34 }}>
        {at && hover ? (
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 12, color: 'var(--muted)' }}>
              {lines.find((l) => l.id === hover.line)?.name} · {label(hover.bucket)}
            </span>
            <span className="mono" style={{ fontSize: 15, fontWeight: 500 }}>
              {money(at.amount, currency)}
            </span>
            <span className="mono" style={{ fontSize: 11, color: 'var(--faint)' }}>
              {at.native.map((n) => money(n.amount, n.currency as Currency)).join(' · ')}
              {' · '}{at.count} record{at.count === 1 ? '' : 's'}
            </span>
          </div>
        ) : (
          <span style={{ fontSize: 12, color: 'var(--faint)' }}>
            Point at a dot for what that {buckets[0]!.length === 4 ? 'year' : 'month'} was,
            in {currency} and in the currencies it was paid in.
          </span>
        )}
      </div>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {lines.map((l) => {
          const on = only === l.id;
          return (
            <button key={l.id} onClick={() => setOnly(on ? null : l.id)} aria-pressed={on}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 7, cursor: 'pointer',
                fontSize: 12, padding: '5px 10px', borderRadius: 999,
                background: on ? `color-mix(in srgb, ${l.color} 16%, transparent)` : 'var(--raised)',
                border: `1px solid ${on ? l.color : 'var(--hairline)'}`,
                color: on ? 'var(--ink)' : 'var(--muted)',
              }}>
              <span style={{ width: 9, height: 9, borderRadius: 3, background: l.color }} />
              {l.name}
              <span className="mono" style={{ fontSize: 11, color: 'var(--faint)' }}>
                {money(l.total, currency)}
              </span>
            </button>
          );
        })}
        {only && (
          <button className="btn ghost sm" onClick={() => setOnly(null)}>Show all</button>
        )}
      </div>
    </div>
  );
}

/** A figure on the scale: readable at ten pixels, so thousands lose their tail. */
function short(v: number, currency: Currency): string {
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `${Math.round(v / 1_000)}k`;
  return money(v, currency, 0).replace(/^[^\d-]+/, '');
}
