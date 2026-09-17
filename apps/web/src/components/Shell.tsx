import { useEffect, useState } from 'react';
import { Icon, VIEW_TONE, type IconName } from './Icon';
import { Select } from './Select';
import { useLive } from '../Live';
import { useApp, market } from '../AppState';
import { fmt, money } from '@ledger/engine';
import { useModules } from '../Modules';
import { Ledg00rLogo, Ledg00rMascot } from './Ledg00r';

export interface NavItem {
  id: string; label: string;
  /** absent only where the mascot stands in its place — Ledg00r's own screen */
  icon?: IconName;
  /** the one section that is a who rather than a what, and so wears his own face */
  mascot?: true;
}

export const NAV: NavItem[] = [
  { id: 'portfolio', label: 'Portfolio', icon: 'portfolio' },
  { id: 'dashboards', label: 'Statistics', icon: 'dashboards' },
  { id: 'accounts', label: 'Accounts', icon: 'accounts' },
  { id: 'income', label: 'Income', icon: 'income' },
  { id: 'flow', label: 'Money flow', icon: 'flow' },
  { id: 'realestate', label: 'Assets', icon: 'assets' },
  { id: 'gold', label: 'Gold and silver', icon: 'gold' },
  { id: 'stocks', label: 'Stocks', icon: 'stocks' },
  { id: 'expenses', label: 'Expenses', icon: 'expenses' },
  { id: 'budgets', label: 'Budgets', icon: 'budgets' },
  { id: 'debts', label: 'Debts', icon: 'debts' },
  { id: 'giving', label: 'Zakat and Sadaqat', icon: 'zakat' },
  { id: 'calendar', label: 'Calendar', icon: 'calendar' },
  { id: 'logs', label: 'Logs', icon: 'logs' },
  { id: 'assistant', label: 'Ledg00r', mascot: true },
  { id: 'settings', label: 'Settings', icon: 'settings' },
];

/**
 * How wide the window is, as the two decisions that actually depend on it.
 *
 * `rail` is where the sidebar's labels stop fitting beside the work; `mobile` is where it
 * stops fitting at all and has to become something you open. Two booleans rather than a
 * breakpoint scattered through the screens.
 */
