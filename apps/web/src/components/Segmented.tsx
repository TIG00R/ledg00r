import { Icon, type IconName } from './Icon';

export interface Segment<T extends string> { id: T; label: string; icon?: IconName; tone?: string }

/** The same control the mode bar uses, so a switch always looks like a switch. */
export function Segmented<T extends string>({ value, options, onChange, ariaLabel }: {
  value: T; options: Array<Segment<T>>; onChange: (v: T) => void; ariaLabel: string;
}) {
  return (
    <div role="group" aria-label={ariaLabel}
         style={{ display: 'inline-flex', gap: 4, padding: 3, borderRadius: 'var(--r-sm)', background: 'var(--raised)', border: '1px solid var(--hairline)' }}>
      {options.map((o) => {
        const on = o.id === value;
        const tone = o.tone ?? 'var(--ink)';
        return (
          <button key={o.id} onClick={() => onChange(o.id)} aria-pressed={on}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 13, fontWeight: 500,
              padding: '7px 14px', borderRadius: 'calc(var(--r-sm) * 0.75)', cursor: 'pointer', border: 'none',
              background: on ? 'var(--control)' : 'transparent',
              color: on ? tone : 'var(--muted)',
              boxShadow: on ? 'var(--shadow-sm)' : 'none',
              transition: 'background 150ms var(--ease), color 150ms var(--ease)',
            }}>
            {o.icon && <Icon name={o.icon} size={14} color={on ? tone : 'var(--muted)'} />}
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
