import { sql } from 'drizzle-orm';
import {
  sqliteTable, text, integer, real, blob, index, uniqueIndex, primaryKey,
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
  /**
   * The money an asset bought outright was actually paid with, frozen the day it was paid.
   *
   * `currency` above is what the asset is *held* in — a car is worth so many dollars, today
   * and next year. This is a different question: which account paid for it, what that
   * account's own currency was, how much of it left, and the rate that applied — kept so the
   * ledger can ask, alongside what the asset is worth now, what that money would be worth now
   * had it simply stayed where it was. Null for anything bought before this was tracked, or
   * for a plan, or for one stated with no source at all.
   */
  sourceAccountId: text('source_account_id'),
  sourceCurrency: text('source_currency'),
  sourceAmount: real('source_amount'),
  sourceRate: real('source_rate'),
  /**
   * What it cost when it was bought, and what it fetched when it was sold.
   *
   * `boughtFor` is the price the asset was added at, in its own currency, kept apart from
   * `openingQty` because that figure moves: repricing a flat rewrites what it is worth and
   * would otherwise rewrite what was paid for it as well. A plan has none — what it cost is
   * what has been paid towards it, which the plan itself says.
   *
   * The sale is the whole of the other side: the day, the price and its currency, the account
   * the money reached, and `soldBasis`, the figure that price was measured against. The basis
   * is stored rather than worked out again, because what had been paid towards the thing on
   * the day it was sold is not something today's ledger can still answer.
   */
  boughtFor: real('bought_for'),
  boughtCurrency: text('bought_currency'),
  soldOn: text('sold_on'),
  soldPrice: real('sold_price'),
  soldCurrency: text('sold_currency'),
  soldAccountId: text('sold_account_id'),
  soldBasis: real('sold_basis'),
  soldMovementId: text('sold_movement_id'),
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
  /**
   * Which account this kind of spending usually comes out of.
   *
   * Null falls back to the ledger's own default. It is a default and nothing more: what an
   * expense actually came out of is on the expense, because that is what happened.
   */
  accountId: text('account_id'),
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
  /**
   * The zakat year this payment discharges.
   *
   * Zakat is owed for a particular lunar year, so a payment that names no year reduces
   * nothing — it is giving, recorded, but not applied. Sadaqat never carries one.
   */
  zakatYearId: text('zakat_year_id'),
  movementId: text('movement_id'),
}, (t) => ({
  byKindDate: index('give_kind_date').on(t.isZakat, t.date),
  byDate: index('give_date').on(t.date),
  byYear: index('give_year').on(t.zakatYearId),
}));

/**
 * A lunar year, closed and confirmed.
 *
 * Everything else in this schema is a movement or a thing owned; this is the one place a
 * computed figure is stored. It has to be: what is owed is fixed on the day the hawl closes,
 * and gold moves the day after. Recomputing it from today's prices would mean the obligation
 * never settles, so the figure — and the arithmetic that produced it — is written down once
 * the owner has looked at it and said it is right.
 *
 * A row exists only for a year that has been confirmed. A hawl that has closed and not been
 * confirmed is still being worked out, and is computed live like any other.
 */
