import { z } from 'zod';
import { command, query, NodeId, Outcome, Refusal } from '@ledger/contracts';
import { schema as t, allBalances } from '@ledger/db';
import { eq } from 'drizzle-orm';
import { installmentDueDate, defaultIntention, intentionsFor, intentionLabel,
         unitValue, type Valuation } from '@ledger/engine';
import { assetKindOf, isDebtNode } from '../zakat-assets.js';
import { readMarket } from '../read.js';
import type { AppCtx } from '../context.js';
import { noted, refusal, newId, post, today, DryRun, sourceReading, SOURCE_FIELDS } from './shared.js';

/**
 * What a sale would be measured against, in the ledger's own currency.
 *
 * Two questions wearing one name. Something on a plan has cost whatever has actually been
 * handed over — the down payment plus every installment marked paid, which is the figure the
 * portfolio shows and zakat counts. Something bought outright has cost the price it was
 * bought at, converted the way the asset itself is converted: a car held in dollars costs
 * what those dollars are worth, not the bare number. An asset older than that column has no
 * recorded price, and what it stands at now is the only answer the ledger still has.
 *
 * Written once and read by both the list and the sale, so a card cannot promise one figure
 * and the receipt report another.
 */
export function purchaseBasisEgp(
  node: { id: string; currency: string | null; valuation: string; priceKey: string | null;
          openingQty: number; boughtFor?: number | null },
  plan: Array<{ paidAt: string | null; amountEgp: number }>,
  balance: number,
  market: Parameters<typeof unitValue>[1],
): number {
  if (plan.length > 0) {
    return (node.openingQty ?? 0) + plan.filter((i) => i.paidAt).reduce((sum, i) => sum + i.amountEgp, 0);
  }
  const per = unitValue({
    id: node.id, kind: 'asset', name: '', openingQty: 0,
    valuation: node.valuation as Valuation,
    priceKey: node.priceKey ?? undefined,
    currency: node.currency ?? undefined,
  }, market);
  return (node.boughtFor ?? balance) * per;
}

/**
 * Things you own that are not money.
 *
 * A flat and a car are the same kind of record: something bought, worth something, and either
 * paid for outright or still on a plan. Keeping them apart made the plan machinery belong to
 * property alone, which is why a car on installments had nowhere to live.
 *
 * What differs is only the kind, which decides the mark and the words — not the behaviour.
 */
