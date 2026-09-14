import { sql } from 'drizzle-orm';
import {
  sqliteTable, text, integer, real, blob, index, uniqueIndex,
} from 'drizzle-orm/sqlite-core';

/**
 * The schema.
 *
 * The movement log is the truth: append-only, and every balance and total is computed from
 * it on read. Nothing here stores a figure the log could contradict — there is one answer to
 * what an account holds, and it is arrived at the same way every time it is asked for.
 *
 * Storage is SQLite, and the column types stay inside the portable subset Drizzle can emit
 * for other dialects. The search index is the exception: it is FTS5, and it is hand-written.
 */

export const institutions = sqliteTable('institutions', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  shortCode: text('short_code').notNull(),
  country: text('country').notNull(),
  color: text('color').notNull(),
  logo: text('logo'),
  archived: integer('archived', { mode: 'boolean' }).notNull().default(false),
});

export const nodes = sqliteTable('nodes', {
  id: text('id').primaryKey(),
  kind: text('kind', { enum: ['cash', 'asset', 'liability', 'external'] }).notNull(),
  name: text('name').notNull(),
  parentId: text('parent_id'),
  currency: text('currency'),
  unit: text('unit'),
  valuation: text('valuation', { enum: ['face', 'fx', 'live_price', 'fixed'] }).notNull(),
  priceKey: text('price_key'),
  openingQty: real('opening_qty').notNull().default(0),
  color: text('color'),
  /** what sort of thing this is, for an asset: a property, a vehicle, anything else */
  assetKind: text('asset_kind'),
  /** paid for outright, or still on a plan */
  ownership: text('ownership', { enum: ['owned', 'installments'] }),
  /**
   * Why it is held: a home, something let out, something bought to resell, something used.
   * Zakat reads this before it reads the value — a home is outside it however much it is
   * worth, and trade stock is inside it at whatever it would fetch.
   */
  intention: text('intention'),
  /** the day that intention was formed; changing your mind starts a new lunar year */
  intentionSince: text('intention_since'),
  acquiredOn: text('acquired_on'),
  /** the day its value passed nisab, when that came later than the intention */
  nisabMetOn: text('nisab_met_on'),
  icon: text('icon'),
  archived: integer('archived', { mode: 'boolean' }).notNull().default(false),
}, (t) => ({
  byParent: index('node_parent').on(t.parentId),
  byKind: index('node_kind').on(t.kind, t.archived),
}));

