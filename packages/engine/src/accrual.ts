import type { DataSet, MarketState, Installment, GoldLot, Order } from './types.js';
import {
  parseMonthLabel, parseLotDate, installmentDueDate, monthsSinceSnapshot,
  daysInMonth, monthKey, daysUntil,
} from './dates.js';

export interface Accrual {
  asOf: Date;
  snapshotAt: Date;
  rate: number;
  months: number;
  income: number;
  burn: number; burnLogged: number; burnBaseline: number;
  charity: number;
  goldBuyEgp: number; goldBuyG: number;
  instTotal: number; instMaint: number;
  instPaid: Installment[];
  cash: number;
  paidByProperty: Record<string, number>;
  reEgp: number;
  goldGrams: number;
  netDelta: number;
}

export interface Values {
  asOf: Date;
  rate: number;
  goldPerG: number;
  cash: number;
  gold: number;
  re: number;
  car: number;
  stocks: number;
  /** everything owned that is none of the above — a machine, a thing, an asset kept as "other" */
  other: number;
  /** money lent out and still owed back to you */
  debt: number;
  total: number;
  accrual: Accrual;
}

/** A note matching this is an expense, never equity (F-047). */
const MAINTENANCE = /maintenance|service|fee/i;
export const isPrincipal = (note: string) => !MAINTENANCE.test(note ?? '');

/**
 * Income accrued since the snapshot.
 * Scheduled sources only — irregular ones are recorded when they land and are never
 * projected. Each source counts only for the months it was actually running, which is
 * what makes an ending contract or a mid-period raise fall out of the data rather than
 * needing a constant edited by hand.
 *
 * Like F-041 this converts at the CURRENT rate for the whole elapsed period, not a
 * historical average.
 */
export function incomeSinceSnapshot(d: DataSet, m: MarketState, snapshotAt: Date, now: Date): number {
  const months = monthsSinceSnapshot(snapshotAt, now);
  if (months <= 0) return 0;
  let perMonthUsd = 0;
  for (const s of d.incomeSources) {
    if (!s.scheduled || s.amount == null) continue;
    const started = s.startDate ? new Date(s.startDate + 'T00:00:00') : snapshotAt;
    const ended = s.endDate ? new Date(s.endDate + 'T23:59:59') : null;
    if (started > now) continue;
    if (ended && ended < snapshotAt) continue;
    const perMonth =
      s.cadence === 'monthly' ? s.amount :
      s.cadence === 'quarterly' ? s.amount / 3 :
      s.cadence === 'annually' ? s.amount / 12 :
      s.cadence === 'weekly' ? s.amount * 52 / 12 : 0;
    const rate = s.currency === 'EGP' ? 1 : (m.fxRates[s.currency] ?? m.usdEgp);
    perMonthUsd += perMonth * rate;
  }
  return perMonthUsd * months;
}

/**
 * Living burn, month by month.
 * A month with any logged expense uses the logged total — even if that total is 5 EGP —
 * and only an empty month falls back to the budget baseline (F-042). The current month's
 * baseline is prorated by `day / daysInMonth`, which is deliberately not the same
 * fraction the income walk uses.
 */
export function burnSinceSnapshot(d: DataSet, snapshotAt: Date, now: Date) {
  const byMonth = new Map<string, number>();
  for (const e of d.expenses) {
    const dt = new Date(e.date + 'T12:00:00');
    if (dt < snapshotAt || dt > now) continue;
    byMonth.set(monthKey(dt), (byMonth.get(monthKey(dt)) ?? 0) + e.egpAmount);
  }
  let total = 0, logged = 0, baseline = 0;
  const cur = new Date(snapshotAt.getFullYear(), snapshotAt.getMonth(), 1);
  while (cur <= now) {
    const key = monthKey(cur);
    const isCurrentMonth = cur.getFullYear() === now.getFullYear() && cur.getMonth() === now.getMonth();
    const loggedThisMonth = byMonth.get(key);
    if (loggedThisMonth != null && loggedThisMonth !== 0) {
      total += loggedThisMonth; logged += loggedThisMonth;
    } else {
      const share = isCurrentMonth
        ? d.settings.budgetEgp * (now.getDate() / daysInMonth(now.getFullYear(), now.getMonth()))
        : d.settings.budgetEgp;
      total += share; baseline += share;
    }
    cur.setMonth(cur.getMonth() + 1);
  }
  return { total, logged, baseline };
}

