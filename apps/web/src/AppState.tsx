import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import {
  compute, upcoming, toEgp, fromEgp, money as fmtMoney, balances as nodeBalances,
  valueHoldings, computedPositions,
  type Values, type Reminder, type UpcomingEvent, type Currency, type Dismissal,
  type Snapshot, type MarketState, type RecurringTemplate, type ZakatSettings, type Settings,
  type DataSet, type Order,
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
  /** what the service says is coming up; null until it has said, or without a service */
  const [liveEvents, setLiveEvents] = useState<UpcomingEvent[] | null>(null);
  /** bumped when something has been silenced, so the list is asked for again */
  const [dismissedAt, setDismissedAt] = useState(0);
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
  /**
   * The share orders, as the service holds them.
   *
   * The book is worked out from the orders rather than from a node — `computedPositions`
   * reads them, and so does the accrual — so a dataset with none in it values every holding
   * at nothing. This used to be left empty against a live service, which meant the Stocks
   * screen and the portfolio's share of it both read zero however many orders were logged.
   */
  const [liveOrders, setLiveOrders] = useState<Order[] | null>(null);
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
    // asked for rather than assumed, and a service that cannot answer leaves the ledger with
    // no reminders rather than with the demonstration's
    Promise.resolve((ledger as any)['reminders.list']?.({}) ?? [])
      .then((rows: Reminder[]) => setReminders(rows ?? []))
      .catch(() => setReminders([]));
    /**
     * The standing charges are the service's too.
     *
     * They used to be emptied and never filled, which left the Recurring screen blank on a
     * ledger that had several and gave a reminder about a standing charge nothing to name.
     */
    Promise.resolve((ledger as any)['recurring.list']?.({}) ?? [])
      .then((rows: any[]) => setRecurring((rows ?? []).map((r) => ({
        id: r.id, name: r.name,
        fromNodeId: r.fromNodeId ?? undefined, toNodeId: r.toNodeId ?? undefined,
        amount: r.amount, currency: r.currency, cadence: r.cadence,
        dayOfMonth: r.dayOfMonth ?? undefined,
        startDate: r.startDate ?? undefined, endDate: r.endDate ?? undefined,
        categoryId: r.categoryId ?? undefined, enabled: r.enabled,
        note: r.note ?? undefined, internal: r.internal,
      })) as RecurringTemplate[]))
      .catch(() => setRecurring([]));
  }, [live, version]);

  useEffect(() => {
    if (!live) { setLiveBalances(null); setCatalogue(null); setLiveOrders(null); return; }
    let cancelled = false;
    /**
     * The order log, newest first, renumbered oldest-first.
     *
     * `orders.list` drops `seq` on the way out and sorts by it descending, but the accrual
     * walks the orders in `seq` order to work out what a position cost. Handing them back
     * their original order is what keeps an average buy price from depending on which way
     * the list happened to arrive.
     */
    // asked for the way every other read here is: a service that cannot answer leaves the
    // orders empty rather than throwing out of the effect and taking the balances with it
    Promise.resolve((ledger as any)['orders.list']?.({ limit: 500 }) ?? [])
      .then((rows: any[]) => {
        if (cancelled) return;
        const n = rows.length;
        setLiveOrders(rows.map((o, i) => ({
          id: o.id, seq: n - 1 - i, date: o.date, time: o.time ?? undefined,
          ticker: o.ticker, side: o.side as 'BUY' | 'SELL',
          shares: o.shares, price: o.price, total: o.total,
          status: o.status as 'pending' | 'executed' | 'cancelled',
          note: o.note ?? '',
        })));
      })
      .catch(() => { if (!cancelled) setLiveOrders([]); });
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
      orders: liveOrders ?? [], expenses: [], charity: [], debts: [],
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
        // what kind of thing it is, as the ledger reads it — not as a name suggests
        assetKind: n.assetKind ?? undefined,
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
  }, [catalogue, liveOrders]);

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
     * The ledger states it — the assets screen writes it down when the thing is added, and
     * the service derives it for anything older — so it is read, not guessed. The guess was
     * a name matched against /car|vehicle/ plus "a property is whatever something is owed
     * against", which put a car called "BMW" and a flat paid for outright into neither
     * pile: the portfolio counted them in the total and drew nothing for them.
     *
     * The old reading stays as the fallback for a ledger the service has not classified.
     */
    const owedAgainst = new Set(data.nodes
      .filter((n) => n.kind === 'liability' && n.parentId)
      .map((n) => n.parentId));
    /*
     * A debt, either way it points, is named by the record that opened it.
     *
     * It matters twice. Money lent out is an asset node and was read as a chattel, so a loan
     * to a friend was drawn in the pile with the machines. Money borrowed hangs off no
     * institution, and a liability hanging off nothing reads as the balance of a purchase
     * plan — which is never subtracted — when what it is is owed in full today.
     */
    const isDebtNode = (n: (typeof data.nodes)[number]) => n.assetKind === 'debt'
      || /^debt-/.test(n.id);
    const kindOf = (n: (typeof data.nodes)[number]) =>
      (isDebtNode(n) ? 'debt'
        : n.assetKind
        ?? (/car|vehicle|truck|bike/i.test(`${n.id} ${n.name}`) ? 'vehicle'
          : owedAgainst.has(n.id) ? 'property' : 'other'));
    const institutions = new Set(data.institutions.map((i) => i.id));
    const h = valueHoldings(data.nodes, liveBalances, market, {
      positions: computedPositions(data.orders, market.prices),
      kindOf,
      isContract: (n) => !isDebtNode(n) && (!n.parentId || !institutions.has(n.parentId)),
    });
    /**
     * The share book is the positions and the wallet behind them.
     *
     * `valueHoldings` counts the brokerage wallet as cash, because that is what it is and
     * what the zakat base has to see. The portfolio is splitting holdings by what they are
     * for, though, and every other screen already treats the wallet as the other half of the
     * book — the Stocks ring draws it beside the positions, the flow screen groups it with
     * them, the accounts screen leaves it out because it is not held at a bank. Left in the
     * cash slice it was the one screen saying otherwise, and the stocks slice read as the
     * positions alone while the forecast the same screen falls back to counted both.
     */
    return {
      ...forecast,
      cash: h.cash - h.brokerageCash, gold: h.metals, re: h.realEstate, car: h.vehicles,
      stocks: h.shares + h.brokerageCash, other: h.other, debt: h.lent, total: h.total,
      /*
       * The weight, read from what is held rather than from the opening snapshot. A ledger
       * kept by the service has no snapshot to roll forward, so the grams beside the gold
       * slice came from a figure that is nought by construction and every ledger read "0.0 g"
       * however much metal was in it.
       */
      accrual: { ...forecast.accrual, goldGrams: h.goldGrams },
    };
  }, [dayKey, data, market, marketAt, live, liveBalances]); // eslint-disable-line react-hooks/exhaustive-deps
  /**
   * What is coming up.
   *
   * Worked out here when there is no service, because the fixture is the only thing that
   * knows its own plans. With a service it is asked for, because the browser is not given
   * the schedules: the dataset above carries no installments and no plan rules, so a
   * reminder about a property had nothing to attach to and nothing was ever surfaced. The
   * service holds the plans, the reminders and the dismissals, and answers with the same
   * engine this would have run.
   */
  const localEvents = useMemo(
    () => upcoming(data, market, reminders, now,
                   { recurring, zakat: zakatSettings, dismissals }),
    [dayKey, reminders, data, market, marketAt, recurring, zakatSettings, dismissals]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!live) { setLiveEvents(null); return; }
    let cancelled = false;
    Promise.resolve((ledger as any)['upcoming.list']?.({}) ?? null)
      .then((rows: any[] | null) => {
        if (cancelled) return;
        setLiveEvents(rows == null ? null : rows.map((e) => ({
          id: e.id, date: new Date(`${e.date}T12:00:00`), daysAway: e.daysAway,
          kind: e.kind, label: e.label, detail: e.detail ?? undefined,
          amount: e.amount ?? undefined, currency: e.currency ?? undefined,
          due: e.due, overdue: e.overdue ?? undefined,
          reminderLead: e.reminderLead ?? undefined, internal: e.internal ?? undefined,
        })) as UpcomingEvent[]);
      })
      .catch(() => { if (!cancelled) setLiveEvents(null); });
    return () => { cancelled = true; };
  }, [live, version, dismissedAt, dayKey]);

  /**
   * A dismissal reaches the service, and until the answer comes back it is honoured here —
   * otherwise the row the owner has just closed reappears for as long as the round trip takes.
   */
  const events = useMemo(() => {
    if (!liveEvents) return localEvents;
    const hidden = new Set(dismissals
      .filter((x) => !x.until || new Date(`${x.until}T23:59:59`) >= now)
      .map((x) => x.eventId));
    return liveEvents.filter((e) => !hidden.has(e.id));
  }, [liveEvents, localEvents, dismissals, dayKey]); // eslint-disable-line react-hooks/exhaustive-deps

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
      // silencing is recorded where the events are worked out, so it survives a reload
      dismiss: (eventId, until) => {
        setDismissals((xs) => [...xs.filter((x) => x.eventId !== eventId),
                               { eventId, until, on: new Date().toISOString().slice(0, 10) }]);
        if (!live) return;
        Promise.resolve((ledger as any)['upcoming.dismiss']?.({ eventId, until }))
          .then(() => setDismissedAt((n) => n + 1))
          .catch(() => undefined);
      },
      undismiss: (eventId) => {
        setDismissals((xs) => xs.filter((x) => x.eventId !== eventId));
        if (!live) return;
        Promise.resolve((ledger as any)['upcoming.dismiss']?.({ eventId, undo: true }))
          .then(() => setDismissedAt((n) => n + 1))
          .catch(() => undefined);
      },
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
