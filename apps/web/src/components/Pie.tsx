import { useState } from 'react';

export interface PieSlice { label: string; value: number; color: string }

/**
 * A pie, not a ring.
 *
 * The overview's headline already says what everything is worth, so the middle of the chart
 * has no figure to hold — and a solid wedge carries a share better than an arc of the same
 * thickness does, because the area is the quantity rather than a length the eye has to
 * unroll. Wedges are separated by a stroke in the panel's own colour rather than by a gap,
 * so the circle stays a circle at any size.
 *
 * Pointing at a wedge pulls it out along its own bisector and says what it is underneath,
 * which is the one thing a pie cannot do on its own: name the slice you are looking at.
 */
export function Pie({ slices, size = 232, format, caption }: {
  slices: PieSlice[]; size?: number;
  format?: (v: number) => string;
  /** Shown under the chart while nothing is being pointed at. */
  caption?: React.ReactNode;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const total = slices.reduce((s, x) => s + x.value, 0) || 1;

  const c = size / 2;
  const r = c - 10;              // room for the wedge that pulls out
  const POP = 7;

  let from = 0;
  const wedges = slices.map((s, i) => {
    const span = (s.value / total) * 360;
    const to = from + span;
    const mid = from + span / 2;
    const w = { s, i, d: wedge(c, r, from, to), pop: onCircle(POP, mid), share: s.value / total };
    from = to;
    return w;
  });

  const active = hover != null ? slices[hover] : null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10 }}
         onMouseLeave={() => setHover(null)}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img"
           aria-label={slices.map((s) => `${s.label} ${((s.value / total) * 100).toFixed(1)}%`).join(', ')}>
        {wedges.map(({ s, i, d, pop }) => (
          <path key={s.label} d={d} fill={s.color} stroke="var(--surface)" strokeWidth={2.5}
                onMouseEnter={() => setHover(i)}
                transform={hover === i ? `translate(${pop.x} ${pop.y})` : undefined}
                opacity={hover == null || hover === i ? 1 : 0.34}
                style={{ transition: 'transform 220ms var(--ease), opacity 180ms var(--ease)',
                         cursor: 'default' }} />
        ))}
      </svg>
      <div style={{ minHeight: 34, display: 'flex', flexDirection: 'column',
                    alignItems: 'center', gap: 2, textAlign: 'center' }}>
        {active ? (
          <>
            <span style={{ fontSize: 11, color: 'var(--faint)' }}>{active.label}</span>
            <span className="mono" style={{ fontSize: 15, fontWeight: 500, color: active.color }}>
              {format ? format(active.value) : active.value.toLocaleString('en-US')}
              <span style={{ color: 'var(--muted)' }}>
                {' · '}{((active.value / total) * 100).toFixed(1)}%
              </span>
            </span>
          </>
        ) : caption}
      </div>
    </div>
  );
}

/** A wedge from `a1` to `a2`, both in degrees clockwise from twelve o'clock. */
function wedge(c: number, r: number, a1: number, a2: number): string {
  // A slice that is the whole circle has no two ends to draw an arc between, so it is
  // drawn as two half circles instead — otherwise the path closes on itself and vanishes.
  if (a2 - a1 >= 359.999) {
    return `M ${c} ${c - r} A ${r} ${r} 0 1 1 ${c} ${c + r} A ${r} ${r} 0 1 1 ${c} ${c - r} Z`;
  }
  const p1 = onCircle(r, a1), p2 = onCircle(r, a2);
  const large = a2 - a1 > 180 ? 1 : 0;
  return `M ${c} ${c} L ${c + p1.x} ${c + p1.y} `
       + `A ${r} ${r} 0 ${large} 1 ${c + p2.x} ${c + p2.y} Z`;
}

function onCircle(r: number, deg: number) {
  const a = (deg * Math.PI) / 180;
  return { x: round(r * Math.sin(a)), y: round(-r * Math.cos(a)) };
}

const round = (n: number) => Math.round(n * 1000) / 1000;