export const zakatYears = sqliteTable('zakat_years', {
  id: text('id').primaryKey(),
  /**
   * Which pot the year was closed on.
   *
   * `wealth` for every year closed now that everything is counted together. The narrower
   * pots — cash, gold, silver, one named asset — are years confirmed under the older reading,
   * and they keep the name they were filed under so they can still be read back.
   */
  bucket: text('bucket').notNull(),
  label: text('label').notNull(),
  startOn: text('start_on').notNull(),
  dueOn: text('due_on').notNull(),
  dueHijri: text('due_hijri').notNull(),
  /** the day this pot passed nisab, from which the year was counted */
  anchorOn: text('anchor_on'),
  /** the zakatable base as confirmed, after any correction the owner made */
  base: real('base').notNull(),
  due: real('due').notNull(),
  nisab: real('nisab').notNull(),
  basis: text('basis', { enum: ['gold', 'silver'] }).notNull(),
  /** the prices in force on the day it was confirmed, so the figure can be re-read */
  goldPerG: real('gold_per_g'),
  silverPerG: real('silver_per_g'),
  /** the signed lines that made the base, as they stood at confirmation */
  entries: text('entries', { mode: 'json' }).notNull(),
  note: text('note'),
  confirmedAt: text('confirmed_at').notNull(),
}, (t) => ({
  byBucketDue: index('zy_bucket_due').on(t.bucket, t.dueOn),
  oneEach: uniqueIndex('zy_unique').on(t.bucket, t.dueOn),
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
  /**
   * A flat charge on the sale itself, in the account's own currency.
   *
   * Not the making charge, which is struck per gram in the metal's quoted currency and comes
   * off `totalEgp` before it. This is what the dealer or the transfer took off the money that
   * arrived, and it is kept so a correction can reverse the same sale it wrote.
   */
  fee: real('fee').notNull().default(0),
  accountId: text('account_id'),
  movementId: text('movement_id'),
  note: text('note'),
  /** gold and silver are separate holdings; the same lot shape describes both */
  metal: text('metal', { enum: ['gold', 'silver'] }).notNull().default('gold'),
  /** worn, or held as a store of value — the two are not zakated alike */
  intention: text('intention'),
  /**
   * The price as it was quoted, and the currency it was quoted in.
   *
   * `pricePerGram` and `totalEgp` are always pounds, because every reading in this ledger is.
   * A dealer quoting in dollars is a fact about the purchase, though, and rounding it into
   * pounds on the way in loses the number that was actually agreed — so both are kept.
   */
  currency: text('currency'),
  priceNative: real('price_native'),
  /**
   * The making charge — مصنعية — per gram, in `currency`.
   *
   * Workmanship is charged on top of the metal in Egypt and is not part of what the gram is
   * worth: it buys no weight and cannot be sold back. So it is money spent rather than value
   * moved, and it is kept apart from the price so the holding is never valued at it.
   */
  makingPerGram: real('making_per_gram').notNull().default(0),
  /** what that workmanship came to, in pounds — grams times the charge, at the day's rate */
  makingEgp: real('making_egp').notNull().default(0),
  /**
   * The account's own money, as it actually left `accountId`, frozen the day it left.
   *
   * `currency`/`priceNative` above are what the *metal* was quoted in — a dealer's own
   * pricing. This is the buyer's side: the account's currency, what left it, and the rate
   * applied — so a lot bought with converted dollars can be asked what those dollars would be
   * worth now, apart from what the gold itself did. Set on a buy only; a sale gives money
   * back rather than spending it, so there is no source money behind one, and a lot held from
   * before the ledger has no account to have paid it either.
   */
  sourceCurrency: text('source_currency'),
  sourceAmount: real('source_amount'),
  sourceRate: real('source_rate'),
}, (t) => ({ byDate: index('lot_date').on(t.date) }));

/**
 * A book above the book.
 *
 * There used to be exactly one share book: one wallet, one set of orders, one set of
 * positions, all reached by a fixed id nothing ever had to name. An owner with money at more
 * than one broker needs more than one of each — so the book itself becomes a row, and every
 * order and every wallet says which one it belongs to, rather than there being only one to
 * belong to.
 *
 * The wallet and the clouds wallet are named here rather than guessed at from a naming
 * convention on `nodes` — the first exchange kept the ids `brokerage-cash` and `clouds-cash`
 * it always had, so nothing that already pointed at them had to change, and a fixed pattern
 * could never have covered both that and a freshly generated id for the next one.
 */
export const exchanges = sqliteTable('exchanges', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  /** the broker's own mark — an icon name, or `img:<id>` into `images`, as a bank's is */
  logo: text('logo'),
  walletNodeId: text('wallet_node_id').notNull(),
  cloudsNodeId: text('clouds_node_id').notNull(),
  archived: integer('archived', { mode: 'boolean' }).notNull().default(false),
  createdAt: text('created_at').notNull(),
});