export const transactions = sqliteTable('transactions', {
  id: text('id').primaryKey(),
  seq: integer('seq').notNull(),
  date: text('date').notNull(),
  kind: text('kind').notNull(),
  note: text('note'),
  automatic: integer('automatic', { mode: 'boolean' }).notNull().default(false),
  /** the movement this one reverses, when it is a correction */
  correctsId: text('corrects_id'),
  /** a repeat of the same call must not post twice */
  idempotencyKey: text('idempotency_key'),
  createdAt: text('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
}, (t) => ({
  byDate: index('tx_date').on(t.date),
  byKindDate: index('tx_kind_date').on(t.kind, t.date),
  bySeq: index('tx_seq').on(t.seq),
  byKey: uniqueIndex('tx_idem').on(t.idempotencyKey),
}));

/**
 * `date` is carried on the leg as well as the transaction. It is redundant, and it is what
 * lets a balance be walked from an index on the leg alone rather than joining every time.
 */
export const legs = sqliteTable('legs', {
  id: text('id').primaryKey(),
  transactionId: text('transaction_id').notNull().references(() => transactions.id, { onDelete: 'cascade' }),
  seq: integer('seq').notNull(),
  date: text('date').notNull(),
  fromNodeId: text('from_node_id'),
  toNodeId: text('to_node_id'),
  qtyFrom: real('qty_from'),
  qtyTo: real('qty_to'),
  rateApplied: real('rate_applied'),
  feeQty: real('fee_qty'),
  feeNodeId: text('fee_node_id'),
  categoryId: text('category_id'),
}, (t) => ({
  byTx: index('leg_tx').on(t.transactionId),
  byFrom: index('leg_from_date').on(t.fromNodeId, t.date),
  byTo: index('leg_to_date').on(t.toNodeId, t.date),
  byCategory: index('leg_cat_date').on(t.categoryId, t.date),
}));

export const categories = sqliteTable('categories', {
  id: text('id').primaryKey(),
  domain: text('domain', { enum: ['expense', 'charity', 'income'] }).notNull(),
  name: text('name').notNull(),
  color: text('color').notNull(),
  icon: text('icon'),
  note: text('note'),
  archived: integer('archived', { mode: 'boolean' }).notNull().default(false),
}, (t) => ({ byDomain: index('cat_domain').on(t.domain, t.archived) }));

export const expenses = sqliteTable('expenses', {
  id: text('id').primaryKey(),
  seq: integer('seq').notNull(),
  date: text('date').notNull(),
  amount: real('amount').notNull(),
  currency: text('currency').notNull(),
  egpAmount: real('egp_amount').notNull(),
  rate: real('rate'),
  accountId: text('account_id'),
  categoryId: text('category_id').notNull(),
  place: text('place'),
  note: text('note'),
  movementId: text('movement_id'),
}, (t) => ({
  byDate: index('exp_date').on(t.date),
  byCatDate: index('exp_cat_date').on(t.categoryId, t.date),
  byAcctDate: index('exp_acct_date').on(t.accountId, t.date),
}));

export const charity = sqliteTable('charity', {
  id: text('id').primaryKey(),
  seq: integer('seq').notNull(),
  date: text('date').notNull(),
  egp: real('egp').notNull(),
  usd: real('usd'),
  currency: text('currency').notNull().default('EGP'),
  accountId: text('account_id'),
  categoryId: text('category_id').notNull(),
  note: text('note'),
  isZakat: integer('is_zakat', { mode: 'boolean' }).notNull().default(false),
  movementId: text('movement_id'),
}, (t) => ({
  byKindDate: index('give_kind_date').on(t.isZakat, t.date),
  byDate: index('give_date').on(t.date),
}));

export const goldLots = sqliteTable('gold_lots', {
  id: text('id').primaryKey(),
  seq: integer('seq').notNull(),
  dateText: text('date_text').notNull(),
  date: text('date'),
  direction: text('direction', { enum: ['buy', 'sell'] }).notNull().default('buy'),
  grams: real('grams').notNull(),
  pricePerGram: real('price_per_gram').notNull(),
  totalEgp: real('total_egp').notNull(),
  usdPaid: real('usd_paid').notNull().default(0),
  accountId: text('account_id'),
  movementId: text('movement_id'),
  note: text('note'),
  /** gold and silver are separate holdings; the same lot shape describes both */
  metal: text('metal', { enum: ['gold', 'silver'] }).notNull().default('gold'),
  /** worn, or held as a store of value — the two are not zakated alike */
  intention: text('intention'),
}, (t) => ({ byDate: index('lot_date').on(t.date) }));

export const orders = sqliteTable('orders', {
  id: text('id').primaryKey(),
  seq: integer('seq').notNull(),
  date: text('date').notNull(),
  time: text('time'),
  ticker: text('ticker').notNull(),
  side: text('side', { enum: ['BUY', 'SELL'] }).notNull(),
  shares: real('shares').notNull(),
  price: real('price').notNull(),
  total: real('total').notNull(),
  status: text('status', { enum: ['executed', 'pending', 'cancelled'] }).notNull(),
  movementId: text('movement_id'),
  /** why, for the next time this order is read back */
  note: text('note'),
}, (t) => ({
  byTickerDate: index('ord_ticker_date').on(t.ticker, t.date),
  byStatus: index('ord_status').on(t.status, t.date),
}));

export const planRules = sqliteTable('plan_rules', {
  id: text('id').primaryKey(),
  propertyId: text('property_id').notNull(),
  seq: integer('seq').notNull(),
  kind: text('kind', { enum: ['every_n_months', 'one_off'] }).notNull(),
  intervalMonths: integer('interval_months'),
  amountEgp: real('amount_egp').notNull(),
  firstDueMonth: text('first_due_month').notNull(),
  dueDayKind: text('due_day_kind', { enum: ['day', 'last'] }).notNull(),
  dueDayNum: integer('due_day_num'),
  count: integer('count').notNull(),
  note: text('note').notNull().default(''),
}, (t) => ({ byProperty: index('rule_property').on(t.propertyId, t.seq) }));

export const installments = sqliteTable('installments', {
  id: text('id').primaryKey(),
  propertyId: text('property_id').notNull(),
  ruleId: text('rule_id'),
  monthLabel: text('month_label').notNull(),
  dueDate: text('due_date'),
  dueDayKind: text('due_day_kind', { enum: ['day', 'last'] }).notNull(),
  dueDayNum: integer('due_day_num'),
  amountEgp: real('amount_egp').notNull(),
  note: text('note').notNull().default(''),
  paidAt: text('paid_at'),
  movementId: text('movement_id'),
  /** the account this payment comes out of, chosen ahead of paying it */
  payFrom: text('pay_from'),
}, (t) => ({
  byDue: index('inst_due').on(t.dueDate),
  byPropertyDue: index('inst_property_due').on(t.propertyId, t.dueDate),
}));

export const incomeSources = sqliteTable('income_sources', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  amount: real('amount'),
  currency: text('currency').notNull(),
  cadence: text('cadence').notNull(),
  dayOfMonth: text('day_of_month'),
  startDate: text('start_date'),
  endDate: text('end_date'),
  toNodeId: text('to_node_id').notNull(),
  /** the asset that earns this income, when it is rent rather than a wage */
  assetId: text('asset_id'),
  scheduled: integer('scheduled', { mode: 'boolean' }).notNull().default(true),
  icon: text('icon'),
  color: text('color'),
  archived: integer('archived', { mode: 'boolean' }).notNull().default(false),
});

