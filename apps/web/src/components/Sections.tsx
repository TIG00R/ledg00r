import { createContext, useContext, useEffect, type ReactNode } from 'react';
import { Icon, type IconName } from './Icon';
import { useRemembered } from '../remember';
import { useLive } from '../Live';

/**
 * A screen's own sections.
 *
 * The earlier arrangement made Operate and Edit the two halves of every screen, and put a
 * switch here that turned a whole section's tables into rows of pencils at once — a verb
 * standing where a noun belonged. Correcting a record is a gesture on the record now (double-
 * click it, press Enter with it focused, or press its pencil — see `RecordTable` and
 * `Manager`), so a screen's sections are only ever the things you can look at.
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
  /** a picture that stands where the icon would, for a section that has one of its own */
  art?: ReactNode;
  /** shown under the bar while this section is open */
  hint?: string;
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
  const here = sections.find((s) => s.id === tab) ?? sections[0]!;

  // a remembered section that this screen no longer has would leave the bar pointing at one
  // thing and the screen drawing nothing
  useEffect(() => { if (here.id !== tab) setTab(here.id); }, [here.id, tab, setTab]);

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', gap: 12, padding: '12px 16px',
      borderRadius: 'var(--r-card)', background: 'var(--surface)',
      border: '1px solid var(--hairline)',
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
                {s.art ?? (s.icon && <Icon name={s.icon} size={14} />)}
                {s.label}
              </button>
            );
          })}
        </div>

        <span style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.5, flex: 1, minWidth: 200 }}>
          {here.hint}
        </span>
      </div>
    </div>
  );
}