export function charitySinceSnapshot(d: DataSet, m: MarketState, snapshotAt: Date, now: Date): number {
  let sum = 0;
  for (const c of d.charity) {
    const dt = new Date(c.date + 'T12:00:00');
    if (dt < snapshotAt || dt > now) continue;
    sum += c.egp != null ? c.egp : (c.usd ?? 0) * m.usdEgp;
  }
  return sum;
}

/** Own lots only. A sale subtracts; the friend's lots never count either way. */
export function goldMovedSinceSnapshot(lots: GoldLot[], snapshotAt: Date, now: Date) {
  let grams = 0, egp = 0;
  for (const lot of lots) {
    if (!lot.own) continue;
    const { date } = parseLotDate(lot.dateText);
    if (date < snapshotAt || date > now) continue;
    const sign = lot.direction === 'sell' ? -1 : 1;
    grams += sign * lot.grams;
    egp += sign * lot.totalEgp;
  }
  return { grams, egp };
}

/** Installments whose due date has passed, in [snapshot, now) — F-048. */
export function installmentsPaidSince(list: Installment[], snapshotAt: Date, now: Date): Installment[] {
  return list.filter((i) => {
    const due = installmentDueDate(i.monthLabel, i.dueDayKind, i.dueDayNum);
    return due != null && due >= snapshotAt && due < now;
  });
}

export function nextInstallment(list: Installment[], now: Date, propertyId?: string): Installment | null {
  const future = list
    .filter((i) => !propertyId || i.propertyId === propertyId)
    .map((i) => ({ i, due: installmentDueDate(i.monthLabel, i.dueDayKind, i.dueDayNum) }))
    .filter((x) => x.due != null && x.due >= now)
    .sort((a, b) => a.due!.getTime() - b.due!.getTime());
  return future[0]?.i ?? null;
}

export function accrue(d: DataSet, m: MarketState, now: Date): Accrual {
  const snapshotAt = parseMonthLabel(d.snapshot.label);
  const months = monthsSinceSnapshot(snapshotAt, now);

  const income = incomeSinceSnapshot(d, m, snapshotAt, now);
  const burn = burnSinceSnapshot(d, snapshotAt, now);
  const charity = charitySinceSnapshot(d, m, snapshotAt, now);
  const gold = goldMovedSinceSnapshot(d.goldLots, snapshotAt, now);
  const instPaid = installmentsPaidSince(d.installments, snapshotAt, now);

  let instTotal = 0, instMaint = 0;
  const paidByProperty: Record<string, number> = { ...d.snapshot.paidByProperty };
  for (const i of instPaid) {
    instTotal += i.amountEgp;
    if (!isPrincipal(i.note)) instMaint += i.amountEgp;
    // A paid installment is money that went into the property, whether it bought a share of
    // it or not — a maintenance charge still counts towards what the property is worth, the
    // same as the opening/down payment does. `instMaint` still tracks how much of that went
    // on upkeep rather than equity, for whoever wants that split read back separately.
    const cap = d.snapshot.totalByProperty[i.propertyId] ?? Infinity;
    paidByProperty[i.propertyId] = Math.min(cap, (paidByProperty[i.propertyId] ?? 0) + i.amountEgp);
  }

  // Cash is floored at zero: an overdraft stays invisible, exactly as F-049 has it.
  const cash = Math.max(0, d.snapshot.cashEgp + income - burn.total - charity - instTotal - gold.egp);
  const reEgp = Object.values(paidByProperty).reduce((a, b) => a + b, 0);
  const goldGrams = d.snapshot.goldGramsOwn + gold.grams;

  return {
    asOf: now, snapshotAt, rate: m.usdEgp, months,
    income, burn: burn.total, burnLogged: burn.logged, burnBaseline: burn.baseline,
    charity, goldBuyEgp: gold.egp, goldBuyG: gold.grams,
    instTotal, instMaint, instPaid,
    cash, paidByProperty, reEgp, goldGrams,
    // gold purchases are excluded: they convert cash into another asset (F-049)
    netDelta: income - burn.total - charity - instTotal,
  };
}

/**
 * One order's effect on a running {shares, cost} position — a buy adds weight and cost, a
 * sale takes weight away at whatever the average cost was the instant before it, and takes
 * that same average times its own shares off the cost. `computedPositions` and `avgCostBefore`
 * both walk orders this way, from the same function, so a position and a sale's own arithmetic
 * can never disagree about what a share cost.
 */
