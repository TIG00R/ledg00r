import type { Db } from './client.js';
import * as t from './schema.js';
import { indexRow } from './search.js';

/**
 * Load a dataset into an empty ledger.
 *
 * The shape here is the one the engine already speaks, so the fixture the front end has been
 * running on loads unchanged, and so does an export taken from a running instance. Seeding is
 * refused rather than merged when the ledger already holds movements — silently mixing a
 * seed into real records is how a ledger stops being trustworthy.
 */
export interface SeedSet {
  institutions: any[]; nodes: any[]; transactions: any[]; incomeSources: any[];
  installments: any[]; planRules: any[]; goldLots: any[]; orders: any[];
  expenses: any[]; charity: any[]; categories: any[]; settings: any; snapshot: any;
  /**
   * What a ledger is opened warning about, and what it expects to happen on its own.
   *
   * Optional, and absent from every ledger that is not a demonstration. These used to be
   * constants here, which meant seeding anything at all also wrote a card fee nobody had and
   * an intention about a share nobody held.
   */
  reminders?: any[]; recurring?: any[]; scenarios?: any[];
}

/**
 * Is this a ledger nobody has used yet?
 *
 * Counted on institutions rather than nodes. A migration may create a node of its own — the
 * silver holding arrived that way — and counting those made a fresh database look occupied,
 * so the seed silently did not run and the ledger came up empty.
 */
export function isEmpty(db: Db): boolean {
  const inst = db.$raw.prepare('SELECT COUNT(*) AS n FROM institutions').get() as { n: number };
  const tx = db.$raw.prepare('SELECT COUNT(*) AS n FROM transactions').get() as { n: number };
  return inst.n === 0 && tx.n === 0;
}

