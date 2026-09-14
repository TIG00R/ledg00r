import { intentionsFor, type Intention } from '@ledger/engine';
import { Icon } from './Icon';

/**
 * Why a thing is held, chosen where the thing is.
 *
 * Each answer carries its consequence underneath it, because the consequence is the whole
 * point of the question: a home owes nothing however much it is worth, a flat held to resell
 * owes on its full value, and a flat let out owes on nothing but the rent. Putting those
 * sentences in a help page instead would leave the owner choosing between three words.
 */
export function IntentionPicker({ kind, value, onChange, disabled, tone = 'var(--zakat)' }: {
  kind: string;
  value: Intention | null | undefined;
  onChange: (v: Intention) => void;
  disabled?: boolean;
  tone?: string;
}) {
  const options = intentionsFor(kind);
  return (
    <div role="radiogroup" aria-label="What this is held for"
         style={{ display: 'grid', gap: 10, gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))' }}>
      {options.map((o) => {
        const on = o.id === value;
        return (
          <button key={o.id} role="radio" aria-checked={on} disabled={disabled}
            onClick={() => onChange(o.id)}
            style={{
              textAlign: 'left', padding: '12px 14px', borderRadius: 'var(--r-card)', cursor: disabled ? 'default' : 'pointer',
              background: on ? `color-mix(in srgb, ${tone} var(--tint), transparent)` : 'var(--surface)',
              border: `1px solid ${on ? `color-mix(in srgb, ${tone} 40%, transparent)` : 'var(--hairline)'}`,
              opacity: disabled ? 0.6 : 1,
              transition: 'background 150ms var(--ease), border-color 150ms var(--ease)',
            }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{
                width: 15, height: 15, borderRadius: 999, flex: '0 0 15px',
                border: `1px solid ${on ? tone : 'var(--hairline-strong)'}`,
                background: on ? tone : 'transparent',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
                {on && <Icon name="check" size={10} color="var(--accent-ink)" motion="none" />}
              </span>
              <span style={{ fontSize: 13, fontWeight: 600, color: on ? tone : 'var(--ink)' }}>{o.label}</span>
            </span>
            <span style={{ display: 'block', fontSize: 11, color: 'var(--faint)', lineHeight: 1.5, marginTop: 7 }}>
              {o.blurb}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** The progress of a lunar year, as a bar with both calendars written on it. */
export function HawlBar({ hawl, tone = 'var(--zakat)' }: {
  hawl: {
    startOn: string; startHijriText: string; dueOn: string; dueHijriText: string;
    complete: boolean; daysRemaining: number; elapsedPct: number; yearsComplete: number;
  } | null;
  tone?: string;
}) {
  if (!hawl) {
    return (
      <div style={{ fontSize: 11, color: 'var(--faint)' }}>
        No lunar year is running — nothing here has passed nisab yet.
      </div>
    );
  }
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: 11 }}>
        <span>
          <span style={{ color: 'var(--muted)' }}>from </span>
          <span className="mono">{hawl.startOn}</span>
          <span style={{ display: 'block', color: 'var(--faint)' }}>{hawl.startHijriText} AH</span>
        </span>
        <span style={{ textAlign: 'right' }}>
          <span style={{ color: 'var(--muted)' }}>closes </span>
          <span className="mono">{hawl.dueOn}</span>
          <span style={{ display: 'block', color: 'var(--faint)' }}>{hawl.dueHijriText} AH</span>
        </span>
      </div>
      <div style={{ height: 7, borderRadius: 999, background: 'var(--switch-off)', margin: '8px 0 6px' }}>
        <span style={{
          display: 'block', width: `${hawl.elapsedPct}%`, height: '100%', borderRadius: 999,
          background: hawl.complete ? 'var(--positive)' : tone,
        }} />
      </div>
      <div style={{ fontSize: 11, color: 'var(--faint)' }}>
        {hawl.complete
          ? `${hawl.yearsComplete} full lunar ${hawl.yearsComplete === 1 ? 'year' : 'years'} completed · ${hawl.daysRemaining} days to the next anniversary`
          : `${hawl.elapsedPct.toFixed(1)}% elapsed · ${hawl.daysRemaining} days before the first year closes`}
      </div>
    </div>
  );
}
