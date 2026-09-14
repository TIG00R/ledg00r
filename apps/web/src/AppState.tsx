import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import {
  compute, upcoming, toEgp, fromEgp, money as fmtMoney, balances as nodeBalances,
  valueHoldings, computedPositions,
  type Values, type Reminder, type UpcomingEvent, type Currency, type Dismissal,
  type Snapshot, type MarketState, type RecurringTemplate, type ZakatSettings, type Settings,
  type DataSet,
} from '@ledger/engine';
import { EMPTY_DATASET, EMPTY_MARKET } from './data/empty';
import { ledger } from './api';
import { useLive } from './Live';

/**
 * What a ledger may be opened with instead of nothing.
 *
 * Nothing in the shipped interface supplies one: a new ledger opens empty, and everything
 * after that is what its owner put there. The tests pass one in, because a screen written
 * against an empty grid proves nothing about how it draws a full one.
 */
export interface Demonstration {
  data: DataSet;
  market: MarketState;
  reminders: Reminder[];
  recurring: RecurringTemplate[];
}

/** What the screens offer before a ledger service has said otherwise. */
const FALLBACK_CURRENCIES = [
  { code: 'EGP', name: 'Egyptian pound', symbol: 'E£', minorUnits: 2, color: '#B37E00' },
  { code: 'USD', name: 'US dollar', symbol: '$', minorUnits: 2, color: '#3F7D4F' },
  { code: 'GBP', name: 'Pound sterling', symbol: '£', minorUnits: 2, color: '#6B4E9E' },
  { code: 'EUR', name: 'Euro', symbol: '€', minorUnits: 2, color: '#0086A8' },
];

/**
 * The outside world as last recorded, which the screens import directly.
 *
 * It starts with nothing in it and is filled by `market.read`. It is a mutable module object
 * rather than state because every screen values things against the same one; replacing it
 * would mean every screen holding its own copy of a rate.
 */
export const market: MarketState = { ...EMPTY_MARKET, fxRates: { ...EMPTY_MARKET.fxRates } };

export const DEFAULT_ZAKAT: ZakatSettings = {
  anniversaryMonth: 9, anniversaryDay: 1, basis: 'gold', silverPerG: 52, deductDebts: false,
};

interface Ctx {
  now: Date;
  /**
   * The dataset the screens read: empty, unless a ledger service has something to put in it.
   * Screens read this rather than importing anything, so an edit shows up the moment it is
   * saved.
   */
  data: DataSet;
  values: Values;
  asOf: string | null;
  setAsOf: (v: string | null) => void;
  theme: 'light' | 'dark';
  toggleTheme: () => void;
  /** the ledger's display currency — every headline total renders in it */
  display: Currency;
  setDisplay: (c: Currency) => void;
  /** EGP in, display currency out */
  d: (egp: number) => number;
  /** formatted in the display currency */
  dm: (egp: number, dp?: number) => string;
  reminders: Reminder[];
  setReminders: (r: Reminder[]) => void;
  events: UpcomingEvent[];
  /** amounts render as blocks when this is on — for screenshots and public places */
  privacy: boolean;
  setPrivacy: (v: boolean) => void;
  snapshot: Snapshot;
  recurring: RecurringTemplate[];
  setRecurring: (r: RecurringTemplate[]) => void;
  market: MarketState;
  /** every node's quantity today, opening figure plus recorded movements */
  balances: Record<string, number>;
  zakatSettings: ZakatSettings;
  setZakatSettings: (z: ZakatSettings) => void;
  dismissals: Dismissal[];
  /** silence one event; `until` is an ISO date, omitted for good */
  dismiss: (eventId: string, until?: string) => void;
  undismiss: (eventId: string) => void;
  /**
   * The currencies this ledger knows, in the order they are offered.
   *
   * One list, configured once, offered by every control that asks for a currency — so adding
   * one is how it reaches every dropdown rather than each screen carrying its own guess.
   */
  currencies: Array<{ code: string; name: string; symbol: string; minorUnits: number;
                      color: string; mark?: string }>;
  /** the constants that used to be buried in the markup */
  settings: Settings;
  setSettings: (patch: Partial<Settings>) => void;
  autoPay: Record<string, { on: boolean; fromNodeId: string }>;
  setAutoPay: (propertyId: string, patch: Partial<{ on: boolean; fromNodeId: string }>) => void;
}

