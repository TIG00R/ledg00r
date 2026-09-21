import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { hijriTextOfIso } from '@ledger/engine';
import { Icon } from './Icon';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
                'July', 'August', 'September', 'October', 'November', 'December'];
const DOW = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];

/** the calendar's own size, and how close to the window's edge it may come */
const CAL_W = 250;
const CAL_H = 320;
const GAP = 6;
const EDGE = 8;

const iso = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** Monday-first, because that is how the months in this ledger are read. */
function grid(year: number, month: number): Array<Date | null> {
  const first = new Date(year, month, 1);
  const lead = (first.getDay() + 6) % 7;
  const days = new Date(year, month + 1, 0).getDate();
  const cells: Array<Date | null> = Array.from({ length: lead }, () => null);
  for (let d = 1; d <= days; d++) cells.push(new Date(year, month, d));
  while (cells.length % 7) cells.push(null);
  return cells;
}

/**
 * The application's own date field.
 *
 * A native date input paints its calendar with the operating system's palette, which is the
 * same objection that retired the native dropdown. This one types and picks: the text box
 * takes a typed yyyy-mm-dd, and the calendar underneath it takes a click. Both write the
 * same string, so whatever reads the value never has to know which was used.
 *
 * The calendar is drawn into the body rather than under the field. Positioned inside the
 * field it was clipped by whatever hid its overflow and stacked under whatever sat above it —
 * in a table's heading band, which is sticky and has a stacking order of its own, the calendar
 * came out behind the headings. Drawn into the body it is measured against the window, follows
 * the field as the page scrolls, and opens upwards where there is no room below.
 */
