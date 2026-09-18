import { useState } from 'react';

export interface PieSlice { label: string; value: number; color: string }

/**
 * A pie, drawn flat: a circle, seen straight on.
 *
 * Straight down onto the circle is the honest way to read a share — the angle is the
 * quantity and nothing about the drawing distorts it. It was tilted back and given a
 * thickness for a while, which kept the angles exactly as they were and only changed where
 * the ink landed; what that cost is that a wedge near the front carries more area on screen
 * than a wedge of the same size near the back, so the eye can be talked into the wrong
 * ranking. A chart of shares is worth more read straight, so straight is the default and the
 * tilt is something a caller has to ask for by name.
 *
 * Tilted, the solid is built from three kinds of face: the lid, the band around the outside,
 * and the flat cut where one wedge leaves off and the next begins. Only the faces turned
 * towards the viewer are drawn; the rest are behind the lid and would never be seen. Faces
 * are laid down back to front, and the lids last, because a lid is above every wall on the
 * board. Flat, there are no walls at all and only the lids are drawn.
 */
export function Pie({ slices, size = 232, format, caption, tilt = 1, depth = 0 }: {
  slices: PieSlice[]; size?: number;
  format?: (v: number) => string;
  /** Shown under the chart while nothing is being pointed at. */
  caption?: React.ReactNode;
  /** How far the disc is laid back: 1 is face on — a circle — and 0 is edge on. */
  tilt?: number;
  /** How thick the disc is, in the same units as the radius. Nought is a flat circle. */
  depth?: number;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const total = slices.reduce((s, x) => s + x.value, 0) || 1;

  const cx = size / 2;
  const rx = cx - 10;             // room for the wedge that pulls out
  const ry = rx * tilt;
  const cy = POP + ry + 4;
  const height = cy + ry + depth + POP + 4;

  let from = 0;
  const wedges = slices.map((s, i) => {
    const span = (s.value / total) * 360;
    const to = from + span;
    const mid = from + span / 2;
    const w = {
      s, i, from, to,
      top: lid(cx, cy, rx, ry, from, to),
      walls: depth > 0 ? walls(cx, cy, rx, ry, from, to, depth) : [],
      pop: { x: Math.sin(rad(mid)) * POP, y: -Math.cos(rad(mid)) * POP * tilt },
    };
    from = to;
    return w;
  });

  // Back to front: a face further from the viewer sits further up the screen, and cosine of
  // the angle it faces is exactly how far back that is.
  const faces = wedges
    .flatMap((w) => w.walls.map((f) => ({ ...f, w })))
    .sort((a, b) => b.depth - a.depth);

  const active = hover != null ? slices[hover] : null;
  const shown = (i: number) => (hover == null || hover === i ? 1 : 0.34);
  const shift = (i: number, pop: { x: number; y: number }) =>
    (hover === i ? `translate(${round(pop.x)} ${round(pop.y)})` : undefined);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10 }}
         onMouseLeave={() => setHover(null)}>
      <svg width={size} height={height} viewBox={`0 0 ${size} ${height}`} role="img"
           aria-label={slices.map((s) => `${s.label} ${((s.value / total) * 100).toFixed(1)}%`).join(', ')}>
        {faces.map((f, n) => (
          <path key={`w${n}`} d={f.d}
                fill={`color-mix(in srgb, ${f.w.s.color} ${f.side === 'rim' ? 68 : 52}%, #000)`}
                onMouseEnter={() => setHover(f.w.i)}
                transform={shift(f.w.i, f.w.pop)}
                opacity={shown(f.w.i)}
                style={MOVE} />
        ))}
        {wedges.map(({ s, i, top, pop }) => (
          <path key={s.label} d={top} fill={s.color} stroke="var(--surface)" strokeWidth={2}
                onMouseEnter={() => setHover(i)}
                transform={shift(i, pop)}
                opacity={shown(i)}
                style={MOVE} />
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

/** How far a wedge steps out along its own bisector while it is pointed at. */
const POP = 8;

const MOVE = {
  transition: 'transform 220ms var(--ease), opacity 180ms var(--ease)',
  cursor: 'default',
} as const;

/** The top face of a wedge, `a1` to `a2` in degrees clockwise from twelve o'clock. */
function lid(cx: number, cy: number, rx: number, ry: number, a1: number, a2: number): string {
  // A wedge that is the whole circle has no two ends to draw an arc between, so it is drawn
  // as two half ellipses instead — otherwise the path closes on itself and vanishes.
  if (a2 - a1 >= 359.999) {
    return `M ${cx} ${round(cy - ry)} A ${rx} ${ry} 0 1 1 ${cx} ${round(cy + ry)} `
         + `A ${rx} ${ry} 0 1 1 ${cx} ${round(cy - ry)} Z`;
  }
  const p1 = on(cx, cy, rx, ry, a1), p2 = on(cx, cy, rx, ry, a2);
  return `M ${cx} ${cy} L ${p1.x} ${p1.y} `
       + `A ${rx} ${ry} 0 ${a2 - a1 > 180 ? 1 : 0} 1 ${p2.x} ${p2.y} Z`;
}

/**
 * The faces of one wedge that are turned towards the viewer.
 *
 * The band is the part of the wedge's own arc that lies on the near side of the disc, which
 * is the half running from a quarter past to a quarter to. A cut face is seen when the wedge
 * body is on the far side of it: for the edge the wedge starts at, that is anywhere in the
 * left half of the circle, and for the edge it ends at, the right half.
 */
function walls(cx: number, cy: number, rx: number, ry: number, a1: number, a2: number, depth: number) {
  const out: Array<{ d: string; depth: number; side: 'rim' | 'cut' }> = [];

  const b1 = Math.max(a1, 90), b2 = Math.min(a2, 270);
  if (b2 > b1) {
    const p1 = on(cx, cy, rx, ry, b1), p2 = on(cx, cy, rx, ry, b2);
    const large = b2 - b1 > 180 ? 1 : 0;
    out.push({
      side: 'rim',
      depth: Math.cos(rad((b1 + b2) / 2)),
      d: `M ${p1.x} ${p1.y} A ${rx} ${ry} 0 ${large} 1 ${p2.x} ${p2.y} `
       + `L ${p2.x} ${round(p2.y + depth)} A ${rx} ${ry} 0 ${large} 0 ${p1.x} ${round(p1.y + depth)} Z`,
    });
  }

  for (const a of [a1, a2]) {
    const facing = a === a1 ? Math.sin(rad(a)) < 0 : Math.sin(rad(a)) > 0;
    if (!facing || a2 - a1 >= 359.999) continue;
    const p = on(cx, cy, rx, ry, a);
    out.push({
      side: 'cut',
      depth: Math.cos(rad(a)) / 2,
      d: `M ${cx} ${cy} L ${p.x} ${p.y} L ${p.x} ${round(p.y + depth)} `
       + `L ${cx} ${round(cy + depth)} Z`,
    });
  }

  return out;
}

function on(cx: number, cy: number, rx: number, ry: number, deg: number) {
  const a = rad(deg);
  return { x: round(cx + rx * Math.sin(a)), y: round(cy - ry * Math.cos(a)) };
}

const rad = (deg: number) => (deg * Math.PI) / 180;
const round = (n: number) => Math.round(n * 1000) / 1000;
