import { z } from 'zod';
import { command, query, NodeId, Outcome } from '@ledger/contracts';
import { schema as t, allBalances } from '@ledger/db';
import { eq } from 'drizzle-orm';
import { installmentDueDate, defaultIntention, intentionsFor, intentionLabel,
         unitValue, type Valuation } from '@ledger/engine';
import { assetKindOf } from '../zakat-assets.js';
import { readMarket } from '../read.js';
import type { AppCtx } from '../context.js';
import { noted, refusal, newId } from './shared.js';

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
    input: z.object({ includeArchived: z.boolean().default(false) }),
    output: z.array(z.object({
      id: z.string(), name: z.string(), kind: z.string(),
      ownership: z.string(), icon: z.string().nullable(), color: z.string().nullable(),
      value: z.number(), currency: z.string().nullable(), unit: z.string().nullable(),
      planTotal: z.number(), paid: z.number(), remaining: z.number(),
      payments: z.number(), nextDue: z.string().nullable(),
      /** why it is held — the answer zakat reads before it reads the value */
      intention: z.string().nullable(),
      /** the dates the lunar year is measured from */
      intentionSince: z.string().nullable(),
      acquiredOn: z.string().nullable(),
      nisabMetOn: z.string().nullable(),
      archived: z.boolean(),
    })),
    handler: async ({ includeArchived }) => {
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
        // Metal is a weight, not an asset in this sense — it has its own screen and its own
        // arithmetic — and the brokerage book is the share book's cash.
        // Metal is a weight with its own screen and its own arithmetic, and the brokerage
        // book is the share book's own holding — neither belongs in a list of things owned.
        .filter((n) => n.kind === 'asset'
          && !n.unit
          && n.priceKey !== 'brokerage_cash'
          && !/^brokerage/.test(n.id)
          && (includeArchived || !n.archived))
        .map((n) => {
          const mine = installments.filter((i) => i.propertyId === n.id);
          const planTotal = mine.reduce((s, i) => s + i.amountEgp, 0);
          const paid = mine.filter((i) => i.paidAt).reduce((s, i) => s + i.amountEgp, 0);
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
          };

          return {
            id: n.id, name: n.name, kind,
            ownership: n.ownership ?? (mine.length ? 'installments' : 'owned'),
            icon: n.icon, color: n.color,
            intention: held.intention ?? defaultIntention(kind),
            intentionSince: held.intentionSince ?? null,
            acquiredOn: held.acquiredOn ?? null,
            nisabMetOn: held.nisabMetOn ?? null,
            value: valueOf(n, balances[n.id] ?? n.openingQty),
            currency: n.currency, unit: n.unit,
            planTotal, paid, remaining: planTotal - paid,
            payments: mine.length, nextDue: next as string | null,
            archived: n.archived,
          };
        });
    },
  }),

  command({
    name: 'asset.add',
    context: 'holdings',
    summary: 'Add something you own — a property, a vehicle, anything else — with its mark and colour.',
    detail: 'An asset bought on a plan starts at nothing and grows as payments are made; one paid for outright starts at what it is worth.',
    input: z.object({
      name: z.string().min(1).max(80),
      kind: z.enum(['property', 'vehicle', 'equipment', 'other']).default('other'),
      ownership: z.enum(['owned', 'installments']).default('owned'),
      value: z.number().min(0).default(0),
      currency: z.string().regex(/^[A-Z]{3}$/).default('EGP'),
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
    }),
    output: z.object({ id: z.string(), summary: z.string() }),
    handler: async (input) => {
      const { db } = ctxOf();
      const id = newId(input.kind === 'property' ? 'prop' : input.kind === 'vehicle' ? 'veh' : 'asset');
      const intention = input.intention ?? defaultIntention(input.kind);
      const stated = intentionsFor(input.kind).some((o) => o.id === intention)
        ? intention : defaultIntention(input.kind);
      db.insert(t.nodes).values({
        id, kind: 'asset', name: input.name, currency: input.currency,
        valuation: 'fixed', openingQty: input.ownership === 'installments' ? 0 : input.value,
        assetKind: input.kind, ownership: input.ownership,
        intention: stated,
        // a lunar year has to run from somewhere, and the day it was stated is that day
        intentionSince: input.intentionSince ?? input.acquiredOn ?? ctxOf().now.toISOString().slice(0, 10),
        acquiredOn: input.acquiredOn ?? null,
        nisabMetOn: input.nisabMetOn ?? null,
        icon: input.icon ?? null, color: input.color ?? null, archived: false,
      }).run();
      return {
        id,
        summary: input.ownership === 'installments'
          ? `${input.name} added, starting at nothing until payments are made`
          : `${input.name} added at ${input.value} ${input.currency}`,
      };
    },
  }),

  command({
    name: 'asset.update',
    context: 'holdings',
    summary: 'Rename an asset, change its mark, its colour, its currency, or how it was paid for.',
    input: z.object({
      assetId: NodeId,
      name: z.string().min(1).max(80).optional(),
      kind: z.enum(['property', 'vehicle', 'equipment', 'other']).optional(),
      ownership: z.enum(['owned', 'installments']).optional(),
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
    handler: async ({ assetId, kind, intention, ...patch }) => {
      const ctx = ctxOf();
      const db = ctx.db;
      const row = db.select().from(t.nodes).where(eq(t.nodes.id, assetId)).get();
      if (!row) return refusal('not_found', `${assetId} is not an asset in this ledger.`);
      const clean: Record<string, unknown> = Object.fromEntries(
        Object.entries(patch).filter(([, v]) => v !== undefined));
      if (kind) clean.assetKind = kind;

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
