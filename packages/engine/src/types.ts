/** Shared domain types. The engine never touches I/O, the DOM, or the clock. */

export type Currency = string; // ISO-ish code; the app seeds USD, EGP, GBP

export type NodeKind = 'cash' | 'asset' | 'liability' | 'external';
export type Valuation = 'face' | 'fx' | 'live_price' | 'fixed';

export interface Institution {
  id: string;
  name: string;
  shortCode: string;
  country: string;
  color: string;
  logo?: string;
  archived?: boolean;
}

export interface LedgerNode {
  id: string;
  kind: NodeKind;
  name: string;
  /** institution for a cash node; the owning asset for a liability node */
  parentId?: string;
  currency?: Currency;
  /** 'g' for gold, 'share' for a position, undefined for a lump */
  unit?: string;
  valuation: Valuation;
  /** which price to look up: 'gold_24k', 'usd_egp', a ticker */
  priceKey?: string;
  /**
   * What kind of thing it is: 'property', 'vehicle', 'equipment', 'other'.
   *
   * Stated by the ledger rather than guessed from the name, and absent on anything that is
   * not an asset. A reader that guessed put a car called "BMW" in no pile at all.
   */
  assetKind?: string;
  openingQty: number;
  color?: string;
  /** the node's own mark, where it has one: an asset's, a broker's wallet's */
  icon?: string;
  archived?: boolean;
}

export type MovementKind =
  | 'income' | 'expense' | 'transfer' | 'exchange' | 'installment' | 'purchase' | 'sale';

export interface Leg {
  id: string;
  seq: number;
  fromNodeId?: string;
  toNodeId?: string;
  qtyFrom?: number;
  qtyTo?: number;
  /** the rate that actually applied, frozen at the time — never today's rate */
  rateApplied?: number;
  feeQty?: number;
  feeNodeId?: string;
  categoryId?: string;
}

export interface Transaction {
  id: string;
  seq: number;
  date: string; // YYYY-MM-DD, local calendar
  kind: MovementKind;
  note?: string;
  automatic?: boolean;
  legs: Leg[];
}

export type Cadence = 'weekly' | 'monthly' | 'quarterly' | 'annually' | 'one_off' | 'irregular';

export interface IncomeSource {
  id: string;
  name: string;
  amount: number | null;      // null when it varies
  currency: Currency;
  cadence: Cadence;
  dayOfMonth?: number | 'last';
  startDate?: string;
  endDate?: string;
  toNodeId: string;
  /** irregular sources are recorded when they land and never forecast */
  scheduled: boolean;
  icon?: string;
}

export interface PlanRule {
  id: string;
  propertyId: string;
  seq: number;
  kind: 'every_n_months' | 'one_off';
  intervalMonths?: number;
  amountEgp: number;
  firstDueMonth: string;      // YYYY-MM
  dueDayKind: 'day' | 'last';
  dueDayNum?: number;
  count: number;
  note: string;
  generatesEquity: boolean;
}

export interface Installment {
  id: string;
  seq: number;
  propertyId: string;
  monthLabel: string;         // "Sep 2026"
  dueDayKind: 'day' | 'last';
  dueDayNum?: number;
  amountEgp: number;
  balanceEgp: number | null;
  note: string;
}

export interface GoldLot {
  id: string;
  seq: number;
  dateText: string;           // round-trips verbatim: "Oct 23, 2025" or "Feb 2026"
  datePrecision: 'day' | 'month';
  grams: number;
  pricePerGram: number;
  totalEgp: number;
  usdRate: number;
  usdPaid: number;
  own: boolean;
  direction: 'buy' | 'sell';
  settledAccountId?: string;
}

export interface Order {
  id: string;
  seq: number;
  date: string;
  time?: string;
  ticker: string;
  side: 'BUY' | 'SELL';
  orderType?: string;
  shares: number;
  price: number;
  total: number;
  /**
   * What the broker charged for the order itself, once — never per share. It is added to
   * what a buy costs and taken off what a sale brings in, which is why every reading of an
   * order's cash goes through `orderCash` rather than multiplying shares by price again.
   */
  fee?: number;
  status: 'pending' | 'executed' | 'cancelled';
  /** why these shares are held, for zakat — stated on the order, null until one is stated */
  intention?: 'personal' | 'investment' | null;
  note: string;
  claudeVerdict?: string;
}

export interface ExpenseRecord {
  id: string;
  seq: number;
  date: string;
  amount: number;
  currency: Currency;
  fxAtEntry: number;
  egpAmount: number;
  categoryId: string;
  accountId?: string;
  place: string;
  note: string;
}

export interface CharityRecord {
  id: string; seq: number; date: string; egp: number; usd: number | null;
  categoryId: string; note: string; isZakat?: boolean;
  /**
   * What was actually given, in the currency it was given in.
   *
   * `egp` and `usd` predate a ledger that holds more than two currencies, and a gift in
   * pounds sterling read through them is either counted as Egyptian pounds or lost. These
   * are what the service records; the older pair stay for a dataset that has no service
   * behind it.
   */
  amount?: number; currency?: Currency;
  accountId?: string;
}

export interface Category {
  id: string; domain: 'expense' | 'charity' | 'brainstorm'; name: string;
  color: string; icon?: string;
  /** the account this kind of spending usually comes out of; absent means the ledger's own default */
  accountId?: string;
}

export interface Snapshot {
  label: string;              // "May 2026"
  effectiveFrom: string;      // derived, with the documented 1 May 2026 fallback
  cashEgp: number;
  goldGramsOwn: number;
  reEgp: number;
  paidByProperty: Record<string, number>;
  totalByProperty: Record<string, number>;
}

export interface Settings {
  budgetEgp: number;
  carPurchaseUsd: number;
  goldTargetG: number;
  stockInitEgp: number;
  incomeContractEnd: string;
  goldKarat: string;
  goldUseBuyPrice: boolean;
  goldLocalPremium: number;
  incomeAccountId: string;
  burnAccountId: string;
  forecast: { rateYr: number; goldYr: number; reYr: number; stkYr: number; horizon: number };
}

export interface MarketState {
  usdEgp: number;
  goldPerG: number;
  goldPerOz: number | null;
  prices: Record<string, number>;
  fxRates: Record<Currency, number>;
  rateLive: boolean;
  goldLive: boolean;
  pricesUpdatedAt?: string;
}

/**
 * A debt, as the calculators need to see it.
 *
 * Only what bears on a figure: which way it points, what is left on it, and whether it is
 * still live. Everything else about a debt belongs to the screen that shows it.
 */
export interface DebtView {
  id: string;
  direction: 'lent' | 'borrowed';
  counterparty: string;
  outstanding: number;
  currency: Currency;
  dueOn?: string;
  settledAt?: string;
  writtenOffAt?: string;
}

export interface DataSet {
  institutions: Institution[];
  nodes: LedgerNode[];
  transactions: Transaction[];
  incomeSources: IncomeSource[];
  installments: Installment[];
  planRules: PlanRule[];
  goldLots: GoldLot[];
  orders: Order[];
  expenses: ExpenseRecord[];
  charity: CharityRecord[];
  categories: Category[];
  snapshot: Snapshot;
  settings: Settings;
  /** money lent out and money owed; absent in a dataset that predates them */
  debts?: DebtView[];
}