export const recurringTemplates = sqliteTable('recurring_templates', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  fromNodeId: text('from_node_id'),
  toNodeId: text('to_node_id'),
  amount: real('amount'),
  currency: text('currency').notNull(),
  cadence: text('cadence').notNull(),
  dayOfMonth: text('day_of_month'),
  startDate: text('start_date'),
  endDate: text('end_date'),
  categoryId: text('category_id'),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  internal: integer('internal', { mode: 'boolean' }).notNull().default(false),
  note: text('note'),
  /** the last date this template actually posted, so the scheduler never doubles up */
  lastPostedFor: text('last_posted_for'),
}, (t) => ({ byEnabled: index('rec_enabled').on(t.enabled) }));

export const reminders = sqliteTable('reminders', {
  id: text('id').primaryKey(),
  subject: text('subject').notNull(),
  subjectId: text('subject_id'),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  offsetValue: integer('offset_value').notNull().default(0),
  offsetUnit: text('offset_unit', { enum: ['days', 'months'] }).notNull().default('days'),
  note: text('note'),
  direction: text('direction', { enum: ['buy', 'sell'] }),
  triggerPrice: real('trigger_price'),
  cadence: text('cadence'),
  graceDays: integer('grace_days'),
  /** when an intention has a date of its own rather than following the thing it watches */
  dueDate: text('due_date'),
}, (t) => ({ bySubject: index('rem_subject').on(t.subject, t.subjectId) }));

/**
 * The calendar's own entries.
 *
 * Everything else on the calendar is derived — a payment falls on a day because a plan says
 * so, a lunar year closes because a date was recorded. This table is the other half: the
 * things the owner puts there themselves, which nothing in the ledger would otherwise know
 * about. A meeting with the developer, the day a contract is signed, a reminder to look at a
 * price. It carries its own colour so a month keeps reading at a glance.
 */
export const calendarEntries = sqliteTable('calendar_entries', {
  id: text('id').primaryKey(),
  date: text('date').notNull(),           // YYYY-MM-DD
  title: text('title').notNull(),
  note: text('note'),
  color: text('color'),
  /**
   * How it repeats. `lunar_annually` is here because half of what this calendar carries is
   * reckoned in the lunar year, and an anniversary in that calendar drifts about eleven days
   * a year against this one — which a monthly or yearly repeat cannot express.
   */
  repeat: text('repeat', { enum: ['none', 'monthly', 'annually', 'lunar_annually'] })
    .notNull().default('none'),
  /** days before the day itself to put a warning on the calendar; 0 for none */
  remindDays: integer('remind_days').notNull().default(0),
  amount: real('amount'),
  currency: text('currency'),
  doneAt: text('done_at'),
  createdAt: text('created_at').notNull(),
}, (t) => ({ byDate: index('cal_entry_date').on(t.date) }));