export const assetCaps = (ctxOf: () => AppCtx) => [
  query({
    name: 'assets.list',
    context: 'holdings',
    summary: 'Everything owned that is not money: what it is worth, what is paid, what is owed.',
    input: z.object({
      includeArchived: z.boolean().default(false),
      /**
       * Whether the things already sold belong in the answer.
       *
       * A sale archives what was sold — it is not owned any more, and a list of what you own
       * should not go on naming it. What it made or lost is still worth reading, though, and
       * a screen that wants to show that asks for it outright rather than by asking for every
       * archived asset, most of which were archived for other reasons entirely.
       */
      includeSold: z.boolean().default(false),
    }),
    output: z.array(z.object({
      id: z.string(), name: z.string(), kind: z.string(),
      ownership: z.string(), icon: z.string().nullable(), color: z.string().nullable(),
      /** what it is worth in the ledger's own currency, converted at today's rate */
      value: z.number(),
      /** the same worth as it was actually entered: the number, in the currency beside it */
      amount: z.number(),
      currency: z.string().nullable(), unit: z.string().nullable(),
      planTotal: z.number(), paid: z.number(), remaining: z.number(),
      payments: z.number(), nextDue: z.string().nullable(),
      /** why it is held — the answer zakat reads before it reads the value */
      intention: z.string().nullable(),
      /** the dates the lunar year is measured from */
      intentionSince: z.string().nullable(),
      acquiredOn: z.string().nullable(),
      nisabMetOn: z.string().nullable(),
      archived: z.boolean(),
      /** what it cost when it was bought, in its own currency; nothing for a plan */
      boughtFor: z.number().nullable(),
      /**
       * What a sale today would be measured against, in the ledger's own currency: the
       * payments made on a plan, or the price paid for something bought outright.
       */
      basis: z.number(),
      /** the sale, once there is one: the day, what it fetched, and what that was measured against */
      soldOn: z.string().nullable(),
      soldPrice: z.number().nullable(),
      soldCurrency: z.string().nullable(),
      soldAccountId: z.string().nullable(),
      /** what had gone into it — paid on a plan, or what it cost outright — in the ledger's currency */
      soldBasis: z.number().nullable(),
      /** what the sale made or lost against that basis, in the ledger's currency */
      soldProfit: z.number().nullable(),
      ...SOURCE_FIELDS,
    })),
    handler: async ({ includeArchived, includeSold }) => {
      const ctx = ctxOf();
      const balances = allBalances(ctx.db);
      const installments = ctx.db.select().from(t.installments).all();
      const market = readMarket(ctx.db);

      /**
       * A balance is a quantity, and a quantity is not a value.
       *
       * A car bought for twenty thousand dollars holds twenty thousand of something, and
       * which something is decided by how the node is valued. Reporting the bare number as
       * though it were the ledger's own currency understates it by the whole exchange rate,
       * so the node's valuation is applied here — literally the engine's own rule, called
       * rather than restated, so this list and the front page cannot disagree. Restating it
       * is what dropped the currency on a fixed value: a dollar car read as pounds.
       */
      const valueOf = (n: { valuation: string; priceKey: string | null; currency: string | null },
                       qty: number): number =>
        qty * unitValue({
          id: '', kind: 'asset', name: '', openingQty: 0,
          valuation: n.valuation as Valuation,
          priceKey: n.priceKey ?? undefined,
          currency: n.currency ?? undefined,
        }, market);

      return ctx.db.select().from(t.nodes).all()
        // Metal is a weight with its own screen and its own arithmetic, the brokerage book is
        // the share book's own holding, and money lent out is a debt kept on the debts screen
        // — none of the three is a thing owned, and a loan listed here was offered a payment
        // plan, a mark and an intention, none of which a loan has.
        .filter((n) => n.kind === 'asset'
          && !n.unit
          && n.priceKey !== 'brokerage_cash'
          && !/^brokerage/.test(n.id)
          && !isDebtNode(n)
          && (includeArchived || !n.archived || (includeSold && !!(n as { soldOn?: string | null }).soldOn)))
        .map((n) => {
          const mine = installments.filter((i) => i.propertyId === n.id);
          const planTotal = mine.reduce((s, i) => s + i.amountEgp, 0);
          /**
           * What has actually gone into it.
           *
           * The opening/down payment is money paid before the plan's own rows existed, and it
           * is already sitting in the property's value — reading `paid` as only the rows on
           * the plan is what let this screen say PAID 0 on a property that opened at three
           * quarters of a million. Every paid installment counts too, whether or not it
           * bought a share of the thing: the plan tracks what was actually handed over, not
           * only the part that bought equity.
           */
          const paid = mine.length === 0 ? 0 : (n.openingQty ?? 0)
            + mine.filter((i) => i.paidAt).reduce((s, i) => s + i.amountEgp, 0);
          const next = mine
            .filter((i) => !i.paidAt)
            .map((i) => i.dueDate
              ?? installmentDueDate(i.monthLabel, i.dueDayKind, i.dueDayNum ?? undefined)?.toISOString().slice(0, 10)
              ?? null)
            .filter(Boolean)
            .sort()[0] ?? null;

          // What kind of thing this is: stated once it has been set, and otherwise worked
          // out — the same reading the zakat assessment uses, so the two cannot disagree
          // about whether a flat is a property.
          const kind = assetKindOf(n, mine.length > 0);

          const held = n as typeof n & {
            intention?: string | null; intentionSince?: string | null;
            acquiredOn?: string | null; nisabMetOn?: string | null;
            sourceCurrency?: string | null; sourceAmount?: number | null; sourceRate?: number | null;
            boughtFor?: number | null;
            soldOn?: string | null; soldPrice?: number | null; soldCurrency?: string | null;
            soldAccountId?: string | null; soldBasis?: number | null;
          };
          const value = valueOf(n, balances[n.id] ?? n.openingQty);
          /**
           * What the sale made, in the ledger's own currency.
           *
           * The price is converted at today's rate and the basis was written in pounds the
           * day it was sold, which is the one figure that cannot be worked out again later:
           * what had been paid towards the thing then is not what the plan says now.
           */
          const soldPriceEgp = held.soldPrice == null ? null
            : held.soldPrice * (!held.soldCurrency || held.soldCurrency === 'EGP'
              ? 1 : (market.fxRates[held.soldCurrency] ?? 1));

          return {
            id: n.id, name: n.name, kind,
            ownership: n.ownership ?? (mine.length ? 'installments' : 'owned'),
            icon: n.icon, color: n.color,
            intention: held.intention ?? defaultIntention(kind),
            intentionSince: held.intentionSince ?? null,
            acquiredOn: held.acquiredOn ?? null,
            nisabMetOn: held.nisabMetOn ?? null,
            /**
             * Two readings of the same holding, and both are needed.
             *
             * What is stored is a quantity in the asset's own currency — a car bought for
             * twenty thousand dollars holds twenty thousand dollars, today and next year,
             * whatever the rate does. `value` converts that for a total to be drawn from;
             * `amount` is the figure as it was entered, which is what a form correcting it
             * has to show. Handing back only the converted one made every editor open on a
             * pound figure beside a dollar picker, and so read as though choosing a currency
             * had rewritten the amount in pounds.
             */
            value, amount: balances[n.id] ?? n.openingQty,
            currency: n.currency, unit: n.unit,
            planTotal, paid, remaining: planTotal - paid,
            payments: mine.length, nextDue: next as string | null,
            archived: n.archived,
            boughtFor: held.boughtFor ?? null,
            basis: purchaseBasisEgp(n, mine, balances[n.id] ?? n.openingQty, market),
            soldOn: held.soldOn ?? null,
            soldPrice: held.soldPrice ?? null,
            soldCurrency: held.soldCurrency ?? null,
            soldAccountId: held.soldAccountId ?? null,
            soldBasis: held.soldBasis ?? null,
            soldProfit: soldPriceEgp == null || held.soldBasis == null
              ? null : soldPriceEgp - held.soldBasis,
            // The third reading: what the money that paid for this outright would be worth
            // now, had it never left its own currency. Nothing for a plan, and nothing for an
            // asset bought before this was tracked or with no account named at all.
            ...sourceReading(
              { currency: held.sourceCurrency ?? null, amount: held.sourceAmount ?? null, rate: held.sourceRate ?? null },
              value, market),
          };
        });
    },
  }),

  command({
    name: 'asset.add',
    context: 'holdings',
    summary: 'Add something you own — a property, a vehicle, anything else — with its mark and colour.',
    detail: 'An asset bought on a plan starts at nothing and grows as payments are made. One paid for outright starts at what it is worth — named an account and the money actually leaves it; left unnamed, the worth is simply stated, the way a fresh installation states what you already own.',
    input: z.object({
      name: z.string().min(1).max(80),
      kind: z.enum(['property', 'vehicle', 'equipment', 'other']).default('other'),
      ownership: z.enum(['owned', 'installments']).default('owned'),
      value: z.number().min(0).default(0),
      currency: z.string().regex(/^[A-Z]{3}$/).default('EGP'),
      /**
       * What paid for it, when bought outright. Left unnamed — "Initial payment" on the
       * screen — the worth is stated as given, the same as an opening balance: nothing is
       * deducted from anywhere, because nothing here can say where the money came from.
       */
      accountId: NodeId.optional(),
      icon: z.string().max(80).optional(),
      color: z.string().regex(/^#[0-9a-f]{6}$/i).optional(),
      /**
       * Why it is held. Left unsaid, the safest reading of the kind is taken — a property is
       * a home and a vehicle is driven — because that is the answer that owes nothing, and a
       * calculator should not invent an obligation nobody stated.
       */
      intention: z.enum(['live_in', 'rent', 'sale', 'personal', 'investment']).optional(),
      intentionSince: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      acquiredOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      nisabMetOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    }).merge(DryRun),
    // The id is part of the answer — whatever calls this next (a plan, an intention) needs it
    // to say which asset it means — so a refusal is offered beside it rather than folded into
    // the ordinary Outcome, which has nowhere to carry one.
    output: z.union([z.object({ id: z.string(), summary: z.string() }), Refusal]),
    handler: async (input) => {
      const ctx = ctxOf();
      const { db } = ctx;
      const id = newId(input.kind === 'property' ? 'prop' : input.kind === 'vehicle' ? 'veh' : 'asset');
      const intention = input.intention ?? defaultIntention(input.kind);
      const stated = intentionsFor(input.kind).some((o) => o.id === intention)
        ? intention : defaultIntention(input.kind);

      // Bought outright, out of a named account: the account is checked before anything is
      // written, so a bad id never leaves an asset sitting in the ledger with nothing paid
      // for it. A plan starts at nothing regardless of what is named here — the down payment
      // is one of its own installments, paid the way any of them are.
      const buying = !!input.accountId && input.ownership !== 'installments' && input.value > 0;
      const acct = buying ? ctx.ledger().node(input.accountId!) : undefined;
      if (buying && !acct) {
        return refusal('unknown_node', `${input.accountId} is not an account in this ledger.`);
      }

      const create = (source?: { sourceAccountId: string; sourceCurrency: string; sourceAmount: number; sourceRate: number }) => {
        db.insert(t.nodes).values({
          id, kind: 'asset', name: input.name, currency: input.currency,
          valuation: 'fixed',
          openingQty: input.ownership === 'installments' ? 0 : buying ? 0 : input.value,
          /**
           * What it cost, kept apart from what it is worth.
           *
           * The two are the same number today and will not be tomorrow: repricing a flat
           * rewrites the worth, and a profit measured against a rewritten purchase price is
           * not a profit. A plan has none — what it cost is what has been paid towards it.
           */
          boughtFor: input.ownership === 'installments' || input.value <= 0 ? null : input.value,
          boughtCurrency: input.ownership === 'installments' || input.value <= 0 ? null : input.currency,
          assetKind: input.kind, ownership: input.ownership,
          intention: stated,
          // a lunar year has to run from somewhere, and the day it was stated is that day
          intentionSince: input.intentionSince ?? input.acquiredOn ?? ctx.now.toISOString().slice(0, 10),
          acquiredOn: input.acquiredOn ?? null,
          nisabMetOn: input.nisabMetOn ?? null,
          icon: input.icon ?? null, color: input.color ?? null, archived: false,
          ...source,
        }).run();
      };

      if (!buying) {
        // Asking is not doing. A dry run answers with what would be written and writes
        // nothing, which is the whole of the promise `dryRun` makes.
        if (!input.dryRun) create();
        return {
          id,
          summary: input.ownership === 'installments'
            ? `${input.name} added, starting at nothing until payments are made`
            : `${input.name} added at ${input.value} ${input.currency}`,
        };
      }

      // Bought out of a named account: the node and the movement that pays for it either
      // both land or neither does — a refused purchase must not leave an asset behind it with
      // nothing paid for it, the same guarantee a correction gets.
      let failed: Refusal | undefined;
      let summary = '';
      const rollback = Symbol('rolled back');
      try {
        db.$raw.transaction(() => {
          const market = readMarket(db);
          const valueEgp = input.value * (input.currency === 'EGP' ? 1 : (market.fxRates[input.currency] ?? 1));
          const acctRate = acct!.currency === 'EGP' ? 1 : (market.fxRates[acct!.currency ?? 'EGP'] ?? 1);
          const costNative = valueEgp / acctRate;
          // The other side of the same purchase: what actually left the account, in its own
          // currency, at the rate that applied — kept so the asset can be asked what that
          // money would be worth now, apart from what the asset itself did.
          create({
            sourceAccountId: input.accountId!, sourceCurrency: acct!.currency ?? 'EGP',
            sourceAmount: costNative, sourceRate: acctRate,
          });
          const res = post(ctx, {
            date: today(ctx), kind: 'purchase', note: undefined,
            legs: [{ fromNodeId: input.accountId!, qtyFrom: costNative, toNodeId: id, qtyTo: input.value }],
          }, `${input.name} added, ${Math.round(costNative)} ${acct!.currency ?? ''} out of ${acct!.name}`,
          { dryRun: input.dryRun });
          if (!res.ok) { failed = res; throw rollback; }
          summary = res.summary;
          // Everything above ran — the account was found, the money was there, the movement
          // balanced — and on a dry run all of it is now undone. The answer stands; the
          // ledger is untouched.
          if (input.dryRun) throw rollback;
        })();
      } catch (e) {
        if (e !== rollback) throw e;
      }
      return failed ?? { id, summary };
    },
  }),

  command({
    name: 'asset.update',
    context: 'holdings',
    summary: 'Rename an asset, change what it is worth, its mark, its colour, its currency, or how it was paid for.',
    detail: 'The worth is stated in the asset\'s own currency and stored in it. Changing the currency says what the number was always in; it does not restate the number, and nothing is converted until a total has to be drawn.',
    input: z.object({
      assetId: NodeId,
      name: z.string().min(1).max(80).optional(),
      kind: z.enum(['property', 'vehicle', 'equipment', 'other']).optional(),
      ownership: z.enum(['owned', 'installments']).optional(),
      /** what it is worth, in its own currency — not in the ledger's */
      value: z.number().min(0).optional(),
      currency: z.string().regex(/^[A-Z]{3}$/).optional(),
      icon: z.string().max(80).optional(),
      color: z.string().regex(/^#[0-9a-f]{6}$/i).optional(),
      intention: z.enum(['live_in', 'rent', 'sale', 'personal', 'investment']).optional(),
      intentionSince: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
      acquiredOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
      nisabMetOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
      archived: z.boolean().optional(),
    }),
    output: Outcome,
    handler: async ({ assetId, kind, intention, value, ...patch }) => {
      const ctx = ctxOf();
      const db = ctx.db;
      const row = db.select().from(t.nodes).where(eq(t.nodes.id, assetId)).get();
      if (!row) return refusal('not_found', `${assetId} is not an asset in this ledger.`);
      const clean: Record<string, unknown> = Object.fromEntries(
        Object.entries(patch).filter(([, v]) => v !== undefined));
      if (kind) clean.assetKind = kind;

      /**
       * What it is worth is what it is held as, in its own currency.
       *
       * The number goes to the node's own quantity untouched — no rate is applied on the way
       * in, because none was applied on the way out. An asset on a plan is worth what has
       * been paid towards it and that is worked out from the payments, so a figure typed over
       * it would be overwritten by the next one and is refused instead of quietly ignored.
       */
      if (value !== undefined) {
        const ownership = patch.ownership ?? row.ownership;
        if (ownership === 'installments') {
          return refusal('immutable',
            `${row.name} is being paid for on a plan, so what it is worth is what has been paid towards it.`,
            'Change the payments, or mark it as owned outright to state a worth of its own.');
        }
        clean.openingQty = value;
      }

      /**
       * Changing your mind starts the year again.
       *
       * A flat you decide today to sell is trade stock from today, not from the day you
       * bought it to live in — so the date moves with the answer unless one is given. Saying
       * otherwise would date a lunar year from an intention that did not exist yet.
       */
      const previous = (row as { intention?: string | null }).intention ?? null;
      if (intention) {
        /**
         * What kind of thing this is, read the way the rest of the ledger reads it.
         *
         * An asset whose kind was never stated is worked out — a flat is a flat because it
         * has a plan against it, whatever the column says. This used to fall back to "other"
         * here while `assets.list` inferred it properly, so a property offered "to live in"
         * on screen and the answer was quietly rewritten to "personal use" on arrival: the
         * option looked broken because it was.
         */
        const plan = db.select().from(t.installments)
          .where(eq(t.installments.propertyId, assetId)).all();
        const asked = kind ?? assetKindOf(row, plan.length > 0);

        // and where an answer genuinely does not belong to this kind, it is refused rather
        // than substituted: a silent substitution is a lie told in a receipt
        if (!intentionsFor(asked).some((o) => o.id === intention)) {
          return refusal('invalid_period',
            `${row.name} is a ${asked === 'other' ? 'holding' : asked}, and "${intention}" is not one of the ways it can be held.`,
            `Its choices are: ${intentionsFor(asked).map((o) => o.label).join(', ')}.`);
        }
        clean.intention = intention;
        if (clean.intention !== previous && patch.intentionSince === undefined) {
          clean.intentionSince = ctx.now.toISOString().slice(0, 10);
          // the old threshold date belonged to the old intention
          clean.nisabMetOn = null;
        }
      }

      if (Object.keys(clean).length) db.update(t.nodes).set(clean).where(eq(t.nodes.id, assetId)).run();
      const held = clean.intention as typeof intention;
      return noted(held && held !== previous
        ? `${patch.name ?? row.name} is now held ${intentionLabel(kind ?? assetKindOf(row, true), held).toLowerCase()}, from ${clean.intentionSince ?? patch.intentionSince ?? row.intentionSince}`
        : `${patch.name ?? row.name} updated`);
    },
  }),

  command({
    name: 'asset.sell',
    context: 'holdings',
    summary: 'Sell something you own: the price it fetched, into the account the money reached.',
    detail: 'What the sale made or lost is measured against what had gone into the thing — what it cost, for something bought outright, and what has actually been paid so far for something on a plan. Both the price and that figure are written down, so the profit can be read back years later rather than reworked from prices that have since moved. The thing itself leaves the lists: it is not owned any more, and every movement against it stays in the log.',
    input: z.object({
      assetId: NodeId,
      /** what it fetched, in the currency it was sold in */
      price: z.number().positive(),
      currency: z.string().regex(/^[A-Z]{3}$/).optional(),
      /** the account the money reached */
      accountId: NodeId,
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      note: z.string().max(300).optional(),
    }).merge(DryRun),
    output: Outcome,
    handler: async (input) => {
      const ctx = ctxOf();
      const { db } = ctx;
      const row = db.select().from(t.nodes).where(eq(t.nodes.id, input.assetId)).get();
      if (!row || row.kind !== 'asset') {
        return refusal('not_found', `${input.assetId} is not an asset in this ledger.`);
      }
      const held = row as typeof row & { soldOn?: string | null; boughtFor?: number | null };
      if (held.soldOn) {
        return refusal('immutable', `${row.name} was already sold, on ${held.soldOn}.`,
                       'Undo that sale from the movement log if it was recorded wrongly.');
      }
      const acct = ctx.ledger().node(input.accountId);
      if (!acct) return refusal('unknown_node', `${input.accountId} is not an account in this ledger.`);

      const market = readMarket(db);
      const rateOf = (code?: string | null) =>
        !code || code === 'EGP' ? 1 : (market.fxRates[code] ?? 1);

      const assetCurrency = row.currency ?? 'EGP';
      const priceCurrency = input.currency ?? assetCurrency;
      const priceEgp = input.price * rateOf(priceCurrency);

      /**
       * What the price is measured against.
       *
       * On a plan, what has actually been handed over so far — the same figure the portfolio
       * shows and zakat counts, read the same way `assets.list` reads it, so the three cannot
       * disagree about what a half-paid flat has cost. Bought outright, the price it was
       * bought at; and where that was never recorded — an asset older than the column — what
       * it is worth now, which is the only answer the ledger still has.
       */
      const plan = db.select().from(t.installments)
        .where(eq(t.installments.propertyId, input.assetId)).all();
      const onPlan = plan.length > 0;
      const balance = allBalances(db)[input.assetId] ?? row.openingQty;
      const basisEgp = purchaseBasisEgp(row, plan, balance, market);

      const date = input.date ?? today(ctx);
      const proceeds = priceEgp / rateOf(acct.currency);
      const profit = priceEgp - basisEgp;

      /**
       * What the sale moves.
       *
       * The thing leaves at whatever it still stands at in the ledger and the money arrives
       * at what it fetched; the two are different figures, and their difference is the profit.
       * Something that stands at nothing — a plan where no payment has bought equity yet —
       * has nothing to take out, so the movement is the money arriving and nothing else,
       * rather than a leg moving nought, which is not a movement at all.
       */
      const legs = balance > 0
        ? [{ fromNodeId: input.assetId, qtyFrom: balance, toNodeId: input.accountId, qtyTo: proceeds }]
        : [{ toNodeId: input.accountId, qtyFrom: proceeds }];

      return post(ctx, {
        date, kind: 'sale', note: input.note ?? `${row.name} sold`,
        legs,
      }, `${row.name} sold for ${Math.round(input.price)} ${priceCurrency} into ${acct.name}` +
         ` — ${profit >= 0 ? 'a gain' : 'a loss'} of ${Math.abs(Math.round(profit))} EGP against the ${
           onPlan ? 'payments made' : 'price paid'}`,
      {
        dryRun: input.dryRun,
        after: (db2, movementId) => {
          db2.update(t.nodes).set({
            soldOn: date, soldPrice: input.price, soldCurrency: priceCurrency,
            soldAccountId: input.accountId, soldBasis: basisEgp, soldMovementId: movementId,
            // It is not owned any more, so it leaves the lists the way anything else does.
            archived: true,
          }).where(eq(t.nodes.id, input.assetId)).run();
        },
      });
    },
  }),

  command({
    name: 'asset.remove',
    context: 'holdings',
    summary: 'Archive an asset. It leaves the lists; every movement against it stays recorded.',
    input: z.object({ assetId: NodeId, restore: z.boolean().default(false) }),
    output: Outcome,
    handler: async ({ assetId, restore }) => {
      const { db } = ctxOf();
      const row = db.select().from(t.nodes).where(eq(t.nodes.id, assetId)).get();
      if (!row) return refusal('not_found', `${assetId} is not an asset in this ledger.`);
      db.update(t.nodes).set({ archived: !restore }).where(eq(t.nodes.id, assetId)).run();
      return noted(`${row.name} ${restore ? 'restored' : 'archived'}`);
    },
  }),
];
