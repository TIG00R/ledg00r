import { useEffect, useState } from 'react';
import { intentionsFor, type Intention } from '@ledger/engine';
import { Icon } from './Icon';

/**
 * Why a thing is held, chosen where the thing is.
 *
 * Each answer carries its consequence underneath it, because the consequence is the whole
 * point of the question: a home owes nothing however much it is worth, a flat held to resell
 * owes on its full value, and a flat let out owes on nothing but the rent. Putting those
 * sentences in a help page instead would leave the owner choosing between three words.
 *
 * The choice is read-only until Edit is pressed. A radio that writes the moment it is
 * clicked is a click nobody can take back — the answer decides a lunar year, so it is
 * chosen, looked at, and only then saved. Nothing reaches `onChange` before Save does.
 */
export function IntentionPicker({ kind, value, onChange, disabled, tone = 'var(--zakat)' }: {
  kind: string;
  value: Intention | null | undefined;
  onChange: (v: Intention) => void;
  disabled?: boolean;
  tone?: string;
}) {
  const options = intentionsFor(kind);
  const current = options.find((o) => o.id === value) ?? null;
  const [editing, setEditing] = useState(false);
  const [pending, setPending] = useState<Intention | null>(value ?? null);

  // The record can change under an editor that has not touched anything yet — closed, it
  // simply follows; open, it keeps what the owner is in the middle of choosing.
  useEffect(() => { if (!editing) setPending(value ?? null); }, [value, editing]);

  if (!editing) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 180 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: current ? tone : 'var(--muted)' }}>
            {current ? current.label : 'Not set'}
          </div>
          {current && (
            <div style={{ fontSize: 11, color: 'var(--faint)', lineHeight: 1.5, marginTop: 3 }}>
              {current.blurb}
            </div>
          )}
        </div>
        <button className="btn quiet" onClick={() => { setPending(value ?? null); setEditing(true); }}
          disabled={disabled} aria-label="Edit what this is held for" title="Edit"
          style={{ padding: 7, border: 'none' }}>
          <Icon name="edit" size={14} />
        </button>
      </div>
    );
  }

  return (
    <div>
      <div role="radiogroup" aria-label="What this is held for"
           style={{ display: 'grid', gap: 10, gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))' }}>
        {options.map((o) => {
          const on = o.id === pending;
          return (
            <button key={o.id} role="radio" aria-checked={on}
              onClick={() => setPending(o.id)}
              style={{
                textAlign: 'left', padding: '12px 14px', borderRadius: 'var(--r-card)', cursor: 'pointer',
                background: on ? `color-mix(in srgb, ${tone} var(--tint), transparent)` : 'var(--surface)',
                border: `1px solid ${on ? `color-mix(in srgb, ${tone} 40%, transparent)` : 'var(--hairline)'}`,
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
      <span className="btn-pair" style={{ marginTop: 10, justifyContent: 'flex-start' }}>
        <button className="btn go sm" disabled={pending == null}
          onClick={() => { if (pending != null) onChange(pending); setEditing(false); }}>
          <Icon name="check" size={13} motion="none" /> Save
        </button>
        <button className="btn ghost sm" onClick={() => { setPending(value ?? null); setEditing(false); }}>
          <Icon name="close" size={13} motion="none" /> Cancel
        </button>
      </span>
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
          <span className="mono public">{hawl.startOn}</span>
          <span style={{ display: 'block', color: 'var(--faint)' }}>{hawl.startHijriText} AH</span>
        </span>
        <span style={{ textAlign: 'right' }}>
          <span style={{ color: 'var(--muted)' }}>closes </span>
          <span className="mono public">{hawl.dueOn}</span>
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