export function useViewport(): { width: number; rail: boolean; mobile: boolean } {
  const [width, setWidth] = useState(() => window.innerWidth);
  useEffect(() => {
    const on = () => setWidth(window.innerWidth);
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);
  return { width, rail: width < 1180, mobile: width < 760 };
}

export function Sidebar({ active, onNavigate, collapsed, onToggle, overlay, open, onClose }: {
  active: string; onNavigate: (id: string) => void; collapsed: boolean; onToggle: () => void;
  /** on a narrow window the sidebar is something you open, not something that is there */
  overlay?: boolean; open?: boolean; onClose?: () => void;
}) {
  const { isScreenOn } = useModules();
  const items = NAV.filter((n) => isScreenOn(n.id));

  // Escape closes the drawer, the same way it closes every other thing that opens over the page.
  useEffect(() => {
    if (!overlay || !open) return;
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose?.(); };
    document.addEventListener('keydown', esc);
    return () => document.removeEventListener('keydown', esc);
  }, [overlay, open, onClose]);

  if (overlay && !open) return null;

  const nav = (
    <nav aria-label="Sections" style={{
      width: collapsed && !overlay ? 72 : 224, flex: `0 0 ${collapsed && !overlay ? 72 : 224}px`,
      background: 'var(--surface)', borderRight: '1px solid var(--hairline)',
      padding: collapsed && !overlay ? '20px 14px' : '20px 16px',
      display: 'flex', flexDirection: 'column',
      gap: 22, minHeight: '100vh',
      // opened over the page it is the page's height, and scrolls if the list is longer
      height: overlay ? '100vh' : undefined, overflowY: overlay ? 'auto' : undefined,
      position: overlay ? 'fixed' : 'sticky', top: 0, left: 0, zIndex: overlay ? 61 : undefined,
      boxShadow: overlay ? 'var(--shadow-lg)' : undefined,
      alignSelf: 'flex-start',
      transition: 'width 200ms var(--ease)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '0 4px' }}>
        {/* The logo is one picture, wordmark included. Collapsed there is no width for a
            word, so what is left standing is the mascot rather than a logo squeezed to
            forty pixels and unreadable. */}
        {!collapsed || overlay
          ? <Ledg00rLogo width={140} />
          : <Ledg00rMascot size={30} alt="Ledg00r" />}
        <button onClick={overlay ? () => onClose?.() : onToggle}
          aria-label={overlay ? 'Close the menu' : collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          style={{ marginLeft: 'auto', background: 'transparent', border: 'none', cursor: 'pointer',
                   padding: 4, color: 'var(--faint)', transform: collapsed ? 'rotate(180deg)' : 'none' }}>
          <Icon name="chevron" size={16} />
        </button>
      </div>

      <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
        {items.map((n) => {
          const on = n.id === active;
          return (
            <li key={n.id}>
              <button onClick={() => { onNavigate(n.id); onClose?.(); }} aria-current={on ? 'page' : undefined}
                title={collapsed ? n.label : undefined}
                style={{
                  width: '100%', display: 'flex', alignItems: 'center', gap: 12,
                  padding: collapsed ? 10 : '9px 12px', borderRadius: 'var(--r-sm)',
                  border: 'none', cursor: 'pointer', textAlign: 'left',
                  justifyContent: collapsed ? 'center' : 'flex-start',
                  background: on ? 'var(--raised)' : 'transparent',
                  color: on ? 'var(--ink)' : 'var(--muted)',
                  fontSize: 14, fontWeight: 500, boxShadow: on ? 'var(--inner-top)' : 'none',
                  transition: 'background 150ms var(--ease), color 150ms var(--ease)',
                }}>
                {n.mascot ? <Ledg00rMascot size={18} alt="" /> : n.icon ? <Icon name={n.icon} /> : null}
                {(!collapsed || overlay) && n.label}
              </button>
            </li>
          );
        })}
      </ul>

    </nav>
  );

  if (!overlay) return nav;
  return (
    <>
      <div onClick={onClose} aria-hidden="true" style={{
        position: 'fixed', inset: 0, zIndex: 60,
        background: 'color-mix(in srgb, var(--canvas) 62%, transparent)',
        backdropFilter: 'blur(2px)',
      }} />
      {nav}
    </>
  );
}

export function TopBar({ title, screen, onRefresh, onNavigate, onMenu }: {
  title: string; screen: string; onRefresh: () => void; onNavigate: (id: string) => void;
  /** given only when the sidebar has folded away and needs a way to be opened */
  onMenu?: () => void;
}) {
  const tone = VIEW_TONE[screen.split('-')[0]!] ?? VIEW_TONE.portfolio!;
  const { now, asOf, setAsOf, theme, toggleTheme, events, privacy, setPrivacy } = useApp();
  const { live } = useLive();
  const dueCount = events.filter((e) => e.due).length;

  return (
    <header className="topbar" style={{
      position: 'sticky', top: 0, zIndex: 20, display: 'flex', alignItems: 'center', gap: 14,
      padding: '12px 24px', background: 'color-mix(in srgb, var(--canvas) 88%, transparent)',
      backdropFilter: 'blur(12px)', borderBottom: '1px solid var(--hairline)', flexWrap: 'wrap',
    }}>
      {onMenu && (
        <button className="btn ghost" onClick={onMenu} aria-label="Open the menu"
                style={{ padding: '8px 10px' }}>
          <Icon name="menu" size={16} />
        </button>
      )}
      {/* Ledg00r's own screen is headed by Ledg00r, not by a picture of a speech bubble.
          The drawing brings its own ground, so it wants no tinted square behind it. */}
      {screen.split('-')[0] === 'assistant' ? (
        <Ledg00rMascot size={30} alt="" />
      ) : (
        <span style={{
          width: 30, height: 30, borderRadius: 9, flex: '0 0 30px',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: `color-mix(in srgb, ${tone.color} 14%, transparent)`,
        }}>
          <Icon name={tone.icon} size={17} color={tone.color} />
        </span>
      )}
      <h1 style={{ margin: 0, fontSize: 18, fontWeight: 600, letterSpacing: '-0.01em' }}>{title}</h1>
            {asOf && <button className="btn ghost" onClick={() => setAsOf(null)}>Back to today</button>}
      {/* Reading works from the fixtures with no service behind the screen, but nothing can be
          written — and a write button that quietly does nothing reads as a broken button. */}
      {!live && (
        <span title="Start it with: npm run dev:api" style={{
          display: 'inline-flex', alignItems: 'center', gap: 7, padding: '5px 10px',
          borderRadius: 999, fontSize: 11, color: 'var(--gold)',
          background: 'color-mix(in srgb, var(--gold) 12%, transparent)',
          border: '1px solid color-mix(in srgb, var(--gold) 30%, transparent)',
        }}>
          <Icon name="warn" size={12} color="var(--gold)" />
          Sample data — nothing can be saved
        </span>
      )}

      <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 14 }}>
        <Clock now={now} />
        <button className="btn ghost" onClick={() => setPrivacy(!privacy)}
                aria-label={privacy ? 'Show amounts' : 'Hide amounts'}
                aria-pressed={privacy} style={{ padding: '8px 10px' }}>
          <Icon name={privacy ? 'eyeoff' : 'eye'} size={15}
                color={privacy ? 'var(--gold)' : 'currentColor'} />
        </button>
        <NotificationBell dueCount={dueCount} onNavigate={onNavigate} />
        <button className="btn ghost" onClick={toggleTheme} aria-label="Switch theme" style={{ padding: '8px 10px' }}>
          <Icon name={theme === 'dark' ? 'sun' : 'moon'} size={15} />
        </button>
        <button className="btn ghost" onClick={onRefresh} style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
          <Icon name="refresh" size={14} /> Refresh
        </button>
      </div>
    </header>
  );
}

/**
 * The bell, and what is behind it.
 *
 * A badge that counts things you cannot see is only half a notification — the count says
 * something is waiting without saying what, and sending it to Settings answers a question
 * nobody asked. So the bell opens what is actually due, right where it is.
 */
function NotificationBell({ dueCount, onNavigate }: {
  dueCount: number; onNavigate: (id: string) => void;
}) {
  const { events, dismiss } = useApp();
  const [open, setOpen] = useState(false);
  const { mobile } = useViewport();

  // Escape closes it, and so does a click anywhere else — the same way every other
  // thing that opens over the page behaves.
  useEffect(() => {
    if (!open) return;
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    const away = (e: MouseEvent) => {
      if (!(e.target as HTMLElement | null)?.closest?.('[data-bell]')) setOpen(false);
    };
    document.addEventListener('keydown', esc);
    document.addEventListener('mousedown', away);
    return () => {
      document.removeEventListener('keydown', esc);
      document.removeEventListener('mousedown', away);
    };
  }, [open]);

  // What is waiting on you comes before what is merely ahead.
  const ranked = [...events].sort((a, b) =>
    Number(!!b.overdue) - Number(!!a.overdue) || Number(b.due) - Number(a.due) || a.daysAway - b.daysAway);
  const shown = ranked.slice(0, 8);
  const hidden = ranked.length - shown.length;
  const amountOf = (e: (typeof events)[number]) => {
    // an event states the currency it is in, and there is no account it was exchanged into —
    // so it is read in its own currency rather than restated in the reader's
    const cur = e.currency ?? 'EGP';
    return money(e.amount ?? 0, cur, cur === 'EGP' ? 0 : 2);
  };

  return (
    <div data-bell style={{ position: 'relative' }}>
      <button className="btn ghost" onClick={() => setOpen((o) => !o)} aria-label="Notifications"
        aria-expanded={open} aria-haspopup="true"
        style={{ position: 'relative', padding: '8px 10px' }}>
        <Icon name="bell" size={15} color={dueCount > 0 ? 'var(--gold)' : 'currentColor'} />
        {dueCount > 0 && (
          <span aria-label={`${dueCount} due`} style={{
            position: 'absolute', top: 2, right: 2, minWidth: 15, height: 15, padding: '0 3px',
            borderRadius: 999, background: 'var(--negative)', color: '#fff',
            fontSize: 9, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>{dueCount}</span>
        )}
      </button>

      {open && (
        <div role="dialog" aria-label="Notifications" style={{
          // hung under the bell where there is room for it, and pinned to the window
          // where there is not — 340px anchored to a bell near the right edge of a
          // narrow window lands off the left of the screen.
          ...(mobile
            ? { position: 'fixed' as const, top: 64, left: 12, right: 12, width: 'auto' }
            : { position: 'absolute' as const, top: 'calc(100% + 8px)', right: 0, width: 340 }),
          zIndex: 40, maxWidth: 'calc(100vw - 24px)', maxHeight: 440, overflowY: 'auto',
          background: 'var(--surface)', border: '1px solid var(--hairline)',
          borderRadius: 'var(--r-sm)', boxShadow: 'var(--shadow-lg)', padding: 12,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
            <h2 className="ov" style={{ margin: 0 }}>Coming up</h2>
            {dueCount > 0 && (
              <span style={{ fontSize: 11, color: 'var(--negative)' }}>{dueCount} due</span>
            )}
            <button onClick={() => { setOpen(false); onNavigate('settings'); }}
              style={{ marginLeft: 'auto', background: 'transparent', border: 'none', cursor: 'pointer',
                       color: 'var(--faint)', fontSize: 11, padding: 0 }}>
              reminders
            </button>
          </div>

          {shown.length === 0 ? (
            <p style={{ margin: 0, fontSize: 12, color: 'var(--muted)' }}>
              Nothing due in the next four months.
            </p>
          ) : (
            <ul style={{ listStyle: 'none', margin: 0, padding: 0,
                         display: 'flex', flexDirection: 'column', gap: 8 }}>
              {shown.map((e) => (
                <li key={e.id} style={{
                  display: 'flex', alignItems: 'flex-start', gap: 10, paddingBottom: 8,
                  borderBottom: '1px solid var(--hairline)',
                }}>
                  <span style={{
                    width: 26, height: 26, borderRadius: 7, flex: '0 0 26px',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    background: e.due ? 'color-mix(in srgb, var(--negative) 14%, transparent)' : 'var(--raised)',
                    color: e.due ? 'var(--negative)' : 'var(--faint)',
                  }}>
                    <Icon name={e.kind === 'zakat' ? 'zakat' : e.kind === 'stock' ? 'stocks'
                              : e.kind === 'sadaqah' ? 'charity' : e.kind === 'income' ? 'income'
                              : e.kind === 'recurring' ? 'refresh'
                              // a ceiling passed is a warning, not a building
                              : e.kind === 'budget' ? 'warn' : 'building'} size={14} />
                  </span>
                  <button onClick={() => { setOpen(false); onNavigate('calendar'); }}
                    style={{ minWidth: 0, flex: 1, textAlign: 'left', padding: 0, cursor: 'pointer',
                             background: 'transparent', border: 'none', color: 'inherit' }}>
                    <div style={{ fontSize: 12, fontWeight: 500 }}>{e.label}</div>
                    <div style={{ fontSize: 11, color: e.overdue ? 'var(--negative)' : 'var(--faint)' }}>
                      {/* A ceiling is not late and not coming: it is a state the period is
                          already in, so what matters is how much of the period is left. */}
                      {e.kind === 'budget'
                        ? (e.daysAway === 0 ? 'the last day of this period'
                            : `${e.daysAway} day${e.daysAway === 1 ? '' : 's'} of this period left`)
                        : e.overdue ? `${-e.daysAway} days late`
                        : e.daysAway === 0 ? 'today' : `in ${e.daysAway} days`}
                      {e.reminderLead ? ` · ${e.reminderLead}` : ''}
                    </div>
                  </button>
                  {e.amount != null && (
                    <span className="mono" style={{ fontSize: 12,
                      color: e.kind === 'income' ? 'var(--positive)'
                           : e.internal ? 'var(--muted)' : 'var(--negative)' }}>
                      {e.kind === 'income' ? '+' : e.internal ? '' : '−'}{amountOf(e)}
                    </span>
                  )}
                  {(e.kind === 'stock' || e.kind === 'budget' || e.overdue) && (
                    <button className="btn quiet" aria-label={`Dismiss ${e.label}`}
                            title="Dismiss until tomorrow"
                            onClick={() => dismiss(e.id, isoTomorrow())}
                            style={{ padding: 3, border: 'none', color: 'var(--faint)' }}>
                      <Icon name="close" size={12} />
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}

          <button onClick={() => { setOpen(false); onNavigate('calendar'); }}
            style={{ width: '100%', marginTop: 10, padding: '7px 0', fontSize: 11, cursor: 'pointer',
                     color: 'var(--muted)', background: 'transparent', border: 'none' }}>
            {hidden > 0 ? `${hidden} more in the calendar` : 'Open the calendar'}
          </button>
        </div>
      )}
    </div>
  );
}

function Clock({ now }: { now: Date }) {
  return (
    <div style={{ textAlign: 'right' }}>
      <div className="mono" style={{ fontSize: 14, fontWeight: 500, letterSpacing: '0.02em' }}>
        {now.toLocaleTimeString('en-US', { hour12: false })}
      </div>
      <div style={{ fontSize: 11, color: 'var(--faint)' }}>
        {now.toLocaleDateString('en-US', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })}
      </div>
    </div>
  );
}

/** Market rates — the outside world, kept in its own table away from anything owned. */
export function MarketPanel() {
  const rows: Array<[string, string, string]> = [
    ['USD / EGP', market.usdEgp.toFixed(4), 'live'],
    ['GBP / EGP', (market.fxRates.GBP ?? 0).toFixed(4), 'cross'],
    ['EUR / EGP', (market.fxRates.EUR ?? 0).toFixed(4), 'cross'],
    ['Gold 24k / g', fmt(market.goldPerG), 'iSagha'],
    ['Gold / troy oz', money(market.goldPerOz ?? 0, 'USD'), 'spot'],
  ];
  return (
    <section className="panel" aria-label="Market rates" style={{ padding: 16 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 10 }}>
        <h2 className="ov" style={{ margin: 0 }}>Market</h2>
        <span style={{ marginLeft: 'auto', fontSize: 10, color: 'var(--faint)' }}>11:35</span>
      </div>
      <table>
        <tbody>
          {rows.map(([label, value, src]) => (
            <tr key={label}>
              <td style={{ padding: '7px 0', border: 'none', fontSize: 12, color: 'var(--muted)' }}>{label}</td>
              <td className="mono" style={{ padding: '7px 0', border: 'none', fontSize: 13, fontWeight: 500 }}>{value}</td>
              <td style={{ padding: '7px 0 7px 10px', border: 'none', fontSize: 10, color: 'var(--faint)', textAlign: 'right' }}>{src}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

/** What is coming, and what a reminder has decided you should already be looking at. */
export function UpcomingPanel({ onNavigate }: { onNavigate: (id: string) => void }) {
  const { events, dismiss } = useApp();
  // an event states the currency it is in; showing 62 dollars as 62 pounds would be a lie
  const amountOf = (e: (typeof events)[number]) => {
    // an event states the currency it is in, and there is no account it was exchanged into —
    // so it is read in its own currency rather than restated in the reader's
    const cur = e.currency ?? 'EGP';
    return money(e.amount ?? 0, cur, cur === 'EGP' ? 0 : 2);
  };
  const [all, setAll] = useState(false);
  const shown = all ? events : events.slice(0, 5);
  const hidden = events.length - shown.length;
  return (
    <section className="panel" aria-label="Upcoming" style={{ padding: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <h2 className="ov" style={{ margin: 0 }}>Coming up</h2>
        <button onClick={() => onNavigate('settings')}
          style={{ marginLeft: 'auto', background: 'transparent', border: 'none', cursor: 'pointer',
                   color: 'var(--faint)', fontSize: 11, padding: 0 }}>
          reminders
        </button>
      </div>
      {shown.length === 0 ? (
        <p style={{ margin: 0, fontSize: 12, color: 'var(--muted)' }}>Nothing due in the next four months.</p>
      ) : (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
          {shown.map((e) => (
            <li key={e.id} style={{
              display: 'flex', alignItems: 'flex-start', gap: 10, paddingBottom: 10,
              borderBottom: '1px solid var(--hairline)',
            }}>
              <span style={{
                width: 26, height: 26, borderRadius: 7, flex: '0 0 26px',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                background: e.due ? 'color-mix(in srgb, var(--negative) 14%, transparent)' : 'var(--raised)',
                color: e.due ? 'var(--negative)' : 'var(--faint)',
              }}>
                <Icon name={e.kind === 'zakat' ? 'zakat' : e.kind === 'stock' ? 'stocks'
                          : e.kind === 'sadaqah' ? 'charity' : e.kind === 'income' ? 'income'
                          : e.kind === 'recurring' ? 'refresh'
                              // a ceiling passed is a warning, not a building
                              : e.kind === 'budget' ? 'warn' : 'building'} size={14} />
              </span>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontSize: 12, fontWeight: 500 }}>{e.label}</div>
                <div style={{ fontSize: 11, color: e.overdue ? 'var(--negative)' : 'var(--faint)' }}>
                  {/* A ceiling is not late and not coming: it is a state the period is
                      already in, so what matters is how much of the period is left. */}
                  {e.kind === 'budget'
                    ? (e.daysAway === 0 ? 'the last day of this period'
                        : `${e.daysAway} day${e.daysAway === 1 ? '' : 's'} of this period left`)
                    : e.overdue ? `${-e.daysAway} days late`
                    : e.daysAway === 0 ? 'today' : `in ${e.daysAway} days`}
                  {e.reminderLead ? ` · ${e.reminderLead}` : ''}
                </div>
              </div>
              {e.amount != null && (
                <span className="mono" style={{ fontSize: 12,
                  color: e.kind === 'income' ? 'var(--positive)'
                       : e.internal ? 'var(--muted)' : 'var(--negative)' }}>
                  {e.kind === 'income' ? '+' : e.internal ? '' : '−'}{amountOf(e)}
                </span>
              )}
              {/* A price alert has no date to expire on, so it needs a way to be answered. */}
              {(e.kind === 'stock' || e.kind === 'budget' || e.overdue) && (
                <button className="btn quiet" aria-label={`Dismiss ${e.label}`}
                        title="Dismiss until tomorrow"
                        onClick={() => dismiss(e.id, isoTomorrow())}
                        style={{ padding: 3, border: 'none', color: 'var(--faint)' }}>
                  <Icon name="close" size={12} />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {(hidden > 0 || all) && (
        <button onClick={() => setAll((a) => !a)}
          style={{ width: '100%', marginTop: 10, padding: '7px 0', fontSize: 11, cursor: 'pointer',
                   color: 'var(--muted)', background: 'transparent', border: 'none' }}>
          {all ? 'Show fewer' : `${hidden} more`}
        </button>
      )}
    </section>
  );
}

function isoTomorrow(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
}