export function seed(db: Db, data: SeedSet, opts: { force?: boolean } = {}): { rows: number } {
  if (!isEmpty(db) && !opts.force) {
    throw new Error('this ledger already holds records — seeding would mix a fixture into them');
  }

  let rows = 0;
  const dayOf = (v: unknown) => (v == null ? null : String(v));

  db.$raw.transaction(() => {
    for (const i of data.institutions) {
      db.insert(t.institutions).values({
        id: i.id, name: i.name, shortCode: i.shortCode, country: i.country,
        color: i.color, logo: i.logo ?? null, archived: !!i.archived,
      }).onConflictDoNothing().run(); rows++;
    }

    /**
     * Nodes, including the ones a migration already made.
     *
     * Gold, silver and the brokerage wallet exist before any seed runs, so leaving a
     * conflicting row alone meant a dataset that opens with gold in it came up holding none.
     * The ledger is empty when this runs, so there is nothing here to overwrite but a
     * placeholder.
     */
    for (const n of data.nodes) {
      const row = {
        id: n.id, kind: n.kind, name: n.name, parentId: n.parentId ?? null,
        currency: n.currency ?? null, unit: n.unit ?? null, valuation: n.valuation,
        priceKey: n.priceKey ?? null, openingQty: n.openingQty ?? 0,
        color: n.color ?? null, archived: !!n.archived,
      };
      db.insert(t.nodes).values(row)
        .onConflictDoUpdate({ target: t.nodes.id, set: row }).run(); rows++;
    }

    for (const c of data.categories) {
      db.insert(t.categories).values({
        id: c.id, domain: c.domain === 'brainstorm' ? 'expense' : c.domain,
        name: c.name, color: c.color, icon: c.icon ?? null, archived: false,
      }).onConflictDoNothing().run(); rows++;
    }

    for (const tx of data.transactions) {
      db.insert(t.transactions).values({
        id: tx.id, seq: tx.seq, date: tx.date, kind: tx.kind,
        note: tx.note ?? null, automatic: !!tx.automatic,
      }).onConflictDoNothing().run(); rows++;
      for (const [i, leg] of (tx.legs ?? []).entries()) {
        db.insert(t.legs).values({
          id: leg.id ?? `${tx.id}-l${i + 1}`, transactionId: tx.id, seq: leg.seq ?? i + 1,
          date: tx.date, fromNodeId: leg.fromNodeId ?? null, toNodeId: leg.toNodeId ?? null,
          qtyFrom: leg.qtyFrom ?? null, qtyTo: leg.qtyTo ?? null,
          rateApplied: leg.rateApplied ?? null, feeQty: leg.feeQty ?? null,
          feeNodeId: leg.feeNodeId ?? null, categoryId: leg.categoryId ?? null,
        }).onConflictDoNothing().run(); rows++;
      }
    }

    for (const e of data.expenses) {
      db.insert(t.expenses).values({
        id: e.id, seq: e.seq, date: e.date, amount: e.amount, currency: e.currency,
        egpAmount: e.egpAmount, rate: e.rate ?? null, accountId: e.accountId ?? null,
        categoryId: e.categoryId, place: e.place ?? null, note: e.note ?? null,
      }).onConflictDoNothing().run(); rows++;
      indexRow(db, { kind: 'expense', recordId: e.id, occurredOn: e.date,
                     title: e.place ?? e.categoryId, body: e.note ?? '' });
    }

    for (const c of data.charity) {
      db.insert(t.charity).values({
        id: c.id, seq: c.seq, date: c.date, egp: c.egp, usd: c.usd ?? null,
        currency: c.usd != null ? 'USD' : 'EGP', categoryId: c.categoryId,
        note: c.note ?? null, isZakat: !!c.isZakat,
      }).onConflictDoNothing().run(); rows++;
      indexRow(db, { kind: 'giving', recordId: c.id, occurredOn: c.date,
                     title: c.categoryId, body: c.note ?? '' });
    }

    for (const l of data.goldLots) {
      db.insert(t.goldLots).values({
        id: l.id, seq: l.seq, dateText: l.dateText, date: dayOf(l.date),
        direction: l.direction ?? 'buy', grams: l.grams, pricePerGram: l.pricePerGram,
        totalEgp: l.totalEgp, usdPaid: l.usdPaid ?? 0,
      }).onConflictDoNothing().run(); rows++;
    }

    for (const o of data.orders) {
      db.insert(t.orders).values({
        id: o.id, seq: o.seq, date: o.date, time: o.time ?? null, ticker: o.ticker,
        side: o.side, shares: o.shares, price: o.price, total: o.total, status: o.status,
      }).onConflictDoNothing().run(); rows++;
      indexRow(db, { kind: 'order', recordId: o.id, occurredOn: o.date,
                     title: `${o.ticker} ${o.side}`, body: `${o.shares} at ${o.price}` });
    }

    for (const r of data.planRules) {
      db.insert(t.planRules).values({
        id: r.id, propertyId: r.propertyId, seq: r.seq, kind: r.kind,
        intervalMonths: r.intervalMonths ?? null, amountEgp: r.amountEgp,
        firstDueMonth: r.firstDueMonth, dueDayKind: r.dueDayKind,
        dueDayNum: r.dueDayNum ?? null, count: r.count, note: r.note ?? '',
      }).onConflictDoNothing().run(); rows++;
    }

    for (const i of data.installments) {
      db.insert(t.installments).values({
        id: i.id, propertyId: i.propertyId, ruleId: i.ruleId ?? null,
        monthLabel: i.monthLabel, dueDate: dayOf(i.dueDate), dueDayKind: i.dueDayKind,
        dueDayNum: i.dueDayNum ?? null, amountEgp: i.amountEgp, note: i.note ?? '',
      }).onConflictDoNothing().run(); rows++;
    }

    for (const s of data.incomeSources) {
      db.insert(t.incomeSources).values({
        id: s.id, name: s.name, amount: s.amount ?? null, currency: s.currency,
        cadence: s.cadence, dayOfMonth: s.dayOfMonth == null ? null : String(s.dayOfMonth),
        startDate: s.startDate ?? null, endDate: s.endDate ?? null,
        toNodeId: s.toNodeId, scheduled: !!s.scheduled, icon: s.icon ?? null,
      }).onConflictDoNothing().run(); rows++;
    }

    // Only what the set actually carries. A ledger seeded from records alone comes up
    // warning about nothing, which is correct: a warning is something its owner asked for.
    for (const r of data.reminders ?? []) {
      db.insert(t.reminders).values(r as any).onConflictDoNothing().run(); rows++;
    }
    for (const r of data.recurring ?? []) {
      db.insert(t.recurringTemplates).values(r as any).onConflictDoNothing().run(); rows++;
    }
    for (const sc of data.scenarios ?? []) {
      db.insert(t.scenarios).values(sc as any).onConflictDoNothing().run(); rows++;
    }
    db.insert(t.preferences).values({ key: 'zakat', value: DEFAULT_ZAKAT })
      .onConflictDoNothing().run(); rows++;

    db.insert(t.preferences).values({ key: 'settings', value: data.settings })
      .onConflictDoUpdate({ target: t.preferences.key, set: { value: data.settings } }).run();
    db.insert(t.preferences).values({ key: 'snapshot', value: data.snapshot })
      .onConflictDoUpdate({ target: t.preferences.key, set: { value: data.snapshot } }).run();
    rows += 2;
  })();

  return { rows };
}


/**
 * When the lunar year turns, and what nisab is reckoned against.
 *
 * Configuration rather than invented money: every ledger needs an answer, and this is the
 * one the calculators fall back to when nobody has chosen another.
 */
const DEFAULT_ZAKAT = {
  anniversaryMonth: 9, anniversaryDay: 1, basis: 'gold', silverPerG: 52, deductDebts: false,
};
