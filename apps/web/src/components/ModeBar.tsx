import { createContext, useContext, useEffect } from 'react';
import { Icon } from './Icon';
import { useRemembered } from '../remember';

export type ViewMode = 'operate' | 'edit';

const Ctx = createContext<{ mode: ViewMode; setMode: (m: ViewMode) => void } | null>(null);

const isMode = (v: string): v is ViewMode => v === 'operate' || v === 'edit';

export function ModeProvider({ children }: { children: React.ReactNode }) {
  // one answer for the whole application: someone who is correcting records is correcting
  // them on every screen they move to, and a reload should not quietly put them back to
  // reading
  const [held, setHeld] = useRemembered('mode', 'operate', isMode);
  const mode = (isMode(held) ? held : 'operate') as ViewMode;
  const setMode = (m: ViewMode) => setHeld(m);

  // The stylesheet gives editing more room than reading, which it can only do if it knows
  // which one is happening.
  useEffect(() => {
    document.documentElement.dataset.mode = mode;
    return () => { document.documentElement.dataset.mode = 'operate'; };
  }, [mode]);

  return <Ctx.Provider value={{ mode, setMode }}>{children}</Ctx.Provider>;
}

export function useMode() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useMode outside ModeProvider');
  return ctx;
}

/**
 * Two modes, because they are two different acts — and, now, a narrower thing than they used
 * to be.
 *
 * Operating records something that happened — money left an account and arrived somewhere,
 * and the ledger gains a movement it can show you later. Editing corrects a record that
 * writes no movement — a balance restated, a name, a colour. Keeping them apart is what stops
 * a correction from looking like a transaction, and it used to do a second job as well: on
 * almost every screen, flipping to Edit was also the only way to reach a row's pencil at all.
 *
 * That second job is gone. A row opens for correction by being double-clicked, by Enter with
 * it focused, or by its own pencil — see `RecordTable` and `Manager` — whichever mode a
 * screen is in, because a table has no reason to know or care which act somebody came to do.
 * What is left of this mode is only the handful of screens where Operate and Edit are
 * genuinely two different things to be doing at once: Accounts and Charity, where recording a
 * movement (Move money, Give something) sits beside correcting records that write none, and
 * the aside panel and the "no movement is recorded" chip below say which one is in front of
 * you.
 */
export function ModeBar({ operateHint, editHint }: { operateHint: string; editHint: string }) {
  const { mode, setMode } = useMode();
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 14, padding: '12px 16px',
      borderRadius: 'var(--r-card)', flexWrap: 'wrap',
      background: mode === 'edit' ? 'color-mix(in srgb, var(--gold) 8%, transparent)' : 'var(--surface)',
      border: `1px solid ${mode === 'edit' ? 'color-mix(in srgb, var(--gold) 30%, transparent)' : 'var(--hairline)'}`,
    }}>
      <div style={{ display: 'flex', gap: 4, padding: 3, borderRadius: 'var(--r-sm)', background: 'var(--raised)', border: '1px solid var(--hairline)' }}>
        {([['operate', 'Operate', 'flow'], ['edit', 'Edit', 'edit']] as const).map(([id, label, icon]) => (
          <button key={id} onClick={() => setMode(id)} aria-pressed={mode === id}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 13, fontWeight: 500,
              padding: '7px 13px', borderRadius: 6, cursor: 'pointer', border: 'none',
              background: mode === id ? 'var(--control)' : 'transparent',
              color: mode === id ? 'var(--ink)' : 'var(--muted)',
              boxShadow: mode === id ? 'var(--shadow-sm)' : 'none',
            }}>
            <Icon name={icon} size={14} />
            {label}
          </button>
        ))}
      </div>
      <span style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.5, flex: 1, minWidth: 240 }}>
        {mode === 'operate' ? operateHint : editHint}
      </span>
      {mode === 'edit' && (
        <span className="chip" style={{
          background: 'color-mix(in srgb, var(--gold) 16%, transparent)', color: 'var(--gold)',
        }}>no movement is recorded</span>
      )}
    </div>
  );
}

/** A control that is only interactive while editing, and says so. */
export function Editable({ children, label, onClick }: {
  children: React.ReactNode; label: string; onClick?: () => void;
}) {
  const { mode } = useMode();
  if (mode !== 'edit') return <>{children}</>;
  return (
    <button onClick={onClick} aria-label={label}
      style={{ position: 'relative', background: 'transparent', border: 'none', padding: 0,
               cursor: 'pointer', display: 'block', lineHeight: 0 }}>
      {children}
      <span style={{
        position: 'absolute', right: -5, bottom: -5, width: 16, height: 16, borderRadius: 999,
        background: 'var(--gold)', display: 'flex', alignItems: 'center', justifyContent: 'center',
        boxShadow: '0 1px 3px rgba(0,0,0,0.3)',
      }}>
        <Icon name="edit" size={9} color="#fff" strokeWidth={2.4} />
      </span>
    </button>
  );
}