function stepPosition(p: { shares: number; cost: number }, o: Order): { shares: number; cost: number } {
  if (o.side === 'BUY') {
    return { shares: p.shares + o.shares, cost: p.cost + orderCash(o) };
  }
  const avg = p.shares ? p.cost / p.shares : 0;
  return { shares: p.shares - o.shares, cost: p.cost - Math.round(avg * o.shares) };
}

/**
 * What an order actually moves through the wallet.
 *
 * The broker's charge belongs to the order as a whole, not to each share in it, so it is
 * added once to what a buy costs and taken once off what a sale brings in. A buy's cost of
 * carry is therefore part of what the shares cost — the fee is money spent to hold them —
 * and a sale is measured against what arrived, not against the headline price. Every reading
 * of an order's cash goes through here so the position, the wallet and the realised figure
 * can never disagree about what a fee did.
 */
export function orderCash(o: Order): number {
  const gross = o.total || Math.round(o.shares * o.price);
  const fee = o.fee ?? 0;
  return o.side === 'BUY' ? gross + fee : Math.max(0, gross - fee);
}

/** Positions from executed orders only, average cost, walked in stored order (implicit note 9). */
export function computedPositions(orders: Order[], prices: Record<string, number>) {
  const pos = new Map<string, { shares: number; cost: number }>();
  for (const o of [...orders].sort((a, b) => a.seq - b.seq)) {
    if (o.status !== 'executed') continue;
    pos.set(o.ticker, stepPosition(pos.get(o.ticker) ?? { shares: 0, cost: 0 }, o));
  }
  return [...pos.entries()]
    .filter(([, p]) => p.shares > 0)
    .map(([ticker, p]) => {
      const avgBuy = p.cost / p.shares;
      const price = prices[ticker] ?? avgBuy;
      return { ticker, shares: p.shares, cost: p.cost, avgBuy, price, value: p.shares * price };
    });
}

/**
 * The weighted average cost of every share of one ticker held immediately before a given
 * order — the same walk `computedPositions` runs, stopped one order short, over every
 * executed order with an earlier seq. Used to work out what a sale earned against the whole
 * position it was sold from, never one lot of it.
 */
export function avgCostBefore(orders: Order[], ticker: string, beforeSeq: number): { shares: number; avgBuy: number } {
  let p = { shares: 0, cost: 0 };
  for (const o of [...orders].sort((a, b) => a.seq - b.seq)) {
    if (o.status !== 'executed' || o.ticker !== ticker || o.seq >= beforeSeq) continue;
    p = stepPosition(p, o);
  }
  return { shares: p.shares, avgBuy: p.shares > 0 ? p.cost / p.shares : 0 };
}

/**
 * What a sale actually earned, against the average cost of the shares it sold — written once,
 * at the moment of the sale, and never recomputed afterwards: a buy made later must not reach
 * back and change what a past sale made. `pct` is null rather than a divide-by-zero when
 * nothing was held to have cost anything, which only happens selling from an empty position.
 */
export function realizedOnSale(avgBuy: number, shares: number, saleTotal: number): { pnl: number; pct: number | null } {
  const costOfSold = Math.round(avgBuy * shares);
  const pnl = saleTotal - costOfSold;
  return { pnl, pct: costOfSold !== 0 ? (pnl / costOfSold) * 100 : null };
}

export function brokerageCash(d: DataSet): number {
  let cash = d.settings.stockInitEgp;
  for (const o of d.orders) {
    if (o.status !== 'executed') continue;
    cash += o.side === 'BUY' ? -orderCash(o) : orderCash(o);
  }
  return cash;
}

export function compute(d: DataSet, m: MarketState, now: Date): Values {
  const a = accrue(d, m, now);
  const positions = computedPositions(d.orders, m.prices);
  const stocks = positions.reduce((s, p) => s + p.value, 0) + brokerageCash(d);
  const gold = a.goldGrams * m.goldPerG;
  const car = d.settings.carPurchaseUsd * m.usdEgp;
  const total = a.cash + gold + a.reEgp + car + stocks;
  return {
    asOf: now, rate: m.usdEgp, goldPerG: m.goldPerG,
    // the forecast works forward from a snapshot, which knows the four piles it was written
    // with and nothing else — anything else only exists where a ledger is being read
    cash: a.cash, gold, re: a.reEgp, car, stocks, other: 0, debt: 0, total, accrual: a,
  };
}

export { daysUntil, installmentDueDate };
