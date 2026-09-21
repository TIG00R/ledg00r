import { z } from 'zod';
import { command, query, DateOnly, NodeId, Ticker, Outcome, type Refusal } from '@ledger/contracts';
import { schema as t, type Db, type Exchange } from '@ledger/db';
import { eq, and, inArray } from 'drizzle-orm';
import { computedPositions, installmentDueDate, monthLabelOf, avgCostBefore, realizedOnSale } from '@ledger/engine';
import type { Order as EngineOrder } from '@ledger/engine';
import type { AppCtx } from '../context.js';
import { post, noted, refusal, today, newId, undoMovement, atomically, DryRun, nameOf,
         sourceReading, SOURCE_FIELDS } from './shared.js';
import { nextSeq } from './spending.js';
import { readMarket } from '../read.js';

/**
 * The book a caller means, when nothing here checks first.
 *
 * Almost every capability that touches the share book means the one it has always had, so an
 * `exchangeId` that is left out defaults to this rather than every existing call — the
 * screens, the assistant, a year of scripts — having to start naming one.
 */
const DEFAULT_EXCHANGE_ID = 'main';
const ExchangeIdIn = z.string().min(1).default(DEFAULT_EXCHANGE_ID);

/** The exchange a call names, or the one it means by saying nothing. */
function exchangeOf(db: Db, exchangeId: string): Exchange | undefined {
  return db.select().from(t.exchanges).where(eq(t.exchanges.id, exchangeId)).get();
}

/**
 * Metal, shares and property.
 *
 * All three are the same act underneath: cash leaves an account and a holding grows by the
 * quantity it bought. Recording them as movements rather than as standalone rows is what
 * keeps the accounts honest — buying gold has to take the money from somewhere.
 */
/**
 * Whether a property is still being paid for.
 *
 * A plan finishes when its last payment is made, and the thing then belongs to you outright —
 * which is a fact about the property, not about the payment that happened to be last. Left to
 * the interface it would have been true on one screen and not on another, so it is settled
 * here, wherever the plan changes: paying the last instalment, correcting one, adding one, or
 * taking the last unpaid one off.
 *
 * A property with no plan at all is left alone: it was bought outright and nothing here
 * knows better.
 */
export function settleOwnership(db: Db, propertyId: string): 'owned' | 'installments' | null {
  const rows = db.select().from(t.installments).where(eq(t.installments.propertyId, propertyId)).all();
  if (rows.length === 0) return null;
  const ownership = rows.every((r) => r.paidAt) ? 'owned' as const : 'installments' as const;
  const node = db.select().from(t.nodes).where(eq(t.nodes.id, propertyId)).get();
  if (!node || node.kind !== 'asset' || node.ownership === ownership) return null;
  db.update(t.nodes).set({ ownership }).where(eq(t.nodes.id, propertyId)).run();
  return ownership;
}

/**
 * Paying one installment, out of a named account.
 *
 * Two capabilities need this: `installment.pay`, where a payment already on the plan is made,
 * and `plan.upsert`, where a payment is written down as having been made already — the plan a
 * person types in on Tuesday usually has a row or two behind it that were paid in March.
 * Sharing the act means the movement, the account, and the settling of ownership are the same
 * in both, rather than two spellings of "paid" that drift apart.
 */
function payInstallment(
  ctx: AppCtx,
  input: { installmentId: string; accountId?: string; date?: string; dryRun?: boolean },
) {
  const inst = ctx.db.select().from(t.installments).where(eq(t.installments.id, input.installmentId)).get();
  if (!inst) return refusal('not_found', `${input.installmentId} is not an installment.`);
  if (inst.paidAt) return refusal('duplicate', 'That installment is already marked paid.', 'Correct it instead, if the payment was wrong.');

  const property = ctx.db.select().from(t.nodes).where(eq(t.nodes.id, inst.propertyId)).get();
  // Whatever it is called, a paid installment is money that went into the property, so it
  // counts towards what the property is worth — a maintenance charge or a fee is still
  // recorded as what it is (the note says so, and buysEquity still reads it back), but it no
  // longer vanishes from the property's value the way a payment that bought a share of it
  // does.
  const equity = !/maintenance|service|fee/i.test(inst.note);
  const date = input.date ?? today(ctx);

  // The account named on the call, else the one the payment already names, else the one
  // this property pays from automatically. Nothing is guessed beyond that.
  const auto = ctx.db.select().from(t.autopay)
    .where(eq(t.autopay.propertyId, inst.propertyId)).get();
  const from = input.accountId ?? inst.payFrom ?? (auto?.enabled ? auto.fromNodeId : null);
  if (!from) {
    return refusal('unknown_node', 'This payment does not say which account it comes out of.',
                   'Choose one on the row, or turn on paying automatically for this property.');
  }

  return post(ctx, {
    date, kind: 'installment', note: inst.note || undefined,
    legs: [property
      ? { fromNodeId: from, qtyFrom: inst.amountEgp, toNodeId: property.id, qtyTo: inst.amountEgp }
      : { fromNodeId: from, qtyFrom: inst.amountEgp }],
  }, `${inst.amountEgp} to ${property?.name ?? inst.propertyId}${equity ? '' : ' — buys no equity'}`,
  {
    dryRun: input.dryRun,
    after: (db, movementId) => {
      db.update(t.installments).set({ paidAt: date, movementId, payFrom: from })
        .where(eq(t.installments.id, input.installmentId)).run();
      settleOwnership(db, inst.propertyId);
    },
  });
}

/**
 * A metal price as it was quoted, read back in pounds.
 *
 * A dealer quotes in whatever currency they trade in, and charges workmanship — مصنعية — per
 * gram on top of the metal. The two are different kinds of money: the price buys weight, the
 * making charge buys none of it and cannot be sold back, so it is spending rather than value
 * moved between two things you own. Both are quoted in the same currency, so both convert at
 * the same rate, and the rest of the ledger only ever sees pounds.
 */
function quoted(
  market: { fxRates: Record<string, number> },
  input: { currency?: string; pricePerGram?: number; makingPerGram?: number; grams: number },
  fallbackPerGramEgp: number,
) {
  const currency = input.currency ?? 'EGP';
  const fx = currency === 'EGP' ? 1 : market.fxRates[currency] ?? 1;
  const priceNative = input.pricePerGram ?? (fallbackPerGramEgp / fx);
  const makingNative = input.makingPerGram ?? 0;
  return {
    currency, priceNative, makingNative,
    perGramEgp: priceNative * fx,
    makingEgp: input.grams * makingNative * fx,
  };
}

/**
 * What a sale earned, ready to store on its own row.
 *
 * Read from the orders already on the book — never the one being written — so a sale is
 * measured against the average of every share of that ticker held the instant before it, the
 * same average `positions.list` shows. A buy stores nothing: there is no sale to measure.
 *
 * `proceeds` is what the sale actually brought into the wallet, the broker's charge already
 * taken off — a fee is money that did not arrive, so a sale that only broke even before the
 * commission reads as the small loss it was.
 *
 * Scoped to the one exchange the sale was placed on. The same ticker can be held on two
 * exchanges at once now, each with its own average cost, and a sale on one must never be
 * measured against shares sitting in a book it cannot see.
 */
function realizedFields(
  db: Db, exchangeId: string, ticker: string, side: 'BUY' | 'SELL', shares: number, proceeds: number, beforeSeq: number,
): { realizedPnl: number | null; realizedPnlPct: number | null } {
  if (side !== 'SELL') return { realizedPnl: null, realizedPnlPct: null };
  const prior = db.select().from(t.orders)
    .where(and(eq(t.orders.ticker, ticker), eq(t.orders.exchangeId, exchangeId))).all() as unknown as EngineOrder[];
  const { avgBuy } = avgCostBefore(prior, ticker, beforeSeq);
  const { pnl, pct } = realizedOnSale(avgBuy, shares, proceeds);
  return { realizedPnl: pnl, realizedPnlPct: pct };
}

/**
 * The two answers an intention can be, read back out of a free-text column.
 *
 * Anything else — an empty column on an order logged before it was asked for, or a word
 * written straight into the database — reads as none at all rather than as either answer,
 * because guessing which one was meant is worse than saying nobody said.
 */
function statedIntention(v: string | null | undefined): 'personal' | 'investment' | null {
  return v === 'personal' || v === 'investment' ? v : null;
}

/**
 * A share buy's own source money, the same idea a metal lot keeps — which account it is
 * understood to have been funded from, that account's currency, what it comes to there, and
 * the rate applied.
 *
 * A share is bought out of the pooled brokerage wallet rather than a named account directly,
 * so unlike gold nothing here actually moves on the strength of it — this is a fact kept
 * alongside the order, not a second leg. Which is also why it is only ever recorded when the
 * caller names an account: nothing here guesses which of several accounts might have funded a
 * buy that never said. `preferredRate` lets a correction that leaves the account alone keep
 * the rate already on the row rather than silently jumping to today's, the same way changing
 * one field on a lot leaves the others as they were.
 */
function orderSource(
  ctx: AppCtx, accountId: string | null | undefined, rateApplied: number | undefined,
  bookCurrency: string | null, totalInBookCurrency: number, preferredRate?: number | null,
): { refusal: Refusal } | { fields: { accountId: string; sourceCurrency: string; sourceAmount: number; sourceRate: number } | null } {
  if (!accountId) return { fields: null };
  const acct = ctx.ledger().node(accountId);
  if (!acct) return { refusal: refusal('unknown_node', `${accountId} is not an account in this ledger.`) };
  const market = readMarket(ctx.db);
  const bookCur = bookCurrency ?? 'EGP';
  const costEgp = bookCur === 'EGP' ? totalInBookCurrency : totalInBookCurrency * (market.fxRates[bookCur] ?? 1);
  const acctCur = acct.currency ?? 'EGP';
  const sourceRate = rateApplied ?? preferredRate ?? (acctCur === 'EGP' ? 1 : market.fxRates[acctCur] ?? 1);
  return { fields: { accountId, sourceCurrency: acctCur, sourceAmount: costEgp / sourceRate, sourceRate } };
}

/**
 * The source money behind a position, walked the same way `computedPositions` walks its cost.
 *
 * A position can be built from several buys, and a sale narrows what is left the same way it
 * narrows the cost: proportionally, against the average, never against one buy in particular
 * — so a sale here reduces the source money by the same fraction it reduces the shares.
 *
 * Anything less than the whole picture is reported as no source at all rather than a partial
 * one: a buy behind today's shares with nothing recorded, or two buys funded in different
 * currencies, both mean there is no single honest answer to "the money that bought this", so
 * none is guessed.
 */
