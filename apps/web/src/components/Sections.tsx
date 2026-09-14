import { createContext, useContext, useEffect, type ReactNode } from 'react';
import { Icon, type IconName } from './Icon';
import { useMode } from './ModeBar';
import { useRemembered } from '../remember';
import { useLive } from '../Live';

/**
 * A screen's own sections, with editing as a state rather than a section.
 *
 * The earlier arrangement made Operate and Edit the two halves of every screen, which put a
 * verb where a noun belonged: the accounts and their movement log are two different things to
 * look at, and editing is something you do to whichever one you are looking at. So the tabs
 * name the things, and Edit sits to the right as a switch that applies to the section in
 * front of you.
 */
interface Ctx { tab: string; setTab: (id: string) => void }
const SectionCtx = createContext<Ctx | null>(null);

export function useSection(): Ctx {
  const ctx = useContext(SectionCtx);
  if (!ctx) throw new Error('useSection outside SectionProvider');
  return ctx;
}

export interface SectionDef {
  id: string;
  label: string;
  icon?: IconName;
  /** shown under the bar while this section is open */
  hint?: string;
  /** what Edit means here; absent means this section cannot be edited */
  editHint?: string;
}

/**
 * Which section of a screen was open, remembered per screen.
 *
 * Records and Accounts are two different things to look at, and coming back to the one you
 * were not looking at is the same annoyance as being thrown back to the overview. The screen
 * in the address names the memory, so each screen keeps its own answer.
 */
export function SectionProvider({ first, children }: { first: string; children: ReactNode }) {
  const screen = window.location.hash.replace(/^#\/?/, '').split('/')[0] || 'portfolio';
  const [tab, setTab] = useRemembered(`section.${screen}`, first);
  const { clear } = useLive();
  // a receipt belongs to the section it was earned in as much as to the screen
  const go = (id: string) => { if (id !== tab) clear(); setTab(id); };
  return <SectionCtx.Provider value={{ tab, setTab: go }}>{children}</SectionCtx.Provider>;
}

export function Sections({ sections }: { sections: SectionDef[] }) {
  const { tab, setTab } = useSection();
  const { mode, setMode } = useMode();
  const here = sections.find((s) => s.id === tab) ?? sections[0]!;

  // a remembered section that this screen no longer has would leave the bar pointing at one
  // thing and the screen drawing nothing
  useEffect(() => { if (here.id !== tab) setTab(here.id); }, [here.id, tab, setTab]);
  const editable = !!here.editHint;
  const editing = editable && mode === 'edit';

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', gap: 12, padding: '12px 16px',
      borderRadius: 'var(--r-card)',
      background: editing ? 'color-mix(in srgb, var(--gold) 8%, transparent)' : 'var(--surface)',
      border: `1px solid ${editing ? 'color-mix(in srgb, var(--gold) 30%, transparent)' : 'var(--hairline)'}`,
      transition: 'background 180ms var(--ease), border-color 180ms var(--ease)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', gap: 4, padding: 3, borderRadius: 'var(--r-sm)',
                      background: 'var(--raised)', border: '1px solid var(--hairline)' }}>
          {sections.map((s) => {
            const on = s.id === here.id;
            return (
              <button key={s.id} onClick={() => setTab(s.id)} aria-pressed={on}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 13,
                  fontWeight: 500, padding: '7px 14px', borderRadius: 6, cursor: 'pointer',
                  border: 'none',
                  background: on ? 'var(--control)' : 'transparent',
                  color: on ? 'var(--ink)' : 'var(--muted)',
                  boxShadow: on ? 'var(--shadow-sm)' : 'none',
                  transition: 'background 150ms var(--ease), color 150ms var(--ease)',
                }}>
                {s.icon && <Icon name={s.icon} size={14} />}
                {s.label}
              </button>
            );
          })}
        </div>

        <span style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.5, flex: 1, minWidth: 200 }}>
          {editing ? here.editHint : here.hint}
        </span>

        {/* Editing belongs to the section in front of you, so the switch sits with it and
            disappears where there is nothing to edit. Done finishes an edit, so it is the
            green every other finishing button is; Edit starts one, so it stays quiet. */}
        {editable && (
          <button className={editing ? 'btn go' : 'btn ghost'} aria-pressed={editing}
                  onClick={() => setMode(editing ? 'operate' : 'edit')}
                  style={{ fontSize: 13, padding: '7px 14px' }}>
            <Icon name={editing ? 'check' : 'edit'} size={14} />
            {editing ? 'Done' : 'Edit'}
          </button>
        )}
      </div>

      {editing && (
        <span className="chip" style={{ alignSelf: 'flex-start',
          background: 'color-mix(in srgb, var(--gold) 16%, transparent)', color: 'var(--gold)' }}>
          nothing here writes a movement
        </span>
      )}
    </div>
  );
}