export const orders = sqliteTable('orders', {
  id: text('id').primaryKey(),
  seq: integer('seq').notNull(),
  date: text('date').notNull(),
  /** which exchange this order was placed on — the book it moves and the wallet it spends */
  exchangeId: text('exchange_id').notNull().default('main'),
  time: text('time'),
  ticker: text('ticker').notNull(),
  side: text('side', { enum: ['BUY', 'SELL'] }).notNull(),
  shares: real('shares').notNull(),
  price: real('price').notNull(),
  total: real('total').notNull(),
  status: text('status', { enum: ['executed', 'pending', 'cancelled'] }).notNull(),
  movementId: text('movement_id'),
  /**
   * What the broker charged for this order, once, in the wallet's own currency. It belongs
   * to the whole order rather than to each share — a commission of fifty is fifty whether
   * the order was for one share or a hundred — so it is added to what a buy takes out of
   * the wallet and taken off what a sale puts back into it, and never multiplied by shares.
   */
  fee: real('fee').notNull().default(0),
  /**
   * Why these shares are held — 'personal' or 'investment' — stated on the order itself, so
   * shares of the same ticker bought to keep and bought to trade are not forced into one
   * answer. Null on an order logged before it was asked for, which reads as "not stated"
   * rather than as either answer.
   */
  intention: text('intention'),
  /** why, for the next time this order is read back */
  note: text('note'),
  /**
   * What a sale earned, against the weighted average cost of every share of that ticker held
   * the instant before it — never one lot's own price. Written once, when the sale is logged,
   * and left alone afterwards: a share bought later must not reach back and change what a
   * past sale made. Null for a buy, and null for a sale logged before this column existed —
   * there is no honest figure to back-fill, since the owner never saw one at the time.
   */
  realizedPnl: real('realized_pnl'),
  /** the same result as a percentage of what the shares sold had cost, alongside the amount */
  realizedPnlPct: real('realized_pnl_pct'),
  /**
   * A buy's own source money, the same idea `gold_lots` keeps: the account it is understood
   * to have been funded from, that account's currency, what left it, and the rate applied,
   * frozen the day it was logged. Shares are bought out of the pooled brokerage wallet rather
   * than a named account directly, so unlike a metal lot this is only ever recorded when the
   * caller actually names one — nothing here guesses which account paid for a buy that never
   * said. Null on every sale, and on a buy that named none.
   */
  accountId: text('account_id'),
  sourceCurrency: text('source_currency'),
  sourceAmount: real('source_amount'),
  sourceRate: real('source_rate'),
}, (t) => ({
  byTickerDate: index('ord_ticker_date').on(t.ticker, t.date),
  byStatus: index('ord_status').on(t.status, t.date),
  byExchange: index('ord_exchange').on(t.exchangeId, t.date),
}));

/**
 * The share notebook.
 *
 * A ticker is a code, and six months later a code is not a company. This is the notebook's
 * own index of what each one is: one row per ticker, the name as the owner writes it. It is
 * deliberately not a feed from an exchange — nothing here knows a company the owner has not
 * written down.
 */
export const stocks = sqliteTable('stocks', {
  ticker: text('ticker').primaryKey(),
  name: text('name'),
  /** an icon name, or `img:<id>` into `images` — a company's mark, the same shape as a bank's */
  logo: text('logo'),
  /** why the share is held — 'personal' or 'investment', the same two words gold answers in;
   *  null until the owner states one, and read back as "not stated" rather than guessed at */
  intention: text('intention'),
  createdAt: text('created_at').notNull(),
});

/**
 * What was thought about a share, on the day it was thought.
 *
 * Orders record what was done; this records why, and what was decided against doing — a
 * rejection, a dividend date, a thesis that has not aged well. Dated, because a view read
 * back without the day it was formed is worth very little.
 */