export function DateField({ value, onChange, ariaLabel, min, max, style, hijri = false }: {
  value: string;
  onChange: (v: string) => void;
  ariaLabel: string;
  min?: string;
  max?: string;
  style?: React.CSSProperties;
  /**
   * The lunar date, under the field.
   *
   * Off unless asked for. Zakat runs on the lunar year and sadaqat is dated beside it, so
   * both want it; everywhere else it is a second date nobody is reading, under a field that
   * then stands taller than the ones beside it.
   */
  hijri?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState(value);
  const parsed = useMemo(() => (/^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T12:00:00`) : null), [value]);
  const [cursor, setCursor] = useState(() => parsed ?? new Date());
  const root = useRef<HTMLDivElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<{ left: number; top?: number; bottom?: number; maxHeight: number }>(
    { left: 0, top: 0, maxHeight: CAL_H },
  );

  /**
   * Where the calendar goes.
   *
   * Below the field when it fits, above when it does not, and on the side with more room when
   * it fits neither — capped to the room that side has, so a short window shows a calendar
   * that scrolls rather than one running off the top of the screen.
   */
  const place = useCallback(() => {
    const r = root.current?.getBoundingClientRect();
    if (!r) return;
    const below = window.innerHeight - r.bottom - GAP - EDGE;
    const above = r.top - GAP - EDGE;
    const up = below < CAL_H && above > below;
    setBox({
      left: Math.max(EDGE, Math.min(r.left, window.innerWidth - CAL_W - EDGE)),
      ...(up ? { bottom: window.innerHeight - r.top + GAP } : { top: r.bottom + GAP }),
      maxHeight: Math.max(200, Math.min(CAL_H, up ? above : below)),
    });
  }, []);

  useLayoutEffect(() => { if (open) place(); }, [open, place]);

  useEffect(() => { setTyped(value); }, [value]);
  useEffect(() => { if (parsed) setCursor(parsed); }, [parsed]);

  useEffect(() => {
    if (!open) return;
    // the calendar is no longer inside the field, so it is asked separately
    const away = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!root.current?.contains(t) && !pop.current?.contains(t)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    const follow = () => place();
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    window.addEventListener('scroll', follow, true);
    window.addEventListener('resize', follow);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', esc);
      window.removeEventListener('scroll', follow, true);
      window.removeEventListener('resize', follow);
    };
  }, [open, place]);

  const commit = (t: string) => {
    setTyped(t);
    if (/^\d{4}-\d{2}-\d{2}$/.test(t)) onChange(t);
  };
  const blocked = (d: Date) => (min && iso(d) < min) || (max && iso(d) > max);

  return (
    <div ref={root} style={{ position: 'relative', ...style }}>
      <span style={{ display: 'flex', alignItems: 'center', gap: 0 }}>
        <input className="mono public" value={typed} onChange={(e) => commit(e.target.value)}
               aria-label={ariaLabel} placeholder="yyyy-mm-dd" inputMode="numeric"
               style={{ flex: 1, minWidth: 0, paddingRight: 36 }} />
        <button type="button" className="df-open" onClick={() => setOpen((o) => !o)} aria-expanded={open}
                aria-label={`${ariaLabel} — open the calendar`}
                style={{ position: 'absolute', right: 6, display: 'flex', padding: 5, cursor: 'pointer',
                         color: 'var(--faint)', background: 'transparent', border: 'none' }}>
          <Icon name="calendar" size={14} motion="none" />
        </button>
      </span>

      {/* Inside a table row this is taken out of the flow — see `.rt-field .df-hijri`. A date
          field that is two lines tall where its neighbours are one sits its input above
          theirs, and the row stops reading as a row. */}
      {hijri && hijriTextOfIso(value) && (
        <span className="df-hijri"
              style={{ display: 'block', fontSize: 10, color: 'var(--faint)', marginTop: 3 }}>
          {hijriTextOfIso(value)} AH
        </span>
      )}

      {open && createPortal((
        <div ref={pop} role="dialog" aria-label={ariaLabel} style={{
          position: 'fixed', zIndex: 400, left: box.left, top: box.top, bottom: box.bottom,
          width: CAL_W, maxHeight: box.maxHeight, overflowY: 'auto', padding: 12,
          borderRadius: 'var(--r-card)', background: 'var(--surface)',
          border: '1px solid var(--hairline-strong)', boxShadow: 'var(--shadow-lg)',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10 }}>
            <button className="btn quiet" aria-label="Previous month" style={{ padding: 5, border: 'none' }}
                    onClick={() => setCursor(new Date(cursor.getFullYear(), cursor.getMonth() - 1, 1))}>
              <Icon name="chevron" size={14} motion="none" />
            </button>
            <span style={{ flex: 1, textAlign: 'center', fontSize: 13, fontWeight: 600 }}>
              {MONTHS[cursor.getMonth()]} {cursor.getFullYear()}
            </span>
            <button className="btn quiet" aria-label="Next month" style={{ padding: 5, border: 'none' }}
                    onClick={() => setCursor(new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1))}>
              <Icon name="chevron" size={14} motion="none" style={{ transform: 'rotate(180deg)' }} />
            </button>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 2 }}>
            {DOW.map((d, i) => (
              <span key={i} style={{ fontSize: 10, textAlign: 'center', color: 'var(--faint)', paddingBottom: 4 }}>{d}</span>
            ))}
            {grid(cursor.getFullYear(), cursor.getMonth()).map((d, i) => {
              if (!d) return <span key={i} />;
              const on = iso(d) === value;
              const off = blocked(d);
              return (
                <button key={i} disabled={!!off} onClick={() => { onChange(iso(d)); setOpen(false); }}
                  aria-label={iso(d)} aria-pressed={on}
                  style={{
                    height: 29, borderRadius: 7, fontSize: 12, cursor: off ? 'default' : 'pointer',
                    border: 'none', opacity: off ? 0.3 : 1,
                    background: on ? 'var(--accent)' : 'transparent',
                    color: on ? 'var(--accent-ink)' : 'var(--ink)',
                    fontWeight: on ? 600 : 400,
                  }}>
                  {d.getDate()}
                </button>
              );
            })}
          </div>

          {hijri && hijriTextOfIso(value) && (
            <div style={{ marginTop: 10, fontSize: 11, color: 'var(--faint)', textAlign: 'center' }}>
              {hijriTextOfIso(value)} AH
            </div>
          )}
          <button className="btn ghost" style={{ width: '100%', marginTop: 10, fontSize: 12, padding: '7px 0' }}
                  onClick={() => { onChange(iso(new Date())); setOpen(false); }}>Today</button>
        </div>
      ), document.body)}
    </div>
  );
}
