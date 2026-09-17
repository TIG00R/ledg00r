import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import type { IconName } from './components/Icon';

/**
 * The app is a set of modules, not one fixed product. Somebody with no shares should
 * never see a Stocks tab, and turning one off hides its screen, its nav entry and its
 * cards — it never deletes the data behind it.
 */
export interface ModuleDef {
  id: string;
  label: string;
  icon: IconName;
  blurb: string;
  /** core modules cannot be switched off — without them there is no app */
  core?: boolean;
  screens: string[];
}

export const MODULES: ModuleDef[] = [
  { id: 'core', label: 'Portfolio and accounts', icon: 'portfolio', core: true,
    blurb: 'Net worth, the banks and their accounts, and these settings.',
    screens: ['portfolio', 'dashboards', 'accounts', 'assistant', 'debts', 'settings', 'settings-modules', 'settings-recurring', 'settings-appearance', 'settings-reminders',
              'settings-access', 'settings-currencies', 'settings-prices'] },
  { id: 'logs', label: 'Logs', icon: 'logs',
    blurb: 'Every write the ledger was asked for — what it was, what it touched, what came of it. The only place a change that moved no money is recorded, a restated balance among them.',
    screens: ['logs'] },
  { id: 'income', label: 'Income sources', icon: 'income',
    blurb: 'Where money comes from, scheduled or occasional, and what the forecast is allowed to assume.',
    screens: ['income'] },
  { id: 'flow', label: 'Money flow', icon: 'flow',
    blurb: 'The diagram of what came in, what moved between your own things, and what was actually spent.',
    screens: ['flow'] },
  { id: 'realestate', label: 'Assets', icon: 'assets',
    blurb: 'Properties under an installment plan, their schedules and their equity.',
    screens: ['realestate'] },
  { id: 'metals', label: 'Gold and silver', icon: 'gold',
    blurb: 'Metal held by weight, priced live, with its own movement ledger.',
    screens: ['gold'] },
  { id: 'stocks', label: 'Stock ledger', icon: 'stocks',
    blurb: 'Orders, derived positions, and price alerts.',
    screens: ['stocks'] },
  { id: 'expenses', label: 'Expenses', icon: 'expenses',
    blurb: 'What you spend, against destinations you define.',
    screens: ['expenses'] },
  { id: 'budgets', label: 'Budgets', icon: 'budgets',
    blurb: 'Ceilings over a month, a quarter or a year, each covering one destination or a pool of them — with a warning when one is passed, and the whole of it drawn over time.',
    screens: ['budgets'] },
  { id: 'giving', label: 'Zakat and Sadaqat', icon: 'zakat',
    blurb: 'What you give, and the zakat calculation it counts against — one obligation and the record of meeting it.',
    screens: ['giving'] },
  { id: 'calendar', label: 'Calendar', icon: 'calendar',
    blurb: 'Every dated thing in one month: installments, zakat, each asset\'s lunar year, warnings and standing charges — and a feed your own calendar can subscribe to.',
    screens: ['calendar'] },
];

const DEFAULT_ON = Object.fromEntries(MODULES.map((m) => [m.id, true]));

const Ctx = createContext<{
  enabled: Record<string, boolean>;
  toggle: (id: string, on: boolean) => void;
  isScreenOn: (screen: string) => boolean;
} | null>(null);

export function ModulesProvider({ children }: { children: React.ReactNode }) {
  const [enabled, setEnabled] = useState<Record<string, boolean>>(() => {
    try {
      const raw = localStorage.getItem('ledger.modules');
      return raw ? { ...DEFAULT_ON, ...JSON.parse(raw) } : DEFAULT_ON;
    } catch { return DEFAULT_ON; }
  });

  useEffect(() => {
    try { localStorage.setItem('ledger.modules', JSON.stringify(enabled)); } catch { /* private mode */ }
  }, [enabled]);

  const value = useMemo(() => ({
    enabled,
    toggle: (id: string, on: boolean) => {
      if (MODULES.find((m) => m.id === id)?.core) return;
      setEnabled((e) => ({ ...e, [id]: on }));
    },
    isScreenOn: (screen: string) =>
      MODULES.some((m) => m.screens.includes(screen) && (m.core || enabled[m.id])),
  }), [enabled]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useModules() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useModules outside ModulesProvider');
  return ctx;
}
