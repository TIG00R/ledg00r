import { useState } from 'react';

export interface Slice { label: string; value: number; color: string }

/**
 * A ring, not a pie. Segments are separated by a real gap, sit on a track so the shape
 * reads even when a slice is tiny, and lift on hover with the figure shown in the middle —
 * so the chart answers "how much" as well as "what share".
 */
export function Donut({ slices, size = 176, thickness = 20, centre, format }: {
  slices: Slice[]; size?: number; thickness?: number;
  centre?: React.ReactNode; format?: (v: number) => string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const total = slices.reduce((s, x) => s + x.value, 0) || 1;
  const r = (size - thickness - 6) / 2;
  const c = 2 * Math.PI * r;
  const gap = 3;
  const active = hover != null ? slices[hover] : null;

  let offset = 0;
  const arcs = slices.map((s, i) => {
    const len = Math.max((s.value / total) * c - gap, 1);
    const arc = { s, i, len, dash: `${len} ${c - len}`, offset: -offset };
    offset += (s.value / total) * c;
    return arc;
  });

  return (
    <div style={{ position: 'relative', width: size, height: size, flex: `0 0 ${size}px` }}
         onMouseLeave={() => setHover(null)}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img"
           aria-label={slices.map((s) => `${s.label} ${((s.value / total) * 100).toFixed(1)}%`).join(', ')}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--hairline)" strokeWidth={thickness} />
        <g transform={`rotate(-90 ${size / 2} ${size / 2})`} fill="none">
          {arcs.map(({ s, i, dash, offset: o }) => (
            <circle key={s.label} cx={size / 2} cy={size / 2} r={r} stroke={s.color}
              strokeWidth={hover === i ? thickness + 6 : thickness}
              strokeDasharray={dash} strokeDashoffset={o} strokeLinecap="butt"
              opacity={hover == null || hover === i ? 1 : 0.32}
              onMouseEnter={() => setHover(i)}
              style={{ transition: 'stroke-width 150ms var(--ease), opacity 150ms var(--ease)', cursor: 'default' }} />
          ))}
        </g>
      </svg>
      <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column',
                    alignItems: 'center', justifyContent: 'center', gap: 2, pointerEvents: 'none',
                    textAlign: 'center', padding: thickness + 8 }}>
        {active ? (
          <>
            <span style={{ fontSize: 11, color: 'var(--faint)' }}>{active.label}</span>
            <span className="mono" style={{ fontSize: 15, fontWeight: 500, color: active.color }}>
              {format ? format(active.value) : active.value.toLocaleString('en-US')}
            </span>
            <span className="mono" style={{ fontSize: 11, color: 'var(--muted)' }}>
              {((active.value / total) * 100).toFixed(1)}%
            </span>
          </>
        ) : centre}
      </div>
    </div>
  );
}
