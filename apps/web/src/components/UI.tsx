import type { ReactNode } from 'react';
import { Icon, type IconName } from './Icon';
import { LastOutcome } from '../Live';

/**
 * A screen's frame: the work down the middle, and anything that belongs beside it.
 *
 * The class is what lets the stylesheet fold the two columns into one on a narrow window.
 * These are inline styles because everything here is, and an inline style can only be
 * overridden by a rule that says `!important` — which is exactly what the media queries do,
 * and why they are worth the ugliness.
 */
/**
 * A screen.
 *
 * The receipt for the last thing written sits at the top of it, once, rather than wherever
 * each screen happened to put it — which was under the panel that raised it on some screens
 * and at the foot of the page on others, so a confirmation for something you had just done
 * arrived below the fold.
 */
export function Page({ children, aside }: { children: ReactNode; aside?: ReactNode }) {
  return (
    <main className="page" style={{
      padding: 24, display: 'grid', gap: 20, alignItems: 'start',
      gridTemplateColumns: aside ? 'minmax(0, 1fr) 300px' : 'minmax(0, 1fr)',
      maxWidth: 1440, margin: '0 auto', width: '100%',
    }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 20, minWidth: 0 }}>
        <LastOutcome />
        {children}
      </div>
      {aside && <aside style={{ display: 'flex', flexDirection: 'column', gap: 20, position: 'sticky', top: 82 }}>{aside}</aside>}
    </main>
  );
}

export function Panel({ title, hint, action, children, style }: {
  title?: string; hint?: string; action?: ReactNode; children: ReactNode; style?: React.CSSProperties;
}) {
  return (
    <section className="panel" style={{ padding: 24, ...style }}>
      {(title || action) && (
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: hint ? 4 : 16, flexWrap: 'wrap' }}>
          {title && <h2 style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>{title}</h2>}
          {action && <div style={{ marginLeft: 'auto' }}>{action}</div>}
        </div>
      )}
      {hint && <p style={{ margin: '0 0 18px', fontSize: 12, color: 'var(--faint)' }}>{hint}</p>}
      {children}
    </section>
  );
}

/**
 * A figure with its name above it.
 *
 * `nowrap` matters where the figure is millions in a narrow card: left to wrap, a number
 * breaks between its currency and its digits and reads as two things. Keeping it on one line
 * and letting the box scroll is wrong too, so the caller that asks for this also gives the
 * figure a column it fits in.
 */
export function Stat({ label, value, sub, color, nowrap }: {
  label: string; value: string; sub?: string; color?: string; nowrap?: boolean;
}) {
  return (
    <div style={{ minWidth: 0 }}>
      <div className="ov">{label}</div>
      <div className="mono" style={{ fontSize: nowrap ? 17 : 20, fontWeight: 500, marginTop: 5, color,
                                     whiteSpace: nowrap ? 'nowrap' : undefined }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: 'var(--faint)' }}>{sub}</div>}
    </div>
  );
}

export function Stats({ children }: { children: ReactNode }) {
  return <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 24 }}>{children}</div>;
}

export function Chip({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'good' | 'bad' | 'warn' | 'info' }) {
  const c = { neutral: 'var(--muted)', good: 'var(--positive)', bad: 'var(--negative)', warn: 'var(--gold)', info: 'var(--car)' }[tone];
  const bg = tone === 'neutral' ? 'var(--raised)' : `color-mix(in srgb, ${c} 16%, transparent)`;
  return <span className="chip" style={{ background: bg, color: c }}>{children}</span>;
}

/**
 * An account, with where it is held under it.
 *
 * "USD account" is two different accounts at two different banks, and a log that names only
 * the account leaves the reader to remember which. The institution goes underneath in the
 * quiet colour, so the line still reads as one thing.
 */
export function AccountName({ name, bank, mark }: {
  name: string;
  bank?: string | null;
  /** the institution's own mark, where the caller has it to hand */
  mark?: ReactNode;
}) {
  const lines = (
    <span style={{ display: 'block', minWidth: 0 }}>
      <span style={{ display: 'block' }}>{name}</span>
      {bank && <span className="at-bank">{bank}</span>}
    </span>
  );
  if (!mark) return lines;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, minWidth: 0 }}>
      {mark}
      {lines}
    </span>
  );
}

export function Tile({ icon, color, children }: { icon: IconName; color: string; children?: ReactNode }) {
  return (
    <span style={{
      width: 34, height: 34, borderRadius: 9, flex: '0 0 34px',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: `color-mix(in srgb, ${color} 15%, transparent)`,
    }}>
      {children ?? <Icon name={icon} color={color} size={18} />}
    </span>
  );
}

export function Empty({ icon, title, body, action }: { icon: IconName; title: string; body: string; action?: ReactNode }) {
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8,
      padding: '44px 20px', textAlign: 'center',
      border: '1px dashed var(--hairline-strong)', borderRadius: 'var(--r-card)',
    }}>
      <Icon name={icon} size={26} color="var(--disabled)" />
      <div style={{ fontSize: 14, fontWeight: 500 }}>{title}</div>
      <div style={{ fontSize: 13, color: 'var(--muted)', maxWidth: 420 }}>{body}</div>
      {action && <div style={{ marginTop: 6 }}>{action}</div>}
    </div>
  );
}

export function Toggle({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button role="switch" aria-checked={on} aria-label={label} onClick={() => onChange(!on)}
      style={{
        width: 44, height: 25, borderRadius: 999, border: 'none', cursor: 'pointer', padding: 0,
        position: 'relative', flex: '0 0 44px',
        background: on ? 'var(--accent)' : 'var(--switch-off)',
        transition: 'background 150ms var(--ease)',
      }}>
      <span style={{
        position: 'absolute', top: 3, left: on ? 22 : 3, width: 19, height: 19, borderRadius: 999,
        background: '#fff', boxShadow: '0 1px 2px rgba(20,18,14,0.25)', transition: 'left 150ms var(--ease)',
      }} />
    </button>
  );
}

/**
 * A labelled control.
 *
 * Deliberately not a `<label>`. A label forwards any click inside it to the control it names,
 * which is right for a checkbox and wrong for anything that opens: choosing an option from
 * the dropdown inside one sent a second click to the trigger, and it reopened instantly.
 * Every control this wraps carries its own `aria-label`, so nothing is lost by using a plain
 * element and a great deal of confusing behaviour goes away.
 */
export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
      <span style={{ fontSize: 12, fontWeight: 500, color: 'var(--muted)' }}>{label}</span>
      {children}
      {hint && <span style={{ fontSize: 11, color: 'var(--faint)' }}>{hint}</span>}
    </div>
  );
}

/**
 * A row of columns.
 *
 * The class is here so a narrow window can stack it. A row whose columns are stated in pixels
 * cannot be made to fit a phone by any amount of squeezing — the only honest answers are to
 * scroll it or to stack it, and stacking keeps every figure readable.
 */
export function Row({ cols, children, style }: { cols: string; children: ReactNode; style?: React.CSSProperties }) {
  return <div className="row" style={{ display: 'grid', gridTemplateColumns: cols, gap: 16, alignItems: 'center', ...style }}>{children}</div>;
}
