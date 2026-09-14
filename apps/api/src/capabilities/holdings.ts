import { z } from 'zod';
import { command, query, DateOnly, NodeId, Ticker, Outcome } from '@ledger/contracts';
import { schema as t, type Db } from '@ledger/db';
import { desc, eq } from 'drizzle-orm';
import { computedPositions, installmentDueDate, monthLabelOf } from '@ledger/engine';
import type { AppCtx } from '../context.js';
import { post, noted, refusal, today, newId, undoMovement, atomically, DryRun } from './shared.js';
import { nextSeq } from './spending.js';
import { readMarket, buildDataset } from '../read.js';

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

export const holdingCaps = (ctxOf: () => AppCtx) => [
  command({
    name: 'metal.buy',
    context: 'holdings',
    summary: 'Buy gold or silver, paid for out of a named account. Grams in, money out.',
    detail: 'Give the price per gram you actually paid. Net worth does not change — value moves between two things you own — but the split does.',
    input: z.object({
      accountId: NodeId,
      metal: z.enum(['gold', 'silver']).default('gold'),
      grams: z.number().positive(),
      pricePerGram: z.number().positive().optional(),
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
      const perGram = input.pricePerGram
        ?? (input.metal === 'silver' ? (market.prices.silver_g ?? 0) : market.goldPerG);
      if (!(perGram > 0)) {
        return refusal('missing_rate', `No price is recorded for ${input.metal}.`,
                       'Set one in the Gold and silver screen, or give a price per gram here.');
      }
      const costEgp = input.grams * perGram;
      const rate = acct.currency === 'EGP' ? 1 : market.fxRates[acct.currency ?? 'EGP'] ?? 1;
      const costNative = costEgp / rate;
      const date = input.date ?? today(ctx);
      const id = newId('lot');

      return post(ctx, {
        date, kind: 'purchase', note: input.note,
        legs: [{ fromNodeId: input.accountId, qtyFrom: costNative, toNodeId: holding.id, qtyTo: input.grams }],
      }, `${input.grams} g of ${input.metal} at ${perGram} a gram, ${Math.round(costNative)} ${acct.currency ?? ''} out of ${acct.name}`,
      {
        dryRun: input.dryRun,
        index: [{ kind: 'lot', recordId: id, title: `${input.metal} buy ${input.grams} g`, body: input.note ?? '' }],
        after: (db, movementId) => {
          db.insert(t.goldLots).values({
            id, seq: nextSeq(db, 'gold_lots'), dateText: date, date, metal: input.metal,
            direction: 'buy', grams: input.grams, pricePerGram: perGram, totalEgp: costEgp,
            usdPaid: acct.currency === 'USD' ? costNative : costEgp / (market.usdEgp || 1),
            accountId: input.accountId, movementId, note: input.note ?? null,
            intention: input.intention,
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
      const perGram = input.pricePerGram
        ?? (input.metal === 'silver' ? (market.prices.silver_g ?? 0) : market.goldPerG);
      if (!(perGram > 0)) {
        return refusal('missing_rate', `No price is recorded for ${input.metal}.`,
                       'Set one in the Gold and silver screen, or give a price per gram here.');
      }
      const rate = acct.currency === 'EGP' ? 1 : market.fxRates[acct.currency ?? 'EGP'] ?? 1;
      const proceeds = (input.grams * perGram) / rate;
      const date = input.date ?? today(ctx);

      return post(ctx, {
        date, kind: 'sale', note: input.note,
        legs: [{ fromNodeId: holding.id, qtyFrom: input.grams, toNodeId: input.accountId, qtyTo: proceeds }],
      }, `${input.grams} g of ${input.metal} at ${perGram} a gram, ${Math.round(proceeds)} ${acct.currency ?? ''} into ${acct.name}`,
      {
        dryRun: input.dryRun,
        index: [{ kind: 'lot', recordId: newId('lot'), title: `${input.metal} sell ${input.grams} g`, body: input.note ?? '' }],
        after: (db, movementId) => {
          db.insert(t.goldLots).values({
            id: newId('lot'), seq: nextSeq(db, 'gold_lots'), dateText: date, date, metal: input.metal,
            direction: 'sell', grams: input.grams, pricePerGram: perGram,
            totalEgp: input.grams * perGram, usdPaid: 0,
            accountId: input.accountId, movementId, note: input.note ?? null,
            intention: input.intention,
          }).run();
        },
      });
    },
  }),

  command({
    name: 'book.transfer',
    context: 'holdings',
    summary: 'Move cash into the brokerage wallet, or take it back out.',
    detail: 'Money in sits uninvested until an order uses it. Money out returns to a named account — a broker is somewhere you keep money, not somewhere it disappears into.',
    input: z.object({
      accountId: NodeId,
      direction: z.enum(['in', 'out']).default('in'),
      amount: z.number().positive(),
      date: DateOnly.optional(), note: z.string().max(300).optional(),
    }).merge(DryRun),
    output: Outcome,
    handler: async (input) => {
      const ctx = ctxOf();
      const book = ctx.db.select().from(t.nodes).where(eq(t.nodes.priceKey, 'brokerage_cash')).get()
                ?? ctx.db.select().from(t.nodes).where(eq(t.nodes.id, 'brokerage-cash')).get();
      if (!book) return refusal('not_found', 'This ledger has no brokerage account.', 'Add one with account.add first.');
      const acct = ctx.ledger().node(input.accountId);
      const out = input.direction === 'out';

      return post(ctx, {
        date: input.date ?? today(ctx), kind: 'transfer', note: input.note,
        legs: [out
          ? { fromNodeId: book.id, toNodeId: input.accountId, qtyFrom: input.amount }
          : { fromNodeId: input.accountId, toNodeId: book.id, qtyFrom: input.amount }],
      }, out
        ? `${input.amount} out of the book into ${acct?.name ?? '?'}`
        : `${input.amount} into the book out of ${acct?.name ?? '?'}`,
      { dryRun: input.dryRun });
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
      date: DateOnly.optional(), time: z.string().max(8).optional(),
      /** why you did it — the part worth reading back a year later */
      note: z.string().max(500).optional(),
    }).merge(DryRun),
    output: Outcome,
    handler: async (input) => {
      const ctx = ctxOf();
      const date = input.date ?? today(ctx);
      const total = input.shares * input.price;
      const id = newId('ord');

      if (input.status !== 'executed') {
        if (input.dryRun) return noted(`${input.side} ${input.shares} ${input.ticker} would be logged as ${input.status}`);
        ctx.db.insert(t.orders).values({
          id, seq: nextSeq(ctx.db, 'orders'), date, time: input.time ?? null,
          ticker: input.ticker, side: input.side, shares: input.shares,
          price: input.price, total, status: input.status, note: input.note ?? null,
        }).run();
        return noted(`${input.side} ${input.shares} ${input.ticker} logged as ${input.status} — nothing moved`);
      }

      const book = ctx.db.select().from(t.nodes).where(eq(t.nodes.id, 'brokerage-cash')).get();
      const position = ctx.db.select().from(t.nodes).where(eq(t.nodes.priceKey, input.ticker)).get();
      if (!book) return refusal('not_found', 'This ledger has no brokerage cash account.');

      const legs = position
        ? [input.side === 'BUY'
            ? { fromNodeId: book.id, qtyFrom: total, toNodeId: position.id, qtyTo: input.shares }
            : { fromNodeId: position.id, qtyFrom: input.shares, toNodeId: book.id, qtyTo: total }]
        : [input.side === 'BUY'
            ? { fromNodeId: book.id, qtyFrom: total }
            : { toNodeId: book.id, qtyFrom: total }];

      return post(ctx, { date, kind: input.side === 'BUY' ? 'purchase' : 'sale', note: input.note, legs },
        `${input.side} ${input.shares} ${input.ticker} at ${input.price}`,
        {
          dryRun: input.dryRun,
          index: [{ kind: 'order', recordId: id, title: `${input.ticker} ${input.side}`, body: `${input.shares} at ${input.price}` }],
          warnings: position ? [] : [`No position node exists for ${input.ticker}, so only the cash side was recorded.`],
          after: (db, movementId) => {
            db.insert(t.orders).values({
              id, seq: nextSeq(db, 'orders'), date, time: input.time ?? null,
              ticker: input.ticker, side: input.side, shares: input.shares,
              price: input.price, total, status: 'executed', movementId,
              note: input.note ?? null,
            }).run();
          },
        });
    },
  }),

  command({
    name: 'order.correct',
    context: 'holdings',
    summary: 'Correct an order already logged — the ticker, the side, the shares, the price, the status, the date, the note.',
    detail: 'An executed order moved cash and the position, so correcting one reverses that movement and writes it again. An order that never executed moved nothing, and only its record changes.',
    input: z.object({
      orderId: z.string(),
      ticker: Ticker.optional(), side: z.enum(['BUY', 'SELL']).optional(),
      shares: z.number().positive().optional(), price: z.number().positive().optional(),
      status: z.enum(['executed', 'pending', 'cancelled']).optional(),
      date: DateOnly.optional(), time: z.string().max(8).optional(),
      note: z.string().max(500).optional(),
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
        date: input.date ?? row.date,
        time: input.time ?? row.time ?? null,
        note: input.note ?? row.note ?? null,
      };
      const total = next.shares * next.price;

      return atomically(ctx, () => {
        undoMovement(ctx, row.movementId);
        ctx.db.delete(t.orders).where(eq(t.orders.id, input.orderId)).run();

        // Nothing moved and nothing moves: the record is the whole of it.
        if (next.status !== 'executed') {
          ctx.db.insert(t.orders).values({
            id: input.orderId, seq: row.seq, date: next.date, time: next.time,
            ticker: next.ticker, side: next.side, shares: next.shares,
            price: next.price, total, status: next.status, note: next.note,
          }).run();
          return noted(`${next.side} ${next.shares} ${next.ticker} corrected — logged as ${next.status}, nothing moved`);
        }

        const book = ctx.db.select().from(t.nodes).where(eq(t.nodes.id, 'brokerage-cash')).get();
        if (!book) return refusal('not_found', 'This ledger has no brokerage cash account.');
        const position = ctx.db.select().from(t.nodes).where(eq(t.nodes.priceKey, next.ticker)).get();

        const legs = position
          ? [next.side === 'BUY'
              ? { fromNodeId: book.id, qtyFrom: total, toNodeId: position.id, qtyTo: next.shares }
              : { fromNodeId: position.id, qtyFrom: next.shares, toNodeId: book.id, qtyTo: total }]
          : [next.side === 'BUY'
              ? { fromNodeId: book.id, qtyFrom: total }
              : { toNodeId: book.id, qtyFrom: total }];

        return post(ctx, {
          date: next.date, kind: next.side === 'BUY' ? 'purchase' : 'sale',
          note: next.note ?? undefined, legs,
        }, `corrected: ${next.side} ${next.shares} ${next.ticker} at ${next.price}`,
        {
          index: [{ kind: 'order', recordId: input.orderId,
                    title: `${next.ticker} ${next.side}`, body: `${next.shares} at ${next.price}` }],
          warnings: position ? [] : [`No position node exists for ${next.ticker}, so only the cash side was recorded.`],
          after: (db, movementId) => {
            db.insert(t.orders).values({
              id: input.orderId, seq: row.seq, date: next.date, time: next.time,
              ticker: next.ticker, side: next.side, shares: next.shares,
              price: next.price, total, status: 'executed', movementId, note: next.note,
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
      date: DateOnly.optional(),
      note: z.string().max(300).optional(),
      /** worn or held — the answer that decides whether zakat reaches this weight */
      intention: z.enum(['personal', 'investment']).optional(),
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
      const perGram = input.pricePerGram ?? lot.pricePerGram;
      const date = input.date ?? lot.date ?? lot.dateText;
      const note = input.note ?? lot.note ?? undefined;
      const market = readMarket(ctx.db);
      const totalEgp = grams * perGram;
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
          }).where(eq(t.goldLots.id, input.lotId)).run();
          return noted(`corrected: ${grams} g of ${metal} at ${perGram} a gram, held from before the ledger`);
        });
      }

      const accountId = input.accountId ?? lot.accountId;
      if (!accountId) return refusal('unknown_node', 'That lot names no account.');
      const acct = ctx.ledger().node(accountId);
      if (!acct) return refusal('unknown_node', `${accountId} is not an account in this ledger.`);
      const rate = acct.currency === 'EGP' ? 1 : market.fxRates[acct.currency ?? 'EGP'] ?? 1;
      const native = totalEgp / rate;
      const buying = lot.direction === 'buy';

      return atomically(ctx, () => {
        undoMovement(ctx, lot.movementId);
        ctx.db.delete(t.goldLots).where(eq(t.goldLots.id, input.lotId)).run();

        return post(ctx, {
          date, kind: buying ? 'purchase' : 'sale', note,
          legs: [buying
            ? { fromNodeId: accountId, qtyFrom: native, toNodeId: holding.id, qtyTo: grams }
            : { fromNodeId: holding.id, qtyFrom: grams, toNodeId: accountId, qtyTo: native }],
        }, `corrected: ${grams} g of ${metal} at ${perGram} a gram`,
        {
          index: [{ kind: 'lot', recordId: input.lotId,
                    title: `${metal} ${lot.direction} ${grams} g`, body: note ?? '' }],
          after: (db, movementId) => {
            db.insert(t.goldLots).values({
              id: input.lotId, seq: lot.seq, dateText: date, date, metal,
              direction: lot.direction, grams, pricePerGram: perGram, totalEgp,
              usdPaid: acct.currency === 'USD' ? native : totalEgp / (market.usdEgp || 1),
              accountId, movementId, note: note ?? null, intention,
            }).run();
          },
        });
      });
    },
  }),

  command({
    name: 'metal.removeLot',
    context: 'holdings',
    summary: 'Remove a purchase or sale of metal from the ledger.',
    detail: 'A lot bought through this ledger is reversed: the movement that paid for it gets its opposite, so the account and the weight both come back, and the log keeps both entries. A lot that was already held when the books were opened has no movement to reverse, so the row goes and the holding\'s opening weight comes down with it.',
    input: z.object({ lotId: z.string() }),
    output: Outcome,
    handler: async (input) => {
      const ctx = ctxOf();
      const lot = ctx.db.select().from(t.goldLots).where(eq(t.goldLots.id, input.lotId)).get();
      if (!lot) return refusal('not_found', 'There is no such lot.');
      const metal = lot.metal ?? 'gold';
      const holding = ctx.db.select().from(t.nodes).where(eq(t.nodes.id, metal)).get();
      if (!holding) return refusal('not_found', `This ledger has no ${metal} holding.`);

      return atomically(ctx, () => {
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
    detail: 'Shares are held from the orders you logged, and valued at whatever price was last recorded for each ticker — fetched from the source chosen under Prices, or set by hand — so a position with no price is shown at cost and says so, rather than quietly counting as zero.',
    input: z.object({}),
    output: z.array(z.object({
      ticker: z.string(), shares: z.number(), avgBuy: z.number(),
      cost: z.number(), price: z.number(), value: z.number(), gain: z.number(),
      priced: z.boolean(), pricedAt: z.string().nullable(),
    })),
    handler: async () => {
      const ctx = ctxOf();
      const { data } = buildDataset(ctx.db, ctx.now);
      const market = readMarket(ctx.db);
      const at = new Map(ctx.db.$raw.prepare(`
        SELECT key, at FROM market_ticks WHERE id IN (SELECT MAX(id) FROM market_ticks GROUP BY key)
      `).all().map((r: any) => [r.key, r.at]));

      return computedPositions(data.orders, market.prices).map((p) => {
        const priced = market.prices[p.ticker] != null;
        // an unpriced holding is worth what it cost until told otherwise, which is honest
        // rather than optimistic
        const value = priced ? p.value : p.cost;
        return {
          ...p, value, priced,
          pricedAt: (at.get(`price_${p.ticker}`) as string) ?? null,
          gain: value - p.cost,
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
    handler: async (input) => {
      const ctx = ctxOf();
      const inst = ctx.db.select().from(t.installments).where(eq(t.installments.id, input.installmentId)).get();
      if (!inst) return refusal('not_found', `${input.installmentId} is not an installment.`);
      if (inst.paidAt) return refusal('duplicate', 'That installment is already marked paid.', 'Correct it instead, if the payment was wrong.');

      const property = ctx.db.select().from(t.nodes).where(eq(t.nodes.id, inst.propertyId)).get();
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
        legs: [equity && property
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
    },
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
      const amount = input.amountEgp ?? inst.amountEgp;
      const note = input.note ?? inst.note;
      const property = ctx.db.select().from(t.nodes).where(eq(t.nodes.id, inst.propertyId)).get();
      // what a payment buys is read from what it is called, so a renamed one is re-read
      const equity = !/maintenance|service|fee/i.test(note);

      // The reversal has to happen before the new payment is written — the money has to be
      // back in the old account before it can leave the new one.
      return atomically(ctx, () => {
        undoMovement(ctx, inst.movementId);
        ctx.db.update(t.installments).set({ paidAt: null, movementId: null })
          .where(eq(t.installments.id, input.installmentId)).run();

        return post(ctx, {
          date, kind: 'installment', note: note || undefined,
          legs: [equity && property
            ? { fromNodeId: from, qtyFrom: amount, toNodeId: property.id, qtyTo: amount }
            : { fromNodeId: from, qtyFrom: amount }],
        }, `corrected: ${amount} out of ${ctx.db.select().from(t.nodes).where(eq(t.nodes.id, from)).get()?.name ?? from}`,
        {
          after: (db, movementId) => {
            db.update(t.installments).set({ paidAt: date, movementId, payFrom: from,
                                            amountEgp: amount, note })
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
      ticker: z.string().optional(),
      side: z.enum(['BUY', 'SELL']).optional(),
      status: z.enum(['executed', 'pending', 'cancelled']).optional(),
      from: DateOnly.optional(),
      to: DateOnly.optional(),
      limit: z.number().int().positive().max(500).default(200),
    }),
    output: z.array(z.object({
      id: z.string(), date: z.string(), time: z.string().nullable(),
      ticker: z.string(), side: z.string(), shares: z.number(), price: z.number(),
      total: z.number(), status: z.string(),
      note: z.string().nullable(), movementId: z.string().nullable(),
    })),
    handler: async (input) => {
      const { db } = ctxOf();
      return db.select().from(t.orders).all()
        .filter((o) => (!input.ticker || o.ticker === input.ticker.toUpperCase())
                    && (!input.side || o.side === input.side)
                    && (!input.status || o.status === input.status)
                    && (!input.from || o.date >= input.from)
                    && (!input.to || o.date <= input.to))
        .sort((a, b) => b.date.localeCompare(a.date) || b.seq - a.seq)
        .slice(0, input.limit)
        .map(({ seq: _seq, ...o }) => o);
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
      note: z.string().nullable(), movementId: z.string().nullable(),
      accountId: z.string().nullable(),
      intention: z.string(),
    })),
    handler: async ({ metal }) => {
      const { db } = ctxOf();
      return db.select().from(t.goldLots).all()
        .filter((l) => !metal || (l.metal ?? 'gold') === metal)
        .map((l) => ({ ...l, metal: l.metal ?? 'gold',
                       intention: (l as { intention?: string | null }).intention ?? 'investment' }))
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
      const paid = rows.filter((r) => r.paidAt).reduce((s2, r) => s2 + r.amountEgp, 0);
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
    detail: 'A payment already made cannot be edited — it is a movement, and undoing that movement is what changes it. Everything still ahead is yours to reshape.',
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
      ctx.db.insert(t.installments).values({
        id, propertyId: input.propertyId, ruleId: null,
        /*
         * The label is the month as the engine reads one — "Oct 2026", not "2026-10".
         * Everything forward-looking works the due date out from this label rather than from
         * `dueDate`, so a payment labelled the other way parses to no date at all and is
         * invisible to the reminders, to what is coming, and to the calendar's forward half.
         */
        monthLabel: input.monthLabel ?? monthLabelOf(new Date(`${input.dueDate}T12:00:00`)),
        dueDate: input.dueDate, dueDayKind: 'day',
        dueDayNum: Number(input.dueDate.slice(8, 10)),
        amountEgp: input.amountEgp, note: input.note ?? '',
        kind: input.kind ?? 'installment',
        payFrom: input.payFrom ?? null,
      } as any).run();
      const back = settleOwnership(ctx.db, input.propertyId);
      return noted(`${input.amountEgp} due ${input.dueDate} added to the plan`,
                   back === 'installments' ? ['It is being paid for again, so it is back on a plan.'] : []);
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
    detail: 'The scheduler posts them and flags the payment if the account is short. Turning this off leaves every installment already recorded exactly as it is.',
    input: z.object({
      propertyId: z.string(), enabled: z.boolean(), fromAccountId: NodeId.optional(),
    }),
    output: Outcome,
    handler: async (input) => {
      const ctx = ctxOf();
      const from = input.fromAccountId
        ?? ctx.db.select().from(t.autopay).where(eq(t.autopay.propertyId, input.propertyId)).get()?.fromNodeId;
      if (input.enabled && !from) {
        return refusal('not_found', 'Autopay needs an account to draw from.', 'Pass fromAccountId.');
      }
      ctx.db.insert(t.autopay)
        .values({ propertyId: input.propertyId, enabled: input.enabled, fromNodeId: from! })
        .onConflictDoUpdate({ target: t.autopay.propertyId,
                              set: { enabled: input.enabled, fromNodeId: from! } }).run();
      const name = ctx.db.select().from(t.nodes).where(eq(t.nodes.id, input.propertyId)).get()?.name;
      return noted(input.enabled
        ? `${name ?? input.propertyId} will post its installments out of ${from}`
        : `${name ?? input.propertyId} is back to being recorded by hand`);
    },
  }),
];