const AppCtx = createContext<Ctx | null>(null);

export function AppProvider({ children, demo }: {
  children: React.ReactNode;
  /** only the tests pass one; the shipped interface opens empty */
  demo?: Demonstration;
}) {
  // a demonstration's rates go into the object every screen already imports
  if (demo) Object.assign(market, demo.market, { fxRates: { ...demo.market.fxRates } });
  const base = demo?.data ?? EMPTY_DATASET;
  const params = new URLSearchParams(window.location.search);
  const [asOf, setAsOf] = useState<string | null>(params.get('asof'));
  const [theme, setTheme] = useState<'light' | 'dark'>(
    () => (readStored('ledger.theme') as 'light' | 'dark') ?? 'dark');
  const [display, setDisplay] = useState<Currency>(() => readStored('ledger.currency') ?? 'EGP');
  const [reminders, setReminders] = useState<Reminder[]>(demo?.reminders ?? []);
  const [privacy, setPrivacy] = useState(() => readStored('ledger.privacy') === '1');
  const [recurring, setRecurring] = useState<RecurringTemplate[]>(demo?.recurring ?? []);
  const [zakatSettings, setZakatSettings] = useState<ZakatSettings>(DEFAULT_ZAKAT);
  const [dismissals, setDismissals] = useState<Dismissal[]>([]);
  const [settings, setSettingsState] = useState<Settings>(base.settings);
  /** installment plans the owner has asked the ledger to post on their due date */
  const [autoPay, setAutoPay] = useState<Record<string, { on: boolean; fromNodeId: string }>>({});

  // one clock for the whole app; it ticks so the header can show seconds
  const [now, setNow] = useState(() => (asOf ? new Date(`${asOf}T12:00:00`) : new Date()));
  useEffect(() => {
    if (asOf) { setNow(new Date(`${asOf}T12:00:00`)); return; }
    setNow(new Date());
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, [asOf]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    store('ledger.theme', theme);
  }, [theme]);
  useEffect(() => { store('ledger.currency', display); }, [display]);
  useEffect(() => {
    store('ledger.privacy', privacy ? '1' : '0');
    document.documentElement.dataset.privacy = privacy ? 'on' : 'off';
  }, [privacy]);


  /**
   * The ledger service, when there is one.
   *
   * Two reads, both re-run after every write. The balances say what has happened; the
   * catalogue says what exists — the accounts, the destinations, the sources, with the names
   * and marks they have been given. Without the second, renaming a destination would write
   * to the database and change nothing on screen, which is indistinguishable from a broken
   * button.
   *
   * With no service, both fall back to the fixture and the interface stays a complete,
   * explorable application.
   */
  const { live, version } = useLive();
  const [liveBalances, setLiveBalances] = useState<Record<string, number> | null>(null);
  const [catalogue, setCatalogue] = useState<any | null>(null);
  /** bumped when the outside world has been re-read, so the figures recompute */
  const [marketAt, setMarketAt] = useState(0);

  /**
   * The demonstration's reminders and standing charges belong to the demonstration.
   *
   * They are what the interface opens with when nothing is behind it. A real ledger keeps
   * its own — the service is asked for its reminders below — so the moment there is one,
   * these go, rather than a new ledger warning about a card fee nobody has.
   */
  useEffect(() => {
    if (!live) { setReminders(demo?.reminders ?? []); setRecurring(demo?.recurring ?? []); return; }
    setRecurring([]);
    // asked for rather than assumed, and a service that cannot answer leaves the ledger with
    // no reminders rather than with the demonstration's
    Promise.resolve((ledger as any)['reminders.list']?.({}) ?? [])
      .then((rows: Reminder[]) => setReminders(rows ?? []))
      .catch(() => setReminders([]));
  }, [live, version]);

  useEffect(() => {
    if (!live) { setLiveBalances(null); setCatalogue(null); return; }
    let cancelled = false;
    (ledger as any)['accounts.list']({ includeArchived: true })
      .then((rows: Array<{ id: string; balance: number }>) => {
        if (!cancelled) setLiveBalances(Object.fromEntries(rows.map((r) => [r.id, r.balance])));
      })
      .catch(() => { if (!cancelled) setLiveBalances(null); });
    (ledger as any)['catalogue.read']({})
      .then((c: unknown) => { if (!cancelled) setCatalogue(c); })
      .catch(() => { if (!cancelled) setCatalogue(null); });

    /**
     * The outside world, as the service last recorded it.
     *
     * Rates and prices are read from the ledger rather than from the fixture, so a figure
     * fetched from the source chosen under Prices — or typed in by hand — is the one every
     * screen values things at. It is written into the same object the screens already
     * import, because that object was never anything but the last known state of the
     * outside world: shipped with one, and now able to be told a newer one.
     */
    (ledger as any)['market.read']({})
      .then((m: any) => {
        if (cancelled || !m) return;
        Object.assign(market, {
          usdEgp: m.fxRates?.USD ?? market.usdEgp,
          goldPerG: m.prices?.gold_g ?? m.goldPerG ?? market.goldPerG,
          goldPerOz: m.goldPerOz ?? market.goldPerOz,
          fxRates: { ...market.fxRates, ...(m.fxRates ?? {}) },
          prices: { ...market.prices, ...(m.prices ?? {}) },
          pricesUpdatedAt: m.updatedAt ?? market.pricesUpdatedAt,
        });
        setMarketAt(Date.now());
      })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [live, version]);

  /**
   * The dataset the screens read.
   *
   * With no service behind them, that is nothing — an empty ledger, which is what a ledger
   * with no records in it is. It used to be a demonstration of invented money, which made
   * the first thing a new owner saw a set of accounts, a property plan and a net worth
   * belonging to nobody, all of which had to be cleared out before the ledger was theirs.
   *
   * With a service, it is the service — and where the service has nothing, so does the
   * screen.
   */
  const data = useMemo(() => {
    if (!catalogue) return base;
    return {
      ...base,
      transactions: [], installments: [], planRules: [], goldLots: [],
      orders: [], expenses: [], charity: [], debts: [],
      snapshot: { ...base.snapshot, cashEgp: 0, goldGramsOwn: 0, reEgp: 0,
                  paidByProperty: {}, totalByProperty: {} },
      institutions: catalogue.institutions.map((i: any) => ({ ...i, logo: i.logo ?? undefined })),
      // an archived account leaves the pickers and the lists; its movements stay in the log
      nodes: catalogue.nodes.filter((n: any) => !n.archived).map((n: any) => ({
        ...n, parentId: n.parentId ?? undefined, currency: n.currency ?? undefined,
        unit: n.unit ?? undefined, color: n.color ?? undefined,
        // both are columns on the node, so the service is the one that knows them
        valuation: n.valuation ?? 'face',
        priceKey: n.priceKey ?? undefined,
      })),
      categories: catalogue.categories
        .filter((c: any) => !c.archived)
        .map((c: any) => ({ ...c, icon: c.icon ?? undefined, note: c.note ?? undefined })),
      incomeSources: catalogue.incomeSources
        .filter((s2: any) => !s2.archived)
        .map((s2: any) => ({
          ...s2,
          dayOfMonth: s2.dayOfMonth === 'last' ? 'last' : s2.dayOfMonth ? Number(s2.dayOfMonth) : undefined,
          startDate: s2.startDate ?? undefined, endDate: s2.endDate ?? undefined,
          icon: s2.icon ?? undefined,
        })),
    } as DataSet;
  }, [catalogue]);

  // the figures only depend on the calendar day, so recompute per day rather than per tick
  const dayKey = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}`;
  /**
   * What things are worth.
   *
   * Without a ledger service the figures are worked forward from the opening snapshot, which
   * is the only thing the fixture supports. With one, they are read from what is actually
   * held — the same reading the service's own totals and the zakat base use, so the screens
   * cannot report a net worth the zakat calculation contradicts.
   */
  const values = useMemo(() => {
    const forecast = compute(data, market, now);
    if (!live || !liveBalances) return forecast;
    /**
     * What kind of thing an asset is.
     *
     * A property is an asset something is owed against — the contract balance hangs off it
     * as a liability of its own. That is read from the ledger's own nodes rather than from a
     * list of plans, because an empty ledger has no plans and a flat is still a flat.
     */
    const owedAgainst = new Set(data.nodes
      .filter((n) => n.kind === 'liability' && n.parentId)
      .map((n) => n.parentId));
    const kindOf = (n: (typeof data.nodes)[number]) =>
      (/car|vehicle|truck|bike/i.test(`${n.id} ${n.name}`) ? 'vehicle'
        : owedAgainst.has(n.id) ? 'property' : 'other');
    const institutions = new Set(data.institutions.map((i) => i.id));
    const h = valueHoldings(data.nodes, liveBalances, market, {
      positions: computedPositions(data.orders, market.prices),
      kindOf,
      isContract: (n) => !n.parentId || !institutions.has(n.parentId),
    });
    return {
      ...forecast,
      cash: h.cash, gold: h.metals, re: h.realEstate, car: h.vehicles,
      stocks: h.shares, total: h.total,
    };
  }, [dayKey, data, market, marketAt, live, liveBalances]); // eslint-disable-line react-hooks/exhaustive-deps
  const events = useMemo(
    () => upcoming(data, market, reminders, now,
                   { recurring, zakat: zakatSettings, dismissals }),
    [dayKey, reminders, data, market, marketAt, recurring, zakatSettings, dismissals]); // eslint-disable-line react-hooks/exhaustive-deps

  /** every node's live balance, opening figure plus the movements against it */
  const localBalances = useMemo(() => nodeBalances(data, now), [dayKey, data]); // eslint-disable-line react-hooks/exhaustive-deps
  const balances = liveBalances ?? localBalances;

  const d = (egp: number) => fromEgp(egp, display, market);
  const dm = (egp: number, dp = 0) => fmtMoney(d(egp), display, dp);

  return (
    <AppCtx.Provider value={{
      now, data, values, asOf, setAsOf, theme,
      toggleTheme: () => setTheme((t) => (t === 'dark' ? 'light' : 'dark')),
      display, setDisplay, d, dm, reminders, setReminders, events,
      privacy, setPrivacy, balances,
      zakatSettings, setZakatSettings,
      dismissals,
      dismiss: (eventId, until) =>
        setDismissals((xs) => [...xs.filter((x) => x.eventId !== eventId),
                               { eventId, until, on: new Date().toISOString().slice(0, 10) }]),
      undismiss: (eventId) => setDismissals((xs) => xs.filter((x) => x.eventId !== eventId)),
      currencies: catalogue?.currencies ?? FALLBACK_CURRENCIES,
      settings, setSettings: (patch) => setSettingsState((s2) => ({ ...s2, ...patch })),
      autoPay, setAutoPay: (id, patch) =>
        setAutoPay((a) => ({ ...a, [id]: { on: false, fromNodeId: base.settings.burnAccountId, ...a[id], ...patch } })),
      snapshot: data.snapshot,
      recurring, setRecurring, market: market,
    }}>
      {children}
    </AppCtx.Provider>
  );
}

function readStored(k: string): string | null {
  try { return localStorage.getItem(k); } catch { return null; }
}
function store(k: string, v: string) {
  try { localStorage.setItem(k, v); } catch { /* private mode */ }
}

export function useApp() {
  const ctx = useContext(AppCtx);
  if (!ctx) throw new Error('useApp outside AppProvider');
  return ctx;
}

export { toEgp };