export const dismissals = sqliteTable('dismissals', {
  eventId: text('event_id').primaryKey(),
  until: text('until'),
  on: text('on').notNull(),
});

export const autopay = sqliteTable('autopay', {
  propertyId: text('property_id').primaryKey(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(false),
  fromNodeId: text('from_node_id').notNull(),
});

export const scenarios = sqliteTable('scenarios', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  note: text('note'),
  asOf: text('as_of'),
  usdEgp: real('usd_egp'),
  goldPerG: real('gold_per_g'),
});

/** One row per key. Settings, appearance and modules are documents, not columns. */
export const preferences = sqliteTable('preferences', {
  key: text('key').primaryKey(),
  value: text('value', { mode: 'json' }).notNull(),
  updatedAt: text('updated_at').notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const marketTicks = sqliteTable('market_ticks', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  at: text('at').notNull(),
  key: text('key').notNull(),
  value: real('value').notNull(),
  source: text('source'),
  live: integer('live', { mode: 'boolean' }).notNull().default(true),
}, (t) => ({ byKeyAt: index('tick_key_at').on(t.key, t.at) }));

/**
 * Keys that may call the API from outside this machine.
 *
 * Only the hash is kept. A key is shown once, when it is issued, and never again — a key the
 * database can hand back is a key that travels in every backup and every screenshot of a
 * settings screen.
 */
export const apiKeys = sqliteTable('api_keys', {
  id: text('id').primaryKey(),
  label: text('label').notNull(),
  hash: text('hash').notNull(),
  /** the first few characters, so a person can tell two keys apart without seeing either */
  prefix: text('prefix').notNull(),
  createdAt: text('created_at').notNull(),
  lastUsedAt: text('last_used_at'),
  revokedAt: text('revoked_at'),
}, (t) => ({ byHash: index('key_hash').on(t.hash) }));

/**
 * Pictures used as marks.
 *
 * A mark is an icon name most of the time, and sometimes it is a bank's actual logo. Rather
 * than widen every `icon` column into a data URL — which would put a hundred kilobytes into
 * every row that reads a category — the picture lives here and the column holds `img:<id>`.
 */
export const images = sqliteTable('images', {
  id: text('id').primaryKey(),
  mime: text('mime').notNull(),
  bytes: blob('bytes').notNull(),
  width: integer('width'),
  height: integer('height'),
  label: text('label'),
  createdAt: text('created_at').notNull(),
});

/**
 * Money lent out, and money owed.
 *
 * Both are debts and the difference is only which way they point, so one table describes
 * them. Each is held as a node — an asset when it will come back to you, a liability when it
 * will not — which is what makes lending show up in what you are worth without anything
 * downstream having to know that debts exist.
 */
export const debts = sqliteTable('debts', {
  id: text('id').primaryKey(),
  direction: text('direction', { enum: ['lent', 'borrowed'] }).notNull(),
  counterparty: text('counterparty').notNull(),
  principal: real('principal').notNull(),
  currency: text('currency').notNull(),
  startedOn: text('started_on').notNull(),
  dueOn: text('due_on'),
  note: text('note'),
  nodeId: text('node_id').notNull(),
  settledAt: text('settled_at'),
  writtenOffAt: text('written_off_at'),
  createdAt: text('created_at').notNull(),
}, (t) => ({
  byOpen: index('debt_open').on(t.direction, t.settledAt),
  byDue: index('debt_due').on(t.dueOn),
}));

export type Debt = typeof debts.$inferSelect;

export type Institution = typeof institutions.$inferSelect;
export type Node = typeof nodes.$inferSelect;
export type Transaction = typeof transactions.$inferSelect;
export type Leg = typeof legs.$inferSelect;
export type Expense = typeof expenses.$inferSelect;
export type Charity = typeof charity.$inferSelect;
export type GoldLot = typeof goldLots.$inferSelect;
export type Order = typeof orders.$inferSelect;
export type Installment = typeof installments.$inferSelect;
export type IncomeSource = typeof incomeSources.$inferSelect;
export type RecurringTemplate = typeof recurringTemplates.$inferSelect;
export type Reminder = typeof reminders.$inferSelect;
export type CalendarEntry = typeof calendarEntries.$inferSelect;