export const stockNotes = sqliteTable('stock_notes', {
  id: text('id').primaryKey(),
  ticker: text('ticker').notNull(),
  date: text('date').notNull(),          // YYYY-MM-DD, the day the note is about
  note: text('note').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at'),
}, (t) => ({
  byTickerDate: index('stock_note_ticker_date').on(t.ticker, t.date),
  byDate: index('stock_note_date').on(t.date),
}));

/**
 * What a share paid out, and when.
 *
 * A record, not a movement. The company distributed in these months of this year and this is
 * what came of it — kept so a year can be read back and a decision made against what actually
 * arrived, rather than against what was hoped for. Nothing here touches a balance or a
 * position: money that reached the brokerage is funded separately, by the transfer that
 * actually moved it.
 *
 * A distribution can be money or it can be shares, so the value is a number and `kind` says
 * what the number counts.
 */
export const stockDividends = sqliteTable('stock_dividends', {
  id: text('id').primaryKey(),
  ticker: text('ticker').notNull(),
  /** the year distributed for */
  year: integer('year').notNull(),
  /** the months it came in, as numbers 1-12 in order, comma-joined: a payer can distribute twice */
  months: text('months').notNull().default(''),
  /** what the value counts: pounds and pence, or shares */
  kind: text('kind', { enum: ['cash', 'shares'] }).notNull(),
  /** the total for that year — money in `currency`, or a number of shares */
  amount: real('amount').notNull(),
  /** what the money was in; nothing, when the payout was shares */
  currency: text('currency'),
  note: text('note'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at'),
}, (t) => ({
  byTickerYear: index('stock_div_ticker_year').on(t.ticker, t.year),
  oneRowPerYear: uniqueIndex('stock_div_unique').on(t.ticker, t.year, t.kind),
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
  /**
   * The day the arrangement was made.
   *
   * Nothing that fell due before it is posted: switching autopay on is a promise about the
   * payments still to come, not a claim that the ones already behind were made. A payment
   * older than this date is still owed and is still paid by hand.
   */
  since: text('since'),
});

export const scenarios = sqliteTable('scenarios', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  note: text('note'),
  asOf: text('as_of'),
  usdEgp: real('usd_egp'),
  goldPerG: real('gold_per_g'),
});

/**
 * A ceiling on spending, over a period, covering a set of destinations.
 *
 * A pool rather than a figure attached to one destination: a ceiling over one destination is
 * a pool with one member, and the same object holds "Food" over both groceries and eating
 * out. The ceiling keeps the currency it was decided in — a ceiling is a decision, not a
 * figure to be restated whenever the display currency changes.
 */
export const budgets = sqliteTable('budgets', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  color: text('color').notNull().default('#8A8578'),
  icon: text('icon'),
  period: text('period', { enum: ['monthly', 'quarterly', 'annual'] }).notNull(),
  amount: real('amount').notNull(),
  currency: text('currency').notNull(),
  /** the date the periods are counted from: which day a month turns over, which month a year does */
  anchor: text('anchor').notNull(),
  /** how close to the ceiling is close enough to be warned, as a fraction of it */
  warnAt: real('warnAt').notNull().default(0.8),
  note: text('note'),
  archived: integer('archived', { mode: 'boolean' }).notNull().default(false),
  createdAt: text('created_at').notNull(),
}, (t) => ({ byArchived: index('budget_archived').on(t.archived) }));

/** Which destinations a pool covers. A destination may belong to more than one. */
export const budgetMembers = sqliteTable('budget_members', {
  budgetId: text('budget_id').notNull(),
  categoryId: text('category_id').notNull(),
}, (t) => ({
  pk: primaryKey({ columns: [t.budgetId, t.categoryId] }),
  byCategory: index('budget_member_cat').on(t.categoryId),
}));

/**
 * Everything the ledger was asked to do, whether or not it moved money.
 *
 * The movements are the record of what happened to the money, and they are silent about
 * everything else: a rename, an archive, a reminder switched off, a refusal, a balance
 * restated — that last one especially, since restating a balance deliberately writes no
 * movement. One row per command, written by the dispatcher rather than by each handler, so
 * nothing added later can forget to record itself.
 */
