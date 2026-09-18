import { eq } from 'drizzle-orm';
import { schema as t, allBalances as nodeBalances, type Db } from '@ledger/db';
import { compute, type DataSet, type MarketState, type Values } from '@ledger/engine';

/**
 * From rows to the shape the engine already speaks.
 *
 * The calculators were written before there was a database and take a plain dataset. Rather
 * than rewrite them against SQL — which would put the arithmetic somewhere it cannot be
 * tested without a database — the rows are assembled back into that shape here. It is one
 * pass over tables that are small by nature: a person has tens of accounts, not millions.
 */
/**
 * What an untouched ledger holds.
 *
 * The snapshot's label is the month it is being read in, so the health check reports nought
 * months of rolling forward rather than dividing by a month that never happened.
 */
const EMPTY_SETTINGS: DataSet['settings'] = {
  budgetEgp: 0, carPurchaseUsd: 0, goldTargetG: 0, stockInitEgp: 0,
  incomeContractEnd: '', goldKarat: '24', goldUseBuyPrice: false, goldLocalPremium: 0,
  incomeAccountId: '', burnAccountId: '',
  forecast: { rateYr: 0, goldYr: 0, reYr: 0, stkYr: 0, horizon: 0 },
};

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
                'July', 'August', 'September', 'October', 'November', 'December'];

function emptySnapshot(now: Date): DataSet['snapshot'] {
  const iso = now.toISOString().slice(0, 10);
  return {
    label: `${MONTHS[now.getUTCMonth()]} ${now.getUTCFullYear()}`,
    effectiveFrom: iso,
    cashEgp: 0, goldGramsOwn: 0, reEgp: 0,
    paidByProperty: {}, totalByProperty: {},
  };
}

export function buildDataset(db: Db, now: Date): { data: DataSet; market: MarketState; values: Values } {
  // A ledger that has never closed a month has no snapshot, and one that has never been
  // through Settings has no settings row. Neither is an error — it is what an empty ledger
  // looks like — so both fall back rather than arriving undefined at a calculator that has
  // every right to assume they are there.
  const settings = { ...EMPTY_SETTINGS, ...(readPref<object>(db, 'settings') ?? {}) } as DataSet['settings'];
  const snapshot = { ...emptySnapshot(now), ...(readPref<object>(db, 'snapshot') ?? {}) } as DataSet['snapshot'];

  const data: DataSet = {
    institutions: db.select().from(t.institutions).all().map((i) => ({
      id: i.id, name: i.name, shortCode: i.shortCode, country: i.country,
      color: i.color, logo: i.logo ?? undefined, archived: i.archived,
    })),
    nodes: db.select().from(t.nodes).all().map((n) => ({
      id: n.id, kind: n.kind, name: n.name, parentId: n.parentId ?? undefined,
      currency: n.currency ?? undefined, unit: n.unit ?? undefined,
      valuation: n.valuation, priceKey: n.priceKey ?? undefined,
      openingQty: n.openingQty, color: n.color ?? undefined, archived: n.archived,
    })),
    transactions: assembleTransactions(db),
    incomeSources: db.select().from(t.incomeSources).all().map((s) => ({
      id: s.id, name: s.name, amount: s.amount, currency: s.currency,
      cadence: s.cadence as any,
      dayOfMonth: s.dayOfMonth === 'last' ? 'last' : s.dayOfMonth ? Number(s.dayOfMonth) : undefined,
      startDate: s.startDate ?? undefined, endDate: s.endDate ?? undefined,
      toNodeId: s.toNodeId, scheduled: s.scheduled, icon: s.icon ?? undefined,
    })),
    installments: db.select().from(t.installments).all().map((i) => ({
      id: i.id, propertyId: i.propertyId, monthLabel: i.monthLabel,
      dueDayKind: i.dueDayKind, dueDayNum: i.dueDayNum ?? undefined,
      amountEgp: i.amountEgp, note: i.note,
    })) as DataSet['installments'],
    planRules: db.select().from(t.planRules).all().map((r) => ({
      id: r.id, propertyId: r.propertyId, seq: r.seq, kind: r.kind,
      intervalMonths: r.intervalMonths ?? undefined, amountEgp: r.amountEgp,
      firstDueMonth: r.firstDueMonth, dueDayKind: r.dueDayKind,
      dueDayNum: r.dueDayNum ?? undefined, count: r.count, note: r.note,
    })) as DataSet['planRules'],
    goldLots: db.select().from(t.goldLots).all().map((l) => ({
      id: l.id, seq: l.seq, dateText: l.dateText, direction: l.direction,
      grams: l.grams, pricePerGram: l.pricePerGram, totalEgp: l.totalEgp, usdPaid: l.usdPaid,
    })) as DataSet['goldLots'],
    orders: db.select().from(t.orders).all().map((o) => ({
      id: o.id, seq: o.seq, date: o.date, time: o.time ?? undefined, ticker: o.ticker,
      side: o.side, shares: o.shares, price: o.price, total: o.total,
      fee: o.fee ?? 0, intention: o.intention ?? null, status: o.status,
    })) as DataSet['orders'],
    expenses: db.select().from(t.expenses).all().map((e) => ({
      id: e.id, seq: e.seq, date: e.date, amount: e.amount, currency: e.currency,
      egpAmount: e.egpAmount, fxAtEntry: e.rate ?? 1, accountId: e.accountId ?? undefined,
      categoryId: e.categoryId, place: e.place ?? '', note: e.note ?? '',
    })) as DataSet['expenses'],
    charity: db.select().from(t.charity).all().map((c) => ({
      id: c.id, seq: c.seq, date: c.date, egp: c.egp, usd: c.usd,
      categoryId: c.categoryId, note: c.note ?? '', isZakat: c.isZakat,
    })),
    categories: db.select().from(t.categories).all().map((c) => ({
      id: c.id, domain: c.domain as any, name: c.name, color: c.color, icon: c.icon ?? undefined,
    })),
    snapshot, settings,
    debts: readDebts(db),
  };

  const market = readMarket(db);
  return { data, market, values: compute(data, market, now) };
}