function sourceBehindPosition(orders: Array<{
  seq: number; side: string; shares: number; status: string;
  sourceCurrency: string | null; sourceAmount: number | null; sourceRate: number | null;
}>): { currency: string; amount: number; rate: number } | null {
  let shares = 0, amount = 0, thenEgp = 0;
  let currency: string | null = null;
  let complete = true;
  for (const o of [...orders].sort((a, b) => a.seq - b.seq)) {
    if (o.status !== 'executed') continue;
    if (o.side === 'BUY') {
      shares += o.shares;
      if (o.sourceCurrency && o.sourceAmount && o.sourceRate) {
        if (currency && currency !== o.sourceCurrency) complete = false;
        currency = currency ?? o.sourceCurrency;
        amount += o.sourceAmount;
        thenEgp += o.sourceAmount * o.sourceRate;
      } else {
        complete = false;
      }
    } else {
      const frac = shares > 0 ? Math.min(1, o.shares / shares) : 0;
      amount -= amount * frac;
      thenEgp -= thenEgp * frac;
      shares -= o.shares;
    }
  }
  if (!complete || !currency || !(shares > 0) || !(amount > 0)) return null;
  return { currency, amount, rate: thenEgp / amount };
}

export const holdingCaps = (ctxOf: () => AppCtx) => [
  query({
    name: 'exchange.list',
    context: 'holdings',
    summary: 'Every exchange this ledger keeps a book for — its own wallet, its own clouds wallet, its own orders.',
    detail: 'Every capability that reads or writes the share book takes an exchangeId and defaults to the first one, so this is where a second book\'s id is found.',
    input: z.object({ includeArchived: z.boolean().default(false) }),
    output: z.array(z.object({
      id: z.string(), name: z.string(),
      /** the broker's own mark — an icon name or `img:<id>`; null until one is given */
      logo: z.string().nullable(),
      walletNodeId: z.string(), cloudsNodeId: z.string(),
      archived: z.boolean(),
    })),
    handler: async ({ includeArchived }) => {
      const { db } = ctxOf();
      return db.select().from(t.exchanges).all()
        .filter((e) => includeArchived || !e.archived)
        .map((e) => ({
          id: e.id, name: e.name, logo: e.logo ?? null,
          walletNodeId: e.walletNodeId, cloudsNodeId: e.cloudsNodeId,
          archived: e.archived,
        }));
    },
  }),

  command({
    name: 'exchange.add',
    context: 'holdings',
    summary: 'Open a second book. It gets its own wallet and its own clouds wallet, on exactly the terms the first exchange\'s were made.',
    detail: 'Nothing that already calls order.log, book.transfer or positions.list has to change: each still defaults to the first exchange, and this is how a caller opens another one beside it.',
    input: z.object({
      name: z.string().min(1).max(80),
      /** the broker's mark — an icon name, or `img:<id>` for a logo already uploaded */
      logo: z.string().max(120).optional(),
    }),
    output: z.object({
      id: z.string(), walletNodeId: z.string(), cloudsNodeId: z.string(), summary: z.string(),
    }),
    handler: async ({ name, logo }) => {
      const { db } = ctxOf();
      const id = newId('exch');
      const walletNodeId = newId('wallet');
      const cloudsNodeId = newId('clouds');
      // The same furniture the first exchange has, made the same way `ensureStructuralNodes`
      // makes it for that one: cash, held at the broker, face-valued in pounds, waiting for an
      // order to spend it. Only the ids differ — the first exchange kept the ones it always had.
      db.insert(t.nodes).values({
        id: walletNodeId, kind: 'cash', name: `${name} wallet`,
        currency: 'EGP', valuation: 'face', priceKey: walletNodeId, openingQty: 0, archived: false,
      }).run();
      db.insert(t.nodes).values({
        id: cloudsNodeId, kind: 'cash', name: `${name} clouds`,
        currency: 'EGP', valuation: 'face', priceKey: cloudsNodeId, openingQty: 0, archived: false,
      }).run();
      db.insert(t.exchanges).values({
        id, name, logo: logo ?? null, walletNodeId, cloudsNodeId,
        archived: false, createdAt: new Date().toISOString(),
      }).run();
      return { id, walletNodeId, cloudsNodeId, summary: `${name} opened, with its own wallet and its own clouds` };
    },
  }),

  command({
    name: 'exchange.rename',
    context: 'holdings',
    summary: 'Rename an exchange, or give it the broker\'s mark. Its wallet, its clouds wallet and everything logged against it keep their own names.',
    detail: 'The name and the mark are the same edit to the same row, so either may be given on its own: a book being renamed keeps the mark it has, and a book given a mark keeps the name it has.',
    input: z.object({
      exchangeId: z.string().min(1),
      name: z.string().min(1).max(80).optional(),
      /** an icon name, or `img:<id>` for a logo already uploaded; an empty string takes it off */
      logo: z.string().max(120).optional(),
    }),
    output: Outcome,
    handler: async ({ exchangeId, name, logo }) => {
      const { db } = ctxOf();
      const row = db.select().from(t.exchanges).where(eq(t.exchanges.id, exchangeId)).get();
      if (!row) return refusal('not_found', `${exchangeId} is not an exchange in this ledger.`);
      if (name === undefined && logo === undefined) {
        return refusal('invalid_period', 'Nothing was given to change.',
                       'Give a name, a mark, or both.');
      }
      db.update(t.exchanges).set({
        ...(name === undefined ? {} : { name }),
        ...(logo === undefined ? {} : { logo: logo === '' ? null : logo }),
      }).where(eq(t.exchanges.id, exchangeId)).run();
      return noted(name === undefined ? `${row.name} wears its broker's mark now`
                 : `${row.name} renamed to ${name}`);
    },
  }),

  command({
    name: 'exchange.archive',
    context: 'holdings',
    summary: 'Retire an exchange. One with no orders and a wallet that has never moved is forgotten outright; one that has ever been used is archived instead.',
    detail: 'The same rule as everywhere else in this ledger: a thing is deleted only when nothing points at it. An exchange that has logged an order, or whose wallet or clouds wallet has ever carried a movement, is kept — off the pickers, its book still readable exactly as it was — rather than pulled out from under records that still name it.',
    effect: 'irreversible',
    input: z.object({ exchangeId: z.string().min(1) }),
    output: Outcome,
    handler: async ({ exchangeId }) => {
      const ctx = ctxOf();
      const row = ctx.db.select().from(t.exchanges).where(eq(t.exchanges.id, exchangeId)).get();
      if (!row) return refusal('not_found', `${exchangeId} is not an exchange in this ledger.`);
      if (exchangeId === DEFAULT_EXCHANGE_ID) {
        // The three holdings the ledger is built on cannot be deleted either, for the same
        // reason: without this one there is nowhere for every capability that means "the
        // book" without naming one to default to.
        return refusal('immutable', `${row.name} is the book every other capability defaults to.`,
                       'It holds nothing and costs nothing to keep. Open a second exchange instead.');
      }

      const orderCount = ctx.db.select().from(t.orders).where(eq(t.orders.exchangeId, exchangeId)).all().length;
      const wallets = [row.walletNodeId, row.cloudsNodeId];
      const moved = ctx.db.select().from(t.legs).all()
        .filter((l) => wallets.includes(l.fromNodeId ?? '')
                    || wallets.includes(l.toNodeId ?? '')
                    || wallets.includes(l.feeNodeId ?? '')).length;

      if (orderCount === 0 && moved === 0) {
        ctx.db.delete(t.exchanges).where(eq(t.exchanges.id, exchangeId)).run();
        ctx.db.delete(t.nodes).where(inArray(t.nodes.id, wallets)).run();
        return noted(`${row.name} forgotten — nothing had ever been recorded against it`);
      }

      ctx.db.update(t.exchanges).set({ archived: true }).where(eq(t.exchanges.id, exchangeId)).run();
      ctx.db.update(t.nodes).set({ archived: true }).where(inArray(t.nodes.id, wallets)).run();
      return noted(`${row.name} archived — its book stays readable, and it is off the pickers`);
    },
  }),

  command({
    name: 'metal.buy',
    context: 'holdings',
    summary: 'Buy gold or silver, paid for out of a named account. Grams in, money out.',
    detail: 'Give the price per gram you actually paid. Net worth does not change — value moves between two things you own — except for the making charge and any flat fee, which are spent rather than held.',
    input: z.object({
      accountId: NodeId,
      metal: z.enum(['gold', 'silver']).default('gold'),
      grams: z.number().positive(),
      pricePerGram: z.number().positive().optional(),
      /** the currency the price and the making charge are quoted in; pounds unless said */
      currency: z.string().length(3).optional(),
      /** the making charge — مصنعية — per gram, in the same currency as the price */
      makingPerGram: z.number().min(0).optional(),
      /**
       * A flat charge on the purchase itself, in the account's own currency — a dealer's
       * commission, a transfer charge, a receipt fee. It is not the making charge, which is
       * quoted per gram and rides on the gram price; this is one charge for the purchase,
       * however much metal it bought. Like the making charge it buys no weight, so it leaves
       * the account and the holding does not grow by it.
       */
      fee: z.number().min(0).default(0),
      date: DateOnly.optional(),
      note: z.string().max(300).optional(),
      /**
       * Worn, or held as a store of value.
       *
       * Jewellery in ordinary use is outside zakat on the position this ledger follows, and
       * metal kept as a holding is inside it — so the two cannot sit in one weight. Unstated,
       * a lot is a holding, which is the reading that owes rather than the one that does not.
       */
      intention: z.enum(['personal', 'investment']).default('investment'),
    }).merge(DryRun),
    output: Outcome,
    handler: async (input) => {
      const ctx = ctxOf();
      const acct = ctx.ledger().node(input.accountId);
      if (!acct) return refusal('unknown_node', `${input.accountId} is not an account in this ledger.`);
      const holding = ctx.db.select().from(t.nodes).where(eq(t.nodes.id, input.metal)).get();
      if (!holding) return refusal('not_found', `This ledger has no ${input.metal} holding to add to.`);

      const market = readMarket(ctx.db);
      const inForce = input.metal === 'silver' ? (market.prices.silver_g ?? 0) : market.goldPerG;
      const q = quoted(market, input, inForce);
      const perGram = q.perGramEgp;
      if (!(perGram > 0)) {
        return refusal('missing_rate', `No price is recorded for ${input.metal}.`,
                       'Set one in the Gold and silver screen, or give a price per gram here.');
      }
      const costEgp = input.grams * perGram;
      const rate = acct.currency === 'EGP' ? 1 : market.fxRates[acct.currency ?? 'EGP'] ?? 1;
      const costNative = costEgp / rate;
      // Workmanship leaves the same account and buys no weight, so it rides as the leg's fee
      // rather than as part of what the metal cost: the money goes, the holding does not grow
      // by it, and the gram is never valued at a price that included it.
      // The flat charge sits alongside it: both leave the account, neither buys a gram, so
      // they ride together as the leg's fee and the gram is never valued at a price that
      // included either of them.
      const makingNative = q.makingEgp / rate;
      const chargesNative = makingNative + input.fee;
      // What the lot is recorded as costing, though: the making charge is added to the gram
      // price before the weight multiplies it, so the total on the row is the same total the
      // dealer actually asked for — grams x (price a gram + making a gram) — not the metal
      // alone with the workmanship left to be inferred from a second column.
      const totalEgp = costEgp + q.makingEgp;
      const date = input.date ?? today(ctx);
      const id = newId('lot');

      return post(ctx, {
        date, kind: 'purchase', note: input.note,
        legs: [{
          fromNodeId: input.accountId, qtyFrom: costNative, toNodeId: holding.id, qtyTo: input.grams,
          ...(chargesNative > 0 ? { feeQty: chargesNative, feeNodeId: input.accountId } : {}),
        }],
      }, `${input.grams} g of ${input.metal} at ${q.priceNative} ${q.currency} a gram${
        q.makingNative > 0 ? ` plus ${q.makingNative} ${q.currency} a gram making` : ''
      }${input.fee > 0 ? ` and a ${input.fee} ${acct.currency ?? ''} fee` : ''
      }, ${Math.round(costNative + chargesNative)} ${acct.currency ?? ''} out of ${acct.name}`,
      {
        dryRun: input.dryRun,
        index: [{ kind: 'lot', recordId: id, title: `${input.metal} buy ${input.grams} g`, body: input.note ?? '' }],
        after: (db, movementId) => {
          db.insert(t.goldLots).values({
            id, seq: nextSeq(db, 'gold_lots'), dateText: date, date, metal: input.metal,
            direction: 'buy', grams: input.grams, pricePerGram: perGram, totalEgp, fee: input.fee,
            usdPaid: acct.currency === 'USD' ? costNative + chargesNative : totalEgp / (market.usdEgp || 1),
            accountId: input.accountId, movementId, note: input.note ?? null,
            intention: input.intention,
            currency: q.currency, priceNative: q.priceNative,
            makingPerGram: q.makingNative, makingEgp: q.makingEgp,
            // The account's own side of the same purchase — what actually left it, in its
            // own currency, at the rate that applied — kept apart from `currency`/
            // `priceNative` above, which are the dealer's quote and answer a different
            // question entirely.
            sourceCurrency: acct.currency ?? 'EGP', sourceAmount: costNative + chargesNative,
            sourceRate: rate,
          }).run();
        },
      });
    },
  }),

  command({
    name: 'metal.sell',
    context: 'holdings',
    summary: 'Sell gold or silver. Grams out, money into a named account.',
    input: z.object({
      accountId: NodeId,
      metal: z.enum(['gold', 'silver']).default('gold'),
      grams: z.number().positive(),
      pricePerGram: z.number().positive().optional(),
      /** the currency the price and any deduction are quoted in; pounds unless said */
      currency: z.string().length(3).optional(),
      /** what the dealer takes off per gram — the making charge you do not get back */
      makingPerGram: z.number().min(0).optional(),
      /**
       * A flat fee taken out of the proceeds, in the account's own currency — a dealer's or a
       * bank's charge for the sale itself, distinct from the making charge quoted per gram.
       */
      fee: z.number().min(0).default(0),
      date: DateOnly.optional(),
      note: z.string().max(300).optional(),
      /** which weight it came out of: the worn jewellery, or the holding */
      intention: z.enum(['personal', 'investment']).default('investment'),
    }).merge(DryRun),
    output: Outcome,
    handler: async (input) => {
      const ctx = ctxOf();
      const acct = ctx.ledger().node(input.accountId);
      if (!acct) return refusal('unknown_node', `${input.accountId} is not an account in this ledger.`);
      const holding = ctx.db.select().from(t.nodes).where(eq(t.nodes.id, input.metal)).get();
      if (!holding) return refusal('not_found', `This ledger has no ${input.metal} holding to sell from.`);

      const held = ctx.ledger().balance(holding.id);
      if (input.grams > held) {
        return refusal('insufficient_funds',
                       `You hold ${held.toFixed(2)} g of ${input.metal}, which is ${(input.grams - held).toFixed(2)} g short.`,
                       'Sell less, or record the purchase that is missing.');
      }

      const market = readMarket(ctx.db);
      const inForce = input.metal === 'silver' ? (market.prices.silver_g ?? 0) : market.goldPerG;
      const q = quoted(market, input, inForce);
      const perGram = q.perGramEgp;
      if (!(perGram > 0)) {
        return refusal('missing_rate', `No price is recorded for ${input.metal}.`,
                       'Set one in the Gold and silver screen, or give a price per gram here.');
      }
      // Selling, workmanship is money you do not get back rather than money you hand over, so
      // it comes off what arrives instead of riding as a fee. A deduction that swallows the
      // whole sale is a typed figure, not a sale, and is refused rather than posted as nought.
      const proceedsEgp = input.grams * perGram - q.makingEgp;
      if (!(proceedsEgp > 0)) {
        return refusal('unbalanced',
                       `A making charge of ${q.makingNative} ${q.currency} a gram takes the whole sale.`,
                       'Lower the deduction, or raise the price a gram.');
      }
      const rate = acct.currency === 'EGP' ? 1 : market.fxRates[acct.currency ?? 'EGP'] ?? 1;
      // The making charge is quoted a gram and comes off before the rate is applied, because
      // it was struck in the metal's own quoted currency; the fee is a flat charge on the sale
      // itself, given directly in the account's currency, so it comes off after.
      const proceeds = proceedsEgp / rate - input.fee;
      if (!(proceeds > 0)) {
        return refusal('unbalanced',
                       `A fee of ${input.fee} ${acct.currency ?? ''} takes the whole sale.`,
                       'Lower the fee, or raise the price a gram.');
      }
      const date = input.date ?? today(ctx);

      return post(ctx, {
        date, kind: 'sale', note: input.note,
        legs: [{ fromNodeId: holding.id, qtyFrom: input.grams, toNodeId: input.accountId, qtyTo: proceeds }],
      }, `${input.grams} g of ${input.metal} at ${q.priceNative} ${q.currency} a gram${
        q.makingNative > 0 ? ` less ${q.makingNative} ${q.currency} a gram making` : ''
      }${input.fee > 0 ? ` less a ${input.fee} ${acct.currency ?? ''} fee` : ''
      }, ${Math.round(proceeds)} ${acct.currency ?? ''} into ${acct.name}`,
      {
        dryRun: input.dryRun,
        index: [{ kind: 'lot', recordId: newId('lot'), title: `${input.metal} sell ${input.grams} g`, body: input.note ?? '' }],
        after: (db, movementId) => {
          db.insert(t.goldLots).values({
            id: newId('lot'), seq: nextSeq(db, 'gold_lots'), dateText: date, date, metal: input.metal,
            direction: 'sell', grams: input.grams, pricePerGram: perGram,
            // Selling, the making charge comes off the gram price before the weight
            // multiplies it, the same formula run the other way — so the total recorded is
            // what was actually paid out, not the gross the making charge was then taken from.
            totalEgp: proceedsEgp, usdPaid: 0,
            // What the sale itself cost, in the account's currency. `totalEgp` is the metal
            // less the making charge; this is taken off after, and is kept so correcting the
            // sale later can take it off again rather than handing it back.
            fee: input.fee,
            accountId: input.accountId, movementId, note: input.note ?? null,
            intention: input.intention,
            currency: q.currency, priceNative: q.priceNative,
            makingPerGram: q.makingNative, makingEgp: q.makingEgp,
          }).run();
        },
      });
    },
  }),

  command({
    name: 'book.transfer',
    context: 'holdings',
    summary: 'Move cash into the brokerage wallet, from an account or from a dividend, or take it back out.',
    detail: 'Money in sits uninvested until an order uses it. Money out returns to a named account — a broker is somewhere you keep money, not somewhere it disappears into. A dividend is the one sort of money that arrives in the wallet without leaving an account of yours, so it comes from outside the ledger and is posted as income rather than as a transfer.',
    input: z.object({
      /** where the money comes from, or goes back to; not an account when a dividend paid it */
      accountId: NodeId.optional(),
      /** which exchange's wallet the money moves into or out of; the first one unless said */
      exchangeId: ExchangeIdIn,
      direction: z.enum(['in', 'out']).default('in'),
      /**
       * What put the money there. An account of yours, or a distribution from a share.
       *
       * Taking money out always goes to an account, so this is only read on the way in.
       */
      source: z.enum(['account', 'dividends']).default('account'),
      /**
       * Which share paid it, when a dividend did; the payout is attributed to that ticker.
       *
       * Taken however it was typed, the same as the notebook takes one — a ledger that holds
       * both `abuk` and `ABUK` holds neither.
       */
      ticker: z.string().min(1).max(12).regex(/^[A-Za-z][A-Za-z0-9.]*$/, 'not a ticker').optional(),
      /** in the currency of whichever side the money leaves — the account, or the book itself */
      amount: z.number().positive(),
      /** the rate actually given, when the account and the book are held in different currencies */
      rateApplied: z.number().positive().optional(),
      /** taken out of what leaves, in the same currency as the amount */
      fee: z.number().min(0).default(0),
      date: DateOnly.optional(), note: z.string().max(300).optional(),
    }).merge(DryRun),
    output: Outcome,
    handler: async (input) => {
      const ctx = ctxOf();
      const exchange = exchangeOf(ctx.db, input.exchangeId);
      if (!exchange) return refusal('not_found', `${input.exchangeId} is not an exchange in this ledger.`);
      const book = ctx.db.select().from(t.nodes).where(eq(t.nodes.id, exchange.walletNodeId)).get();
      if (!book) return refusal('not_found', 'This ledger has no brokerage account.', 'Add one with account.add first.');
      const out = input.direction === 'out';
      const byDividend = !out && input.source === 'dividends';

      if (!byDividend && !input.accountId) {
        return refusal('unknown_node', 'Name the account the money moves between.',
                       out ? 'Money out of the book has to land somewhere.' : 'Or say source: "dividends".');
      }
      const acct = input.accountId ? ctx.ledger().node(input.accountId) : undefined;
      if (input.accountId && !acct) {
        return refusal('unknown_node', `${input.accountId} is not an account in this ledger.`);
      }

      if (byDividend) {
        /**
         * Where a dividend comes from.
         *
         * It is not a transfer: no account of yours is any lighter for it. So it arrives from
         * outside the ledger, through an external node made on first payout, and it is posted
         * as income — which is what puts it in the income totals where it belongs. One node
         * per payer, so a year can be read back by who paid it.
         */
        const payer = input.ticker ? input.ticker.toUpperCase() : null;
        const extId = payer ? `ext-div-${payer}` : 'ext-dividends';
        const name = payer ? `${payer} dividends` : 'Dividends';
        ctx.db.insert(t.nodes).values({
          id: extId, kind: 'external', name, currency: book.currency,
          valuation: 'face', openingQty: 0, archived: false,
        }).onConflictDoNothing().run();

        return post(ctx, {
          date: input.date ?? today(ctx), kind: 'income', note: input.note,
          legs: [{ fromNodeId: extId, toNodeId: book.id, qtyFrom: input.amount }],
        }, `${input.amount} into the book from ${name.toLowerCase()}`,
        {
          dryRun: input.dryRun,
          index: [{ kind: 'income', title: name, body: input.note ?? '' }],
        });
      }

      // The book and the account can be held in different currencies, the same as any two
      // accounts of yours — so this is an exchange when they differ, priced at the rate
      // actually given rather than assumed to be one-for-one, exactly as movement.transfer
      // reads a transfer between two accounts.
      const fromCur = (out ? book.currency : acct!.currency) ?? 'EGP';
      const toCur = (out ? acct!.currency : book.currency) ?? 'EGP';
      const crosses = fromCur !== toCur;
      const market = readMarket(ctx.db);
      const mid = crosses ? (market.fxRates[fromCur] ?? 1) / (market.fxRates[toCur] ?? 1) : undefined;
      const rate = input.rateApplied ?? (crosses ? mid : undefined);
      const net = Math.max(0, input.amount - input.fee);
      const arrives = rate ? net * rate : net;

      return post(ctx, {
        date: input.date ?? today(ctx), kind: crosses ? 'exchange' : 'transfer', note: input.note,
        legs: [out
          ? { fromNodeId: book.id, toNodeId: input.accountId, qtyFrom: net, rateApplied: rate,
              feeQty: input.fee || undefined, feeNodeId: input.fee ? book.id : undefined }
          : { fromNodeId: input.accountId, toNodeId: book.id, qtyFrom: net, rateApplied: rate,
              feeQty: input.fee || undefined, feeNodeId: input.fee ? input.accountId : undefined }],
      }, out
        ? `${input.amount} ${fromCur} out of the book, ${Math.round(arrives)} ${toCur} into ${acct?.name ?? '?'}`
        : `${input.amount} ${fromCur} out of ${acct?.name ?? '?'}, ${Math.round(arrives)} ${toCur} into the book`,
      { dryRun: input.dryRun,
        warnings: crosses && !input.rateApplied
          ? [`No rate was given, so the mid-market rate of ${mid?.toFixed(4)} was recorded.`]
          : [] });
    },
  }),

  command({
    name: 'order.log',
    context: 'holdings',
    summary: 'Log a share order. An executed order moves cash and the position; a pending one does not.',
    detail: 'Status matters: only an executed order changes what you hold. Pending and cancelled orders are recorded so the book reads correctly, and move nothing.',
    input: z.object({
      ticker: Ticker, side: z.enum(['BUY', 'SELL']),
      shares: z.number().positive(), price: z.number().positive(),
      status: z.enum(['executed', 'pending', 'cancelled']).default('executed'),
      /** which exchange this order was placed on; the first one unless said */
      exchangeId: ExchangeIdIn,
      /**
       * What the broker charged for this order, once, in the wallet's own currency — never
       * per share. A buy takes the shares' price plus the fee out of the wallet; a sale puts
       * the price less the fee back into it.
       */
      fee: z.number().min(0).default(0),
      /** why these shares are held — personal, or held as a holding — which decides whether zakat reaches them */
      intention: z.enum(['personal', 'investment']).optional(),
      date: DateOnly.optional(), time: z.string().max(8).optional(),
      /** why you did it — the part worth reading back a year later */
      note: z.string().max(500).optional(),
      /**
       * The account this buy is understood to have been funded from, when it can be named.
       * Read only on an executed BUY — a share is bought out of the pooled brokerage wallet,
       * so naming one moves nothing, but it lets the purchase be asked what that account's
       * own money would be worth now, apart from what the share itself did.
       */
      accountId: NodeId.optional(),
      /** the rate that applied that day, EGP per unit of that account's currency; today's rate stands in if not said */
      rateApplied: z.number().positive().optional(),
    }).merge(DryRun),
    output: Outcome,
    handler: async (input) => {
      const ctx = ctxOf();
      const date = input.date ?? today(ctx);
      const total = input.shares * input.price;
      /**
       * What the wallet actually moves. The fee is charged for the order, not for each share
       * in it, so it is added once to a buy and taken once off a sale — `total` stays what the
       * shares themselves came to, which is what the price column is read against.
       */
      const cash = input.side === 'BUY' ? total + input.fee : total - input.fee;
      if (input.side === 'SELL' && !(cash > 0)) {
        return refusal('unbalanced', `A fee of ${input.fee} takes the whole sale.`,
                       'Lower the fee, or raise the price a share.');
      }
      const id = newId('ord');

      if (input.status !== 'executed') {
        if (input.dryRun) return noted(`${input.side} ${input.shares} ${input.ticker} would be logged as ${input.status}`);
        ctx.db.insert(t.orders).values({
          id, seq: nextSeq(ctx.db, 'orders'), date, time: input.time ?? null,
          exchangeId: input.exchangeId,
          ticker: input.ticker, side: input.side, shares: input.shares,
          price: input.price, total, fee: input.fee, intention: input.intention ?? null,
          status: input.status, note: input.note ?? null,
        }).run();
        return noted(`${input.side} ${input.shares} ${input.ticker} logged as ${input.status} — nothing moved`);
      }

      const exchange = exchangeOf(ctx.db, input.exchangeId);
      if (!exchange) return refusal('not_found', `${input.exchangeId} is not an exchange in this ledger.`);
      const book = ctx.db.select().from(t.nodes).where(eq(t.nodes.id, exchange.walletNodeId)).get();
      const position = ctx.db.select().from(t.nodes).where(eq(t.nodes.priceKey, input.ticker)).get();
      if (!book) return refusal('not_found', 'This ledger has no brokerage cash account.');

      const src = input.side === 'BUY'
        ? orderSource(ctx, input.accountId, input.rateApplied, book.currency, cash)
        : { fields: null } as const;
      if ('refusal' in src) return src.refusal;

      const legs = position
        ? [input.side === 'BUY'
            ? { fromNodeId: book.id, qtyFrom: cash, toNodeId: position.id, qtyTo: input.shares }
            : { fromNodeId: position.id, qtyFrom: input.shares, toNodeId: book.id, qtyTo: cash }]
        : [input.side === 'BUY'
            ? { fromNodeId: book.id, qtyFrom: cash }
            : { toNodeId: book.id, qtyFrom: cash }];

      return post(ctx, { date, kind: input.side === 'BUY' ? 'purchase' : 'sale', note: input.note, legs },
        `${input.side} ${input.shares} ${input.ticker} at ${input.price}${input.fee > 0 ? `, fee ${input.fee}` : ''}`,
        {
          dryRun: input.dryRun,
          index: [{ kind: 'order', recordId: id, title: `${input.ticker} ${input.side}`, body: `${input.shares} at ${input.price}` }],
          warnings: position ? [] : [`No position node exists for ${input.ticker}, so only the cash side was recorded.`],
          after: (db, movementId) => {
            const seq = nextSeq(db, 'orders');
            const { realizedPnl, realizedPnlPct } = realizedFields(db, input.exchangeId, input.ticker, input.side, input.shares, cash, seq);
            db.insert(t.orders).values({
              id, seq, date, time: input.time ?? null,
              exchangeId: input.exchangeId,
              ticker: input.ticker, side: input.side, shares: input.shares,
              price: input.price, total, fee: input.fee, intention: input.intention ?? null,
              status: 'executed', movementId,
              note: input.note ?? null,
              realizedPnl, realizedPnlPct,
              accountId: src.fields?.accountId ?? null,
              sourceCurrency: src.fields?.sourceCurrency ?? null,
              sourceAmount: src.fields?.sourceAmount ?? null,
              sourceRate: src.fields?.sourceRate ?? null,
            }).run();
          },
        });
    },
  }),

  command({
    name: 'order.correct',
    context: 'holdings',
    summary: 'Correct an order already logged — the ticker, the side, the shares, the price, the fee, the intention, the status, the date, the note.',
    detail: 'An executed order moved cash and the position, so correcting one reverses that movement and writes it again. An order that never executed moved nothing, and only its record changes.',
    input: z.object({
      orderId: z.string(),
      ticker: Ticker.optional(), side: z.enum(['BUY', 'SELL']).optional(),
      shares: z.number().positive().optional(), price: z.number().positive().optional(),
      status: z.enum(['executed', 'pending', 'cancelled']).optional(),
      /** which exchange this order belongs to; the one already on the row unless said */
      exchangeId: z.string().min(1).optional(),
      date: DateOnly.optional(), time: z.string().max(8).optional(),
      note: z.string().max(500).optional(),
      /** what the broker charged for the order as a whole; the one already on the row unless said */
      fee: z.number().min(0).optional(),
      /** why these shares are held; the answer already on the row unless said */
      intention: z.enum(['personal', 'investment']).optional(),
      /** the account this buy is understood to have been funded from; the one already on the row unless said */
      accountId: NodeId.optional(),
      /** the rate applied that day; the one already on the row unless said */
      rateApplied: z.number().positive().optional(),
    }),
    output: Outcome,
    handler: async (input) => {
      const ctx = ctxOf();
      const row = ctx.db.select().from(t.orders).where(eq(t.orders.id, input.orderId)).get();
      if (!row) return refusal('not_found', 'There is no such order.');

      const next = {
        ticker: input.ticker ?? row.ticker,
        side: (input.side ?? row.side) as 'BUY' | 'SELL',
        shares: input.shares ?? row.shares,
        price: input.price ?? row.price,
        status: input.status ?? row.status,
        exchangeId: input.exchangeId ?? row.exchangeId ?? DEFAULT_EXCHANGE_ID,
        date: input.date ?? row.date,
        time: input.time ?? row.time ?? null,
        note: input.note ?? row.note ?? null,
        fee: input.fee ?? (row as { fee?: number | null }).fee ?? 0,
        intention: input.intention ?? (row as { intention?: string | null }).intention ?? null,
      };
      const total = next.shares * next.price;
      // The same arithmetic order.log does: the charge belongs to the order, so it is added
      // once to a buy and taken once off a sale, and `total` stays what the shares came to.
      const cash = next.side === 'BUY' ? total + next.fee : total - next.fee;
      // What is not being asked to change keeps what the row already says — including the
      // rate, so correcting the shares or the price does not quietly re-quote a buy's source
      // money at today's rate instead of the one that actually applied.
      const nextAccountId = input.accountId ?? (row as { accountId?: string | null }).accountId ?? undefined;
      const sameAccount = !input.accountId || input.accountId === (row as { accountId?: string | null }).accountId;
      const preferredRate = sameAccount ? (row as { sourceRate?: number | null }).sourceRate ?? undefined : undefined;

      return atomically(ctx, () => {
        undoMovement(ctx, row.movementId);
        ctx.db.delete(t.orders).where(eq(t.orders.id, input.orderId)).run();

        // Nothing moved and nothing moves: the record is the whole of it.
        if (next.status !== 'executed') {
          ctx.db.insert(t.orders).values({
            id: input.orderId, seq: row.seq, date: next.date, time: next.time,
            exchangeId: next.exchangeId,
            ticker: next.ticker, side: next.side, shares: next.shares,
            price: next.price, total, fee: next.fee, intention: next.intention,
            status: next.status, note: next.note,
          }).run();
          return noted(`${next.side} ${next.shares} ${next.ticker} corrected — logged as ${next.status}, nothing moved`);
        }

        const exchange = exchangeOf(ctx.db, next.exchangeId);
        if (!exchange) return refusal('not_found', `${next.exchangeId} is not an exchange in this ledger.`);
        const book = ctx.db.select().from(t.nodes).where(eq(t.nodes.id, exchange.walletNodeId)).get();
        if (!book) return refusal('not_found', 'This ledger has no brokerage cash account.');
        const position = ctx.db.select().from(t.nodes).where(eq(t.nodes.priceKey, next.ticker)).get();

        if (next.side === 'SELL' && !(cash > 0)) {
          return refusal('unbalanced', `A fee of ${next.fee} takes the whole sale.`,
                         'Lower the fee, or raise the price a share.');
        }

        const src = next.side === 'BUY'
          ? orderSource(ctx, nextAccountId, input.rateApplied, book.currency, cash, preferredRate)
          : { fields: null } as const;
        if ('refusal' in src) return src.refusal;

        const legs = position
          ? [next.side === 'BUY'
              ? { fromNodeId: book.id, qtyFrom: cash, toNodeId: position.id, qtyTo: next.shares }
              : { fromNodeId: position.id, qtyFrom: next.shares, toNodeId: book.id, qtyTo: cash }]
          : [next.side === 'BUY'
              ? { fromNodeId: book.id, qtyFrom: cash }
              : { toNodeId: book.id, qtyFrom: cash }];

        return post(ctx, {
          date: next.date, kind: next.side === 'BUY' ? 'purchase' : 'sale',
          note: next.note ?? undefined, legs,
        }, `corrected: ${next.side} ${next.shares} ${next.ticker} at ${next.price}${next.fee > 0 ? `, fee ${next.fee}` : ''}`,
        {
          index: [{ kind: 'order', recordId: input.orderId,
                    title: `${next.ticker} ${next.side}`, body: `${next.shares} at ${next.price}` }],
          warnings: position ? [] : [`No position node exists for ${next.ticker}, so only the cash side was recorded.`],
          after: (db, movementId) => {
            const { realizedPnl, realizedPnlPct } = realizedFields(db, next.exchangeId, next.ticker, next.side, next.shares, cash, row.seq);
            db.insert(t.orders).values({
              id: input.orderId, seq: row.seq, date: next.date, time: next.time,
              exchangeId: next.exchangeId,
              ticker: next.ticker, side: next.side, shares: next.shares,
              price: next.price, total, fee: next.fee, intention: next.intention,
              status: 'executed', movementId, note: next.note,
              realizedPnl, realizedPnlPct,
              accountId: src.fields?.accountId ?? null,
              sourceCurrency: src.fields?.sourceCurrency ?? null,
              sourceAmount: src.fields?.sourceAmount ?? null,
              sourceRate: src.fields?.sourceRate ?? null,
            }).run();
          },
        });
      });
    },
  }),

  command({
    name: 'metal.correctLot',
    context: 'holdings',
    summary: 'Correct a purchase or sale of metal — the grams, the price a gram, the account, the date, the note.',
    detail: 'The movement is reversed and written again, so both the weight held and the account it was paid out of follow the correction.',
    input: z.object({
      lotId: z.string(),
      accountId: NodeId.optional(),
      grams: z.number().positive().optional(),
      pricePerGram: z.number().positive().optional(),
      /** the currency the price is quoted in; the one the lot already carries unless said */
      currency: z.string().length(3).optional(),
      /** the making charge — مصنعية — per gram, in that currency */
      makingPerGram: z.number().min(0).optional(),
      date: DateOnly.optional(),
      note: z.string().max(300).optional(),
      /** worn or held — the answer that decides whether zakat reaches this weight */
      intention: z.enum(['personal', 'investment']).optional(),
      /** the flat charge on the lot — paid on a buy, taken off a sale — in the account's currency; the lot's own unless said */
      fee: z.number().min(0).optional(),
    }),
    output: Outcome,
    handler: async (input) => {
      const ctx = ctxOf();
      const lot = ctx.db.select().from(t.goldLots).where(eq(t.goldLots.id, input.lotId)).get();
      if (!lot) return refusal('not_found', 'There is no such lot.');

      const metal = lot.metal ?? 'gold';
      const holding = ctx.db.select().from(t.nodes).where(eq(t.nodes.id, metal)).get();
      if (!holding) return refusal('not_found', `This ledger has no ${metal} holding.`);

      const grams = input.grams ?? lot.grams;
      const date = input.date ?? lot.date ?? lot.dateText;
      const note = input.note ?? lot.note ?? undefined;
      const market = readMarket(ctx.db);
      // What the lot already says is the default for what it is not being asked to change —
      // correcting the grams must not quietly re-quote the price in pounds or drop the
      // workmanship that was paid.
      const q = quoted(market, {
        grams,
        currency: input.currency ?? lot.currency ?? 'EGP',
        pricePerGram: input.pricePerGram ?? lot.priceNative ?? lot.pricePerGram,
        makingPerGram: input.makingPerGram ?? lot.makingPerGram ?? 0,
      }, lot.pricePerGram);
      const perGram = q.perGramEgp;
      // The metal alone — grams at the gram price, with nothing added yet. The making charge
      // rides apart from it below, added for a buy and taken off for a sell, which is the same
      // formula the fresh capabilities use and the one the entry form previews.
      const metalEgp = grams * perGram;
      const buying = lot.direction === 'buy';
      const totalEgp = buying ? metalEgp + q.makingEgp : metalEgp - q.makingEgp;
      const intention = input.intention
        ?? (lot as { intention?: string | null }).intention ?? 'investment';

      /**
       * A lot that was already held when the books were opened.
       *
       * It has no movement behind it — its weight sits in the holding's opening figure, and
       * the money that bought it left an account this ledger never saw. So correcting one
       * moves the opening figure by the difference and rewrites the row, rather than posting
       * a purchase that would count the same grams twice and take cash out of an account
       * today for metal bought years ago.
       */
      if (!lot.movementId) {
        const signed = (g: number) => (lot.direction === 'sell' ? -g : g);
        return atomically(ctx, () => {
          ctx.db.update(t.nodes)
            .set({ openingQty: (holding.openingQty ?? 0) + signed(grams) - signed(lot.grams) })
            .where(eq(t.nodes.id, holding.id)).run();
          ctx.db.update(t.goldLots).set({
            dateText: date, date, grams, pricePerGram: perGram, totalEgp,
            usdPaid: totalEgp / (market.usdEgp || 1),
            accountId: input.accountId ?? lot.accountId, note: note ?? null, intention,
            currency: q.currency, priceNative: q.priceNative,
            makingPerGram: q.makingNative, makingEgp: q.makingEgp,
          }).where(eq(t.goldLots.id, input.lotId)).run();
          return noted(`corrected: ${grams} g of ${metal} at ${perGram} a gram, held from before the ledger`);
        });
      }

      const accountId = input.accountId ?? lot.accountId;
      if (!accountId) return refusal('unknown_node', 'That lot names no account.');
      const acct = ctx.ledger().node(accountId);
      if (!acct) return refusal('unknown_node', `${accountId} is not an account in this ledger.`);
      const rate = acct.currency === 'EGP' ? 1 : market.fxRates[acct.currency ?? 'EGP'] ?? 1;
      const native = metalEgp / rate;
      const makingNative = q.makingEgp / rate;
      // The making charge is spent buying and forgone selling, the same way it is when the
      // lot is first recorded: a fee on the money going out, a deduction from what comes in.
      if (!buying && !(metalEgp - q.makingEgp > 0)) {
        return refusal('unbalanced',
                       `A making charge of ${q.makingNative} ${q.currency} a gram takes the whole sale.`,
                       'Lower the deduction, or raise the price a gram.');
      }
      // The lot's own flat charge, in the account's currency, whichever way it went. Left out
      // of a correction it would be silently forgiven: the reversal returns what the lot
      // actually moved and the rewrite would move the gross, so the account would gain the
      // fee every time anything on the row was corrected — including a change to the note.
      const fee = input.fee ?? lot.fee ?? 0;
      const proceeds = (metalEgp - q.makingEgp) / rate - fee;
      if (!buying && !(proceeds > 0)) {
        return refusal('unbalanced',
                       `A fee of ${fee} ${acct.currency ?? ''} takes the whole sale.`,
                       'Lower the fee, or raise the price a gram.');
      }

      return atomically(ctx, () => {
        undoMovement(ctx, lot.movementId);
        ctx.db.delete(t.goldLots).where(eq(t.goldLots.id, input.lotId)).run();

        return post(ctx, {
          date, kind: buying ? 'purchase' : 'sale', note,
          legs: [buying
            ? { fromNodeId: accountId, qtyFrom: native, toNodeId: holding.id, qtyTo: grams,
                ...(makingNative + fee > 0 ? { feeQty: makingNative + fee, feeNodeId: accountId } : {}) }
            : { fromNodeId: holding.id, qtyFrom: grams, toNodeId: accountId, qtyTo: proceeds }],
        }, `corrected: ${grams} g of ${metal} at ${q.priceNative} ${q.currency} a gram${
          q.makingNative > 0 ? `, ${q.makingNative} ${q.currency} a gram making` : ''
        }`,
        {
          index: [{ kind: 'lot', recordId: input.lotId,
                    title: `${metal} ${lot.direction} ${grams} g`, body: note ?? '' }],
          after: (db, movementId) => {
            db.insert(t.goldLots).values({
              id: input.lotId, seq: lot.seq, dateText: date, date, metal,
              direction: lot.direction, grams, pricePerGram: perGram, totalEgp, fee,
              usdPaid: acct.currency === 'USD'
                ? (buying ? native + makingNative + fee : native)
                : totalEgp / (market.usdEgp || 1),
              accountId, movementId, note: note ?? null, intention,
              currency: q.currency, priceNative: q.priceNative,
              makingPerGram: q.makingNative, makingEgp: q.makingEgp,
              // Only a buy has source money behind it — a sale gives money back rather than
              // spending it, so correcting one clears whatever a previous buy at this id left,
              // instead of a sale wrongly inheriting a buy's own reading.
              ...(buying
                ? { sourceCurrency: acct.currency ?? 'EGP', sourceAmount: native + makingNative + fee, sourceRate: rate }
                : { sourceCurrency: null, sourceAmount: null, sourceRate: null }),
            }).run();
          },
        });
      });
    },
  }),

  command({
    name: 'metal.removeLot',
    context: 'holdings',
    summary: 'Remove a purchase or sale of metal from the ledger — reversing what it moved, or leaving it where it went.',
    detail: 'A lot bought through this ledger is reversed: the movement that paid for it gets its opposite, so the account and the weight both come back, and the log keeps both entries. A lot that was already held when the books were opened has no movement to reverse, so the row goes and the holding\'s opening weight comes down with it. Pass reverse false where the metal really was bought or sold and only this record of it is wrong — the row goes and nothing moves.',
    input: z.object({
      lotId: z.string(),
      /** whether what the lot moved is put back */
      reverse: z.boolean().default(true),
    }),
    output: Outcome,
    handler: async (input) => {
      const ctx = ctxOf();
      const lot = ctx.db.select().from(t.goldLots).where(eq(t.goldLots.id, input.lotId)).get();
      if (!lot) return refusal('not_found', 'There is no such lot.');
      const metal = lot.metal ?? 'gold';
      const holding = ctx.db.select().from(t.nodes).where(eq(t.nodes.id, metal)).get();
      if (!holding) return refusal('not_found', `This ledger has no ${metal} holding.`);

      return atomically(ctx, () => {
        if (!input.reverse) {
          // The weight and the money stay exactly where the lot put them; only the row goes.
          ctx.db.delete(t.goldLots).where(eq(t.goldLots.id, input.lotId)).run();
          return noted(`${lot.direction} of ${lot.grams} g of ${metal} taken off the log. What it moved still stands.`);
        }
        if (lot.movementId) {
          undoMovement(ctx, lot.movementId);
        } else {
          const signed = lot.direction === 'sell' ? -lot.grams : lot.grams;
          ctx.db.update(t.nodes).set({ openingQty: (holding.openingQty ?? 0) - signed })
            .where(eq(t.nodes.id, holding.id)).run();
        }
        ctx.db.delete(t.goldLots).where(eq(t.goldLots.id, input.lotId)).run();
        return noted(`removed: ${lot.direction} of ${lot.grams} g of ${metal}`);
      });
    },
  }),

  query({
    name: 'positions.list',
    context: 'holdings',
    summary: 'The share book: every position, its cost, and what it is worth at the price you last set.',
    detail: 'Shares are held from the orders you logged, and valued at whatever price was last recorded for each ticker — fetched from the source chosen under Prices, or set by hand — so a position with no price is shown at cost and says so, rather than quietly counting as zero. Scoped to one exchange, the first unless another is named: the same ticker can be a position on two exchanges at once, each with its own shares and its own average cost.',
    input: z.object({ exchangeId: ExchangeIdIn }),
    output: z.array(z.object({
      ticker: z.string(), shares: z.number(), avgBuy: z.number(),
      cost: z.number(), price: z.number(), value: z.number(), gain: z.number(),
      priced: z.boolean(), pricedAt: z.string().nullable(),
      ...SOURCE_FIELDS,
    })),
    handler: async ({ exchangeId }) => {
      const ctx = ctxOf();
      const market = readMarket(ctx.db);
      const at = new Map(ctx.db.$raw.prepare(`
        SELECT key, at FROM market_ticks WHERE id IN (SELECT MAX(id) FROM market_ticks GROUP BY key)
      `).all().map((r: any) => [r.key, r.at]));
      // Only this exchange's own orders — a position is never built from shares sitting in a
      // book it cannot see.
      const rawOrders = ctx.db.select().from(t.orders).where(eq(t.orders.exchangeId, exchangeId)).all();
      const byTicker = new Map<string, typeof rawOrders>();
      for (const o of rawOrders) (byTicker.get(o.ticker) ?? byTicker.set(o.ticker, []).get(o.ticker)!).push(o);
      const engineOrders = rawOrders as unknown as EngineOrder[];

      return computedPositions(engineOrders, market.prices).map((p) => {
        const priced = market.prices[p.ticker] != null;
        // an unpriced holding is worth what it cost until told otherwise, which is honest
        // rather than optimistic
        const value = priced ? p.value : p.cost;
        return {
          ...p, value, priced,
          pricedAt: (at.get(`price_${p.ticker}`) as string) ?? null,
          gain: value - p.cost,
          ...sourceReading(sourceBehindPosition(byTicker.get(p.ticker) ?? []), value, market),
        };
      });
    },
  }),

  query({
    name: 'installments.due',
    context: 'holdings',
    summary: 'Property payments still ahead, soonest first, with the account each would come out of.',
    input: z.object({ withinDays: z.number().int().min(1).max(3650).default(365) }),
    output: z.array(z.object({
      id: z.string(), propertyId: z.string(), property: z.string(),
      dueOn: z.string(), daysAway: z.number(), amountEgp: z.number(),
      note: z.string(), buysEquity: z.boolean(), autopayFrom: z.string().nullable(),
    })),
    handler: async ({ withinDays }) => {
      const ctx = ctxOf();
      const names = new Map(ctx.db.select().from(t.nodes).all().map((n) => [n.id, n.name]));
      const auto = new Map(ctx.db.select().from(t.autopay).all().map((a) => [a.propertyId, a]));
      const out = [];
      for (const i of ctx.db.select().from(t.installments).all()) {
        if (i.paidAt) continue;
        const due = i.dueDate ? new Date(`${i.dueDate}T12:00:00`)
                              : installmentDueDate(i.monthLabel, i.dueDayKind, i.dueDayNum ?? undefined);
        if (!due) continue;
        const daysAway = Math.round((due.getTime() - ctx.now.getTime()) / 86_400_000);
        if (daysAway < 0 || daysAway > withinDays) continue;
        const a = auto.get(i.propertyId);
        out.push({
          id: i.id, propertyId: i.propertyId, property: names.get(i.propertyId) ?? i.propertyId,
          dueOn: due.toISOString().slice(0, 10), daysAway, amountEgp: i.amountEgp,
          note: i.note, buysEquity: !/maintenance|service|fee/i.test(i.note),
          autopayFrom: a?.enabled ? a.fromNodeId : null,
        });
      }
      return out.sort((a, b) => a.daysAway - b.daysAway);
    },
  }),

  query({
    name: 'installments.list',
    context: 'holdings',
    summary: 'Every payment on every plan — paid and still to come — with what each one bought.',
    detail: 'installments.due answers what is coming; this answers what the plans hold, which includes what has already been paid. A screen that only ever showed the future could not show that a payment had been made.',
    input: z.object({
      propertyId: z.string().optional(),
      status: z.enum(['all', 'paid', 'due']).default('all'),
    }),
    output: z.array(z.object({
      id: z.string(), propertyId: z.string(), property: z.string(),
      dueOn: z.string(), daysAway: z.number(), amountEgp: z.number(),
      note: z.string(), kind: z.string(), buysEquity: z.boolean(),
      paidAt: z.string().nullable(), autopayFrom: z.string().nullable(),
      payFrom: z.string().nullable(), payFromName: z.string().nullable(),
      /** the movement that paid it — undoing that movement is what un-pays it */
      movementId: z.string().nullable(),
    })),
    handler: async ({ propertyId, status }) => {
      const ctx = ctxOf();
      const names = new Map(ctx.db.select().from(t.nodes).all().map((n) => [n.id, n.name]));
      const auto = new Map(ctx.db.select().from(t.autopay).all().map((a) => [a.propertyId, a]));

      /**
       * Which account the money left.
       *
       * For a payment already made this is a fact rather than an intention, and the fact is
       * in the movement: the leg that money came out of. Reading it back from there means a
       * payment made out of the wrong account can be seen, which was the whole problem — the
       * screen could pay but could never say where from.
       */
      const paidOutOf = new Map<string, string>();
      for (const l of ctx.db.select().from(t.legs).all()) {
        if (l.fromNodeId) paidOutOf.set(l.transactionId, l.fromNodeId);
      }

      const out = [];
      for (const i of ctx.db.select().from(t.installments).all()) {
        if (propertyId && i.propertyId !== propertyId) continue;
        if (status === 'paid' && !i.paidAt) continue;
        if (status === 'due' && i.paidAt) continue;
        const due = i.dueDate ? new Date(`${i.dueDate}T12:00:00`)
                              : installmentDueDate(i.monthLabel, i.dueDayKind, i.dueDayNum ?? undefined);
        if (!due) continue;
        const a = auto.get(i.propertyId);
        out.push({
          id: i.id, propertyId: i.propertyId, property: names.get(i.propertyId) ?? i.propertyId,
          dueOn: due.toISOString().slice(0, 10),
          daysAway: Math.round((due.getTime() - ctx.now.getTime()) / 86_400_000),
          amountEgp: i.amountEgp, note: i.note,
          kind: (i as { kind?: string }).kind ?? 'installment',
          buysEquity: !/maintenance|service|fee/i.test(i.note),
          paidAt: i.paidAt ?? null,
          autopayFrom: a?.enabled ? a.fromNodeId : null,
          payFrom: (i.paidAt && i.movementId ? paidOutOf.get(i.movementId) : null)
            ?? i.payFrom ?? (a?.enabled ? a.fromNodeId : null),
          payFromName: (() => {
            const id = (i.paidAt && i.movementId ? paidOutOf.get(i.movementId) : null)
              ?? i.payFrom ?? (a?.enabled ? a.fromNodeId : null);
            return id ? names.get(id) ?? id : null;
          })(),
          movementId: i.movementId ?? null,
        });
      }
      return out.sort((x, y) => x.dueOn.localeCompare(y.dueOn));
    },
  }),

  command({
    name: 'installment.pay',
    context: 'holdings',
    summary: 'Pay a property installment out of a named account, and mark it paid.',
    input: z.object({
      installmentId: z.string(), accountId: NodeId.optional(), date: DateOnly.optional(),
    }).merge(DryRun),
    output: Outcome,
    handler: async (input) => payInstallment(ctxOf(), input),
  }),

  command({
    name: 'installment.correct',
    context: 'holdings',
    summary: 'Correct a payment already made — the amount, which account it came out of, the date, or the note.',
    detail: 'The movement is reversed and written again as you meant it, so the balances follow and the log keeps both. A paid row answers to the same corrections as an unpaid one; the difference is that this one moves money.',
    input: z.object({
      installmentId: z.string(),
      accountId: NodeId.optional(),
      date: DateOnly.optional(),
      /**
       * The day this was originally due — kept even once paid, so the plan still says whether
       * a payment was made on time. Separate from `date`, which is when it was actually paid:
       * conflating the two lost a due date the moment anything else on a paid row was fixed.
       */
      dueDate: DateOnly.optional(),
      amountEgp: z.number().positive().optional(),
      note: z.string().max(300).optional(),
    }),
    output: Outcome,
    handler: async (input) => {
      const ctx = ctxOf();
      const inst = ctx.db.select().from(t.installments).where(eq(t.installments.id, input.installmentId)).get();
      if (!inst) return refusal('not_found', `${input.installmentId} is not an installment.`);
      if (!inst.paidAt) {
        return refusal('invalid_period', 'That payment has not been made yet.',
                       'Change the account on the row and pay it, rather than correcting it.');
      }

      /*
       * Which account it came out of.
       *
       * Stated on the row when the ledger paid it, but a payment carried in from before the
       * books were opened only says so in the movement it wrote. Reading that movement means
       * a correction to the amount or the note does not have to re-answer a question the log
       * already answers.
       */
      const paidFrom = inst.movementId
        ? ctx.db.select().from(t.legs).where(eq(t.legs.transactionId, inst.movementId)).all()
            .map((l) => l.fromNodeId).find((id): id is string => !!id)
        : undefined;
      const from = input.accountId ?? inst.payFrom ?? paidFrom;
      if (!from) return refusal('unknown_node', 'Say which account the payment should have come out of.');
      const date = input.date ?? inst.paidAt;
      const dueDate = input.dueDate ?? inst.dueDate;
      const amount = input.amountEgp ?? inst.amountEgp;
      const note = input.note ?? inst.note;
      const property = ctx.db.select().from(t.nodes).where(eq(t.nodes.id, inst.propertyId)).get();

      // The reversal has to happen before the new payment is written — the money has to be
      // back in the old account before it can leave the new one.
      return atomically(ctx, () => {
        undoMovement(ctx, inst.movementId);
        ctx.db.update(t.installments).set({ paidAt: null, movementId: null })
          .where(eq(t.installments.id, input.installmentId)).run();

        return post(ctx, {
          date, kind: 'installment', note: note || undefined,
          // Whatever it bought, a paid installment counts towards the property's value — see
          // payInstallment.
          legs: [property
            ? { fromNodeId: from, qtyFrom: amount, toNodeId: property.id, qtyTo: amount }
            : { fromNodeId: from, qtyFrom: amount }],
        }, `corrected: ${amount} out of ${ctx.db.select().from(t.nodes).where(eq(t.nodes.id, from)).get()?.name ?? from}`,
        {
          after: (db, movementId) => {
            db.update(t.installments).set({ paidAt: date, movementId, payFrom: from,
                                            amountEgp: amount, note, dueDate })
              .where(eq(t.installments.id, input.installmentId)).run();
            settleOwnership(db, inst.propertyId);
          },
        });
      });
    },
  }),

  query({
    name: 'orders.list',
    context: 'holdings',
    summary: 'Every order ever logged — buys and sells, executed, pending or cancelled.',
    detail: 'positions.list answers what is held now; this answers how it came to be held. '
          + 'An order that is pending or cancelled moved no money and so appears here and '
          + 'nowhere in the positions.',
    input: z.object({
      /** which exchange's orders to read; the first one unless said */
      exchangeId: ExchangeIdIn,
      ticker: z.string().optional(),
      side: z.enum(['BUY', 'SELL']).optional(),
      status: z.enum(['executed', 'pending', 'cancelled']).optional(),
      from: DateOnly.optional(),
      to: DateOnly.optional(),
      limit: z.number().int().positive().max(500).default(200),
    }),
    output: z.array(z.object({
      id: z.string(), date: z.string(), time: z.string().nullable(),
      exchangeId: z.string(),
      ticker: z.string(), side: z.string(), shares: z.number(), price: z.number(),
      total: z.number(), status: z.string(),
      /** what the broker charged for the order as a whole — added to a buy, taken off a sale */
      fee: z.number(),
      /** why these shares are held, stated on the order; null where none was ever stated */
      intention: z.enum(['personal', 'investment']).nullable(),
      note: z.string().nullable(), movementId: z.string().nullable(),
      /**
       * What this sale earned against the average cost of every share behind it, stored the
       * day it was sold. Null for a buy, and null for a sale logged before this was tracked —
       * that ledger never saw a figure, so none is shown rather than one made up after the fact.
       */
      realizedPnl: z.number().nullable(),
      /** the same result as a percentage of what the shares sold had cost */
      realizedPnlPct: z.number().nullable(),
    })),
    handler: async (input) => {
      const { db } = ctxOf();
      return db.select().from(t.orders).all()
        .filter((o) => o.exchangeId === input.exchangeId
                    && (!input.ticker || o.ticker === input.ticker.toUpperCase())
                    && (!input.side || o.side === input.side)
                    && (!input.status || o.status === input.status)
                    && (!input.from || o.date >= input.from)
                    && (!input.to || o.date <= input.to))
        .sort((a, b) => b.date.localeCompare(a.date) || b.seq - a.seq)
        .slice(0, input.limit)
        // Intention is a free-text column in the database, so it is read back as one of the
        // two answers or as none at all — never as whatever string happens to be sitting there.
        .map(({ seq: _seq, ...o }) => ({
          ...o,
          fee: o.fee ?? 0,
          intention: statedIntention(o.intention),
        }));
    },
  }),

  query({
    name: 'metals.lots',
    context: 'holdings',
    summary: 'Every purchase and sale of gold or silver, with the reason it was made.',
    input: z.object({ metal: z.enum(['gold', 'silver']).optional() }),
    output: z.array(z.object({
      id: z.string(), date: z.string().nullable(), dateText: z.string(),
      metal: z.string(), direction: z.string(), grams: z.number(),
      pricePerGram: z.number(), totalEgp: z.number(),
      /** what was quoted, and in what — the pound figures above are the reading of it */
      currency: z.string(), priceNative: z.number(),
      /** the making charge a gram, in that currency, and what it came to in pounds */
      makingPerGram: z.number(), makingEgp: z.number(),
      /** the lot's flat charge, in the account's currency — paid on a buy, taken off a sale */
      fee: z.number(),
      note: z.string().nullable(), movementId: z.string().nullable(),
      accountId: z.string().nullable(),
      intention: z.string(),
      /** this lot's weight at today's price — what `sourceComparison` reads it against */
      valueEgp: z.number(),
      ...SOURCE_FIELDS,
    })),
    handler: async ({ metal }) => {
      const { db } = ctxOf();
      const market = readMarket(db);
      return db.select().from(t.goldLots).all()
        .filter((l) => !metal || (l.metal ?? 'gold') === metal)
        .map((l) => {
          const perGramNow = (l.metal ?? 'gold') === 'silver' ? (market.prices.silver_g ?? 0) : market.goldPerG;
          const valueEgp = l.grams * perGramNow;
          return { ...l, metal: l.metal ?? 'gold',
                   intention: (l as { intention?: string | null }).intention ?? 'investment',
                   // rows written before metal could be quoted in anything but pounds
                   currency: l.currency ?? 'EGP',
                   priceNative: l.priceNative ?? l.pricePerGram,
                   makingPerGram: l.makingPerGram ?? 0, makingEgp: l.makingEgp ?? 0,
                   // rows written before a sale could carry one
                   fee: l.fee ?? 0,
                   valueEgp,
                   ...sourceReading(
                     { currency: l.sourceCurrency ?? null, amount: l.sourceAmount ?? null, rate: l.sourceRate ?? null },
                     valueEgp, market),
                 };
        })
        .sort((a, b) => (b.date ?? b.dateText).localeCompare(a.date ?? a.dateText));
    },
  }),

  query({
    name: 'plan.read',
    context: 'holdings',
    summary: 'A property\'s payment plan: every installment, what it is for, and whether it is paid.',
    input: z.object({ propertyId: z.string() }),
    output: z.object({
      propertyId: z.string(), property: z.string(),
      total: z.number(), paid: z.number(), remaining: z.number(),
      /** paid over total, 0 to 1; nought when the plan holds nothing yet */
      paidShare: z.number(),
      installments: z.array(z.object({
        id: z.string(), monthLabel: z.string(), dueDate: z.string().nullable(),
        amountEgp: z.number(), note: z.string(), kind: z.string(),
        paidAt: z.string().nullable(), buysEquity: z.boolean(),
        /** this payment's weight in the plan, so a reader can say what each one buys */
        share: z.number(),
      })),
    }),
    handler: async ({ propertyId }) => {
      const ctx = ctxOf();
      const node = ctx.db.select().from(t.nodes).where(eq(t.nodes.id, propertyId)).get();
      const rows = ctx.db.select().from(t.installments).all()
        .filter((i) => i.propertyId === propertyId)
        .map((i) => ({
          id: i.id, monthLabel: i.monthLabel,
          dueDate: i.dueDate ?? (installmentDueDate(i.monthLabel, i.dueDayKind, i.dueDayNum ?? undefined)?.toISOString().slice(0, 10) ?? null),
          amountEgp: i.amountEgp, note: i.note, kind: (i as { kind?: string }).kind ?? 'installment',
          paidAt: i.paidAt, buysEquity: !/maintenance|service|fee/i.test(i.note),
        }))
        .sort((a, b) => (a.dueDate ?? '').localeCompare(b.dueDate ?? ''));

      const total = rows.reduce((s2, r) => s2 + r.amountEgp, 0);
      // What has actually gone into it: the opening/down payment counts as paid, the same as
      // it does on the assets list — it sat in the property's value before this plan's own
      // rows existed, and reading only the rows is what made this and `assets.list` disagree
      // about the same property.
      const paid = rows.length === 0 ? 0 : (node?.openingQty ?? 0)
        + rows.filter((r) => r.paidAt).reduce((s2, r) => s2 + r.amountEgp, 0);
      // A share of nothing is nought rather than an error: an empty plan is a plan not yet made.
      const share = (n: number) => (total > 0 ? n / total : 0);
      return {
        propertyId, property: node?.name ?? propertyId,
        total, paid, remaining: total - paid, paidShare: share(paid),
        installments: rows.map((r) => ({ ...r, share: share(r.amountEgp) })),
      };
    },
  }),

  command({
    name: 'plan.upsert',
    context: 'holdings',
    summary: 'Add a payment to a property\'s plan, or change one that is not yet paid.',
    detail: 'A payment already made cannot be edited here — it is a movement, and `installment.correct` is what changes it. Everything still ahead is yours to reshape. A payment that was made before the plan was written down can be added as paid, by naming the account it came out of.',
    input: z.object({
      propertyId: z.string(),
      installmentId: z.string().optional(),
      monthLabel: z.string().max(20).optional(),
      dueDate: DateOnly.optional(),
      amountEgp: z.number().positive().optional(),
      note: z.string().max(200).optional(),
      kind: z.enum(['installment', 'maintenance', 'fee', 'expense']).optional(),
      /** the account it is meant to come out of, decided ahead of paying it */
      payFrom: z.string().optional(),
      /**
       * The account a payment already made came out of.
       *
       * A plan is usually written down after some of it has been paid, and saying so at the
       * moment the row is added is the whole difference between recording what happened and
       * recording an intention you then have to go back and correct. Naming an account here
       * writes the movement as well as the row, exactly as `installment.pay` would.
       */
      paidFrom: NodeId.optional(),
      /** the day it was paid; today unless said otherwise */
      paidOn: DateOnly.optional(),
    }),
    output: Outcome,
    handler: async (input) => {
      const ctx = ctxOf();
      if (input.installmentId) {
        const row = ctx.db.select().from(t.installments).where(eq(t.installments.id, input.installmentId)).get();
        if (!row) return refusal('not_found', 'There is no such payment on that plan.');
        if (row.paidAt) {
          return refusal('immutable', 'That payment has already been made.',
                         'Undo the movement that paid it, then change the plan.');
        }
        const patch = Object.fromEntries(Object.entries({
          monthLabel: input.monthLabel, dueDate: input.dueDate,
          amountEgp: input.amountEgp, note: input.note, kind: input.kind,
          payFrom: input.payFrom,
        }).filter(([, v]) => v !== undefined));
        if (Object.keys(patch).length) {
          ctx.db.update(t.installments).set(patch).where(eq(t.installments.id, input.installmentId)).run();
        }
        return noted('Plan updated');
      }

      if (!input.amountEgp || !input.dueDate) {
        return refusal('invalid_period', 'A new payment needs an amount and a date.');
      }
      const id = newId('inst');
      const { amountEgp, dueDate } = input;
      const write = () => {
        ctx.db.insert(t.installments).values({
          id, propertyId: input.propertyId, ruleId: null,
          /*
           * The label is the month as the engine reads one — "Oct 2026", not "2026-10".
           * Everything forward-looking works the due date out from this label rather than
           * from `dueDate`, so a payment labelled the other way parses to no date at all and
           * is invisible to the reminders, to what is coming, and to the calendar's forward
           * half.
           */
          monthLabel: input.monthLabel ?? monthLabelOf(new Date(`${dueDate}T12:00:00`)),
          dueDate, dueDayKind: 'day',
          dueDayNum: Number(dueDate.slice(8, 10)),
          amountEgp, note: input.note ?? '',
          kind: input.kind ?? 'installment',
          payFrom: input.payFrom ?? null,
        } as any).run();

        /**
         * A row that is already paid.
         *
         * The movement is written here rather than left for a second call, because a plan
         * typed in on Tuesday usually has rows behind it that were paid in March — and
         * adding one as unpaid, then editing it to say otherwise, is two acts for one fact.
         * Paying settles ownership itself, so that is not done twice.
         */
        if (input.paidFrom) {
          return payInstallment(ctx, {
            installmentId: id, accountId: input.paidFrom,
            date: input.paidOn ?? dueDate,
          });
        }

        const back = settleOwnership(ctx.db, input.propertyId);
        return noted(`${amountEgp} due ${dueDate} added to the plan`,
                     back === 'installments' ? ['It is being paid for again, so it is back on a plan.'] : []);
      };

      /**
       * The row and the payment stand or fall together.
       *
       * A payment refused — an account that is not there, one with nothing in it — used to
       * leave the row behind as an unpaid one, so a refusal still changed the plan and the
       * person who read the message had a payment they never asked for.
       */
      return input.paidFrom ? atomically(ctx, write) : write();
    },
  }),

  command({
    name: 'plan.remove',
    context: 'holdings',
    summary: 'Take a payment off a plan.',
    detail: 'An unpaid payment was only an intention, so it simply goes. One that was already made is a movement as well as a row: the movement is reversed first — the money returns to the account it left — and then the row goes with it, so the plan and the accounts never disagree.',
    effect: 'irreversible',
    input: z.object({ installmentId: z.string() }),
    output: Outcome,
    handler: async ({ installmentId }) => {
      const ctx = ctxOf();
      const row = ctx.db.select().from(t.installments).where(eq(t.installments.id, installmentId)).get();
      if (!row) return refusal('not_found', 'There is no such payment on that plan.');

      return atomically(ctx, () => {
        const paid = !!row.paidAt;
        if (paid) undoMovement(ctx, row.movementId);
        ctx.db.delete(t.installments).where(eq(t.installments.id, installmentId)).run();
        const done = settleOwnership(ctx.db, row.propertyId);
        const warnings = done === 'owned'
          ? ['Nothing is left to pay, so it is now owned outright.'] : [];
        return noted(paid ? 'Taken off the plan, and the payment reversed' : 'Taken off the plan',
                     warnings);
      });
    },
  }),

  command({
    name: 'property.expense',
    context: 'holdings',
    summary: 'Record something spent on a property that buys no equity — maintenance, a fee, a service charge.',
    detail: 'It leaves a named account and does not increase what the property is worth to you, which is exactly the distinction the plan already draws between a payment and a charge.',
    input: z.object({
      propertyId: z.string(),
      accountId: NodeId,
      amount: z.number().positive(),
      date: DateOnly.optional(),
      note: z.string().max(300).optional(),
    }).merge(DryRun),
    output: Outcome,
    handler: async (input) => {
      const ctx = ctxOf();
      const property = ctx.db.select().from(t.nodes).where(eq(t.nodes.id, input.propertyId)).get();
      if (!property) return refusal('not_found', `${input.propertyId} is not a property in this ledger.`);
      const acct = ctx.ledger().node(input.accountId);
      if (!acct) return refusal('unknown_node', `${input.accountId} is not an account in this ledger.`);

      return post(ctx, {
        date: input.date ?? today(ctx), kind: 'expense',
        note: input.note ?? `${property.name} — upkeep`,
        legs: [{ fromNodeId: input.accountId, qtyFrom: input.amount }],
      }, `${input.amount} on ${property.name}, buying no equity`,
      { dryRun: input.dryRun,
        index: [{ kind: 'expense', recordId: newId('pex'), title: property.name, body: input.note ?? '' }] });
    },
  }),

  command({
    name: 'autopay.configure',
    context: 'holdings',
    summary: 'Have a property\'s installments post themselves on their due date, out of a chosen account.',
    detail: 'It covers the payments still to come. Anything that fell due before it was switched on stays owed and is still paid by hand — switching this on is a promise about what happens next, not a claim that the backlog was paid. The scheduler flags a payment whose account is short, and turning it off leaves every installment already recorded exactly as it is.',
    input: z.object({
      propertyId: z.string(), enabled: z.boolean(), fromAccountId: NodeId.optional(),
    }),
    output: Outcome,
    handler: async (input) => {
      const ctx = ctxOf();
      const held = ctx.db.select().from(t.autopay).where(eq(t.autopay.propertyId, input.propertyId)).get();
      const from = input.fromAccountId ?? held?.fromNodeId;
      if (input.enabled && !from) {
        return refusal('not_found', 'Autopay needs an account to draw from.', 'Pass fromAccountId.');
      }
      /*
       * Switching it on starts the clock today, and switching it on again after it was off
       * starts it again: the gap in between is time the owner was paying by hand, and posting
       * that stretch on the morning it is turned back on is the backlog problem in another
       * shape. An arrangement that is merely being pointed at a different account keeps the
       * date it already had.
       */
      const since = input.enabled && held?.enabled ? held.since ?? today(ctx)
        : input.enabled ? today(ctx)
        : held?.since ?? null;
      ctx.db.insert(t.autopay)
        .values({ propertyId: input.propertyId, enabled: input.enabled, fromNodeId: from!, since })
        .onConflictDoUpdate({ target: t.autopay.propertyId,
                              set: { enabled: input.enabled, fromNodeId: from!, since } }).run();
      const name = ctx.db.select().from(t.nodes).where(eq(t.nodes.id, input.propertyId)).get()?.name;
      return noted(input.enabled
        ? `${name ?? input.propertyId} will post its installments out of ${nameOf(ctx.db, from)}`
        : `${name ?? input.propertyId} is back to being recorded by hand`,
        input.enabled
          ? ['Payments that fell due before today stay owed — pay those on the plan yourself.']
          : []);
    },
  }),

  query({
    name: 'autopay.list',
    context: 'holdings',
    summary: 'Every property with autopay configured, on or off.',
    detail: 'The Assets screen and the notification settings both read this rather than each keeping its own memory of what was switched on, so a choice made on one is exactly the choice the other shows.',
    input: z.object({}),
    output: z.array(z.object({
      propertyId: z.string(), property: z.string(), enabled: z.boolean(),
      fromNodeId: z.string().nullable(), fromName: z.string().nullable(),
    })),
    handler: async () => {
      const { db } = ctxOf();
      return db.select().from(t.autopay).all().map((a) => ({
        propertyId: a.propertyId,
        property: db.select().from(t.nodes).where(eq(t.nodes.id, a.propertyId)).get()?.name ?? a.propertyId,
        enabled: a.enabled,
        fromNodeId: a.fromNodeId ?? null,
        fromName: a.fromNodeId ? nameOf(db, a.fromNodeId) : null,
      }));
    },
  }),
];