export const actions = sqliteTable('actions', {
  id: text('id').primaryKey(),
  at: text('at').notNull(),
  capability: text('capability').notNull(),
  context: text('context').notNull(),
  summary: text('summary').notNull(),
  /** 'ok', 'refused' or 'failed' — a refusal is a thing that was tried */
  outcome: text('outcome', { enum: ['ok', 'refused', 'failed'] }).notNull(),
  /** what it was called with, as given, so a correction can be read back in full */
  input: text('input', { mode: 'json' }),
  /** the movement it wrote, where it wrote one */
  movementId: text('movement_id'),
  /** the account, asset, destination or record it acted on, where there is a single one */
  subjectId: text('subject_id'),
  /** where the request came from: the screens, an agent over MCP, the HTTP API */
  source: text('source').notNull().default('api'),
}, (t) => ({
  byAt: index('action_at').on(t.at),
  byCapability: index('action_cap_at').on(t.capability, t.at),
  byOutcome: index('action_outcome_at').on(t.outcome, t.at),
}));

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
  /**
   * EGP per unit of `currency`, as it stood the day the debt was lent or borrowed — frozen at
   * that moment the way an expense freezes its own rate, so a rate that moves afterwards
   * does not reach back and change what a debt already made is worth. Null for a debt
   * recorded in EGP (nothing to convert) or one recorded before this column existed.
   */
  rate: real('rate'),
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

/**
 * What everything owned came to, frozen at the moment the row was written.
 *
 * Net worth read live is what `portfolio.overview` answers, and it moves every time a price
 * does — asking it again tomorrow gives a different number for today. A timeline needs the
 * opposite: what the answer *was*, that will not change underneath it. So one statement is
 * written every day, automatically, by the scheduler alone — nothing else creates one — and
 * stands afterwards the way a confirmed zakat year does, editable only by a deliberate
 * correction rather than by asking the ledger the same question again.
 */
export const wealthStatements = sqliteTable('wealth_statements', {
  id: text('id').primaryKey(),
  /** the day this statement is for, YYYY-MM-DD — one row per day */
  date: text('date').notNull(),
  /** date's own month, YYYY-MM — kept alongside it so a month or a year can be indexed directly rather than substr'd out of date on every read */
  month: text('month').notNull(),
  currency: text('currency').notNull(),
  netWorth: real('net_worth').notNull(),
  /** the same shape portfolio.overview reports, frozen alongside the total */
  allocation: text('allocation', { mode: 'json' }).notNull(),
  /** 'auto' on every day the scheduler writes; 'manual' once a person has corrected it */
  source: text('source', { enum: ['auto', 'manual'] }).notNull().default('auto'),
  note: text('note'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at'),
}, (t) => ({
  byDate: uniqueIndex('wealth_stmt_date').on(t.date),
  byMonth: index('wealth_stmt_month').on(t.month),
}));

export type WealthStatement = typeof wealthStatements.$inferSelect;

export type Debt = typeof debts.$inferSelect;

export type Institution = typeof institutions.$inferSelect;
export type Node = typeof nodes.$inferSelect;
export type Transaction = typeof transactions.$inferSelect;
export type Leg = typeof legs.$inferSelect;
export type Expense = typeof expenses.$inferSelect;
export type Charity = typeof charity.$inferSelect;
export type ZakatYear = typeof zakatYears.$inferSelect;
export type GoldLot = typeof goldLots.$inferSelect;
export type Order = typeof orders.$inferSelect;
export type Exchange = typeof exchanges.$inferSelect;
export type Stock = typeof stocks.$inferSelect;
export type StockNote = typeof stockNotes.$inferSelect;
export type StockDividend = typeof stockDividends.$inferSelect;
export type Installment = typeof installments.$inferSelect;
export type IncomeSource = typeof incomeSources.$inferSelect;
export type RecurringTemplate = typeof recurringTemplates.$inferSelect;
export type Reminder = typeof reminders.$inferSelect;
export type CalendarEntry = typeof calendarEntries.$inferSelect;