function assembleTransactions(db: Db): DataSet['transactions'] {
  const legs = db.select().from(t.legs).all();
  const byTx = new Map<string, typeof legs>();
  for (const l of legs) (byTx.get(l.transactionId) ?? byTx.set(l.transactionId, []).get(l.transactionId)!).push(l);

  return db.select().from(t.transactions).all().map((tx) => ({
    id: tx.id, seq: tx.seq, date: tx.date, kind: tx.kind as any,
    note: tx.note ?? undefined, automatic: tx.automatic,
    legs: (byTx.get(tx.id) ?? []).sort((a, b) => a.seq - b.seq).map((l) => ({
      id: l.id, seq: l.seq,
      fromNodeId: l.fromNodeId ?? undefined, toNodeId: l.toNodeId ?? undefined,
      qtyFrom: l.qtyFrom ?? undefined, qtyTo: l.qtyTo ?? undefined,
      rateApplied: l.rateApplied ?? undefined, feeQty: l.feeQty ?? undefined,
      feeNodeId: l.feeNodeId ?? undefined, categoryId: l.categoryId ?? undefined,
    })),
  }));
}

/**
 * The outside world, as last recorded.
 *
 * Rates and prices are ticks rather than columns, so a figure can always be traced to when
 * it was taken and where it came from. Reading takes the latest of each key.
 */
export function readMarket(db: Db): MarketState {
  const rows = db.$raw.prepare(`
    SELECT key, value, source, live, at FROM market_ticks
    WHERE id IN (SELECT MAX(id) FROM market_ticks GROUP BY key)
  `).all() as Array<{ key: string; value: number; source: string | null; live: number; at: string }>;

  const at = new Map(rows.map((r) => [r.key, r]));
  const num = (k: string, fallback: number) => at.get(k)?.value ?? fallback;

  // Rates are stored as CODE_BASE, so which pairs are read follows from whichever currency
  // the ledger reports in. Changing the base discards them all rather than reinterpreting
  // figures that would silently mean something else.
  const base = (readPref<{ base?: string }>(db, 'settings')?.base) ?? 'EGP';
  const fxRates: Record<string, number> = { [base]: 1 };
  for (const r of rows) {
    const m = new RegExp(`^([A-Z]{3})_${base}$`).exec(r.key);
    if (m) fxRates[m[1]!] = r.value;
  }
  const prices: Record<string, number> = {};
  for (const r of rows) {
    const m = /^price_(.+)$/.exec(r.key);
    if (m) prices[m[1]!] = r.value;
  }
  // Metals are prices too. They are keyed by what they are rather than by a ticker, so they
  // are lifted in by name — a position and a gram of silver are both valued from this map.
  if (at.has('silver_g')) prices.silver_g = at.get('silver_g')!.value;
  if (at.has('gold_24k_g')) prices.gold_g = at.get('gold_24k_g')!.value;

  return {
    usdEgp: num('USD_EGP', 50.9242),
    goldPerG: num('gold_24k_g', 7046),
    goldPerOz: at.get('gold_oz_usd')?.value ?? null,
    prices, fxRates,
    rateLive: (at.get('USD_EGP')?.live ?? 1) === 1,
    goldLive: (at.get('gold_24k_g')?.live ?? 1) === 1,
    pricesUpdatedAt: at.get('USD_EGP')?.at,
  };
}

/**
 * Debts, with what is actually left on each.
 *
 * The outstanding figure is the node's own balance rather than the principal, so a repayment
 * recorded anywhere is reflected everywhere — including in the zakat base, which is the
 * whole reason the engine needs to see them.
 */
export function readDebts(db: Db): NonNullable<DataSet['debts']> {
  const balances = nodeBalances(db);
  return db.select().from(t.debts).all().map((d) => ({
    id: d.id,
    direction: d.direction,
    counterparty: d.counterparty,
    outstanding: Math.abs(balances[d.nodeId] ?? d.principal),
    currency: d.currency,
    dueOn: d.dueOn ?? undefined,
    settledAt: d.settledAt ?? undefined,
    writtenOffAt: d.writtenOffAt ?? undefined,
  }));
}

export function readPref<T = unknown>(db: Db, key: string): T | undefined {
  const row = db.select().from(t.preferences).where(eq(t.preferences.key, key)).get();
  return row?.value as T | undefined;
}

export function writePref(db: Db, key: string, value: unknown): void {
  db.insert(t.preferences).values({ key, value: value as any, updatedAt: new Date().toISOString() })
    .onConflictDoUpdate({ target: t.preferences.key, set: { value: value as any, updatedAt: new Date().toISOString() } })
    .run();
}
