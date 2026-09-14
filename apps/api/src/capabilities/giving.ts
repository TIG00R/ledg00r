import { z } from 'zod';
import { command, query, DateOnly, NodeId, CategoryId, Outcome } from '@ledger/contracts';
import { schema as t, allBalances } from '@ledger/db';
import { desc, eq } from 'drizzle-orm';
import { zakatDates, zakatDebts, zakatReceivables, nisabEgp, formatHijri, HIJRI_MONTHS,
         NISAB_GOLD_G, NISAB_SILVER_G, type ZakatSettings } from '@ledger/engine';
import type { AppCtx } from '../context.js';
import { post, noted, refusal, today, newId, bucketOf, DryRun, undoMovement, atomically } from './shared.js';
import { nextSeq, rateFor } from './spending.js';
import { readPref, writePref, buildDataset } from '../read.js';
import { ledgerHoldings } from '../valuation.js';
import { assetsForZakat } from '../zakat-assets.js';

const DEFAULT_ZAKAT: ZakatSettings = {
  anniversaryMonth: 9, anniversaryDay: 1, basis: 'gold', silverPerG: 52, deductDebts: false,
};

/**
 * Zakat and sadaqat.
 *
 * Zakat is the only part of this ledger that runs on the lunar calendar, and the anniversary
 * is a setting rather than something the data can imply — the app knows what is owned now,
 * not when it first passed nisab. Everything downstream of that anniversary is arithmetic.
 */
export const givingCaps = (ctxOf: () => AppCtx) => [
  command({
    name: 'giving.record',
    context: 'giving',
    summary: 'Record money given away, out of a named account, as zakat or as sadaqat.',
    detail: 'The distinction matters: zakat counts against the obligation, sadaqat is given freely and owed by nobody.',
    input: z.object({
      accountId: NodeId,
      amount: z.number().positive(),
      currency: z.string().regex(/^[A-Z]{3}$/).optional(),
      causeId: CategoryId,
      isZakat: z.boolean().default(false),
      date: DateOnly.optional(),
      note: z.string().max(500).optional(),
    }).merge(DryRun),
    output: Outcome,
    handler: async (input) => {
      const ctx = ctxOf();
      const acct = ctx.ledger().node(input.accountId);
      if (!acct) return refusal('unknown_node', `${input.accountId} is not an account in this ledger.`);
      const cause = ctx.db.select().from(t.categories).where(eq(t.categories.id, input.causeId)).get();
      if (!cause) return refusal('not_found', `${input.causeId} is not a cause.`, 'Call destinations.list with domain "charity".');

      const date = input.date ?? today(ctx);
      const currency = input.currency ?? acct.currency ?? 'EGP';
      const id = newId('give');

      return post(ctx, {
        date, kind: 'giving', note: input.note,
        legs: [{ fromNodeId: input.accountId, qtyFrom: input.amount, categoryId: input.causeId }],
      }, `${input.amount} ${currency} to ${cause.name}, as ${input.isZakat ? 'zakat' : 'sadaqat'}`,
      {
        dryRun: input.dryRun,
        index: [{ kind: 'giving', recordId: id, title: cause.name, body: input.note ?? '' }],
        after: (db, movementId) => {
          const rate = currency === 'EGP' ? 1 : rateFor(db, currency);
          db.insert(t.charity).values({
            id, seq: nextSeq(db, 'charity'), date, egp: input.amount * rate,
            usd: currency === 'USD' ? input.amount : null, currency,
            accountId: input.accountId, categoryId: input.causeId,
            note: input.note ?? null, isZakat: input.isZakat, movementId,
          }).run();
        },
      });
    },
  }),

  command({
    name: 'giving.correct',
    context: 'giving',
    summary: 'Correct something given — the amount, the account it came out of, the cause, whether it was zakat, the date, the note.',
    detail: 'The movement is reversed and written again, so the balances follow and the log keeps both. Whether it counted as zakat is part of what can be corrected, because that is the thing most easily recorded wrongly.',
    input: z.object({
      givingId: z.string(),
      accountId: NodeId.optional(),
      amount: z.number().positive().optional(),
      currency: z.string().regex(/^[A-Z]{3}$/).optional(),
      causeId: CategoryId.optional(),
      isZakat: z.boolean().optional(),
      date: DateOnly.optional(),
      note: z.string().max(500).optional(),
    }),
    output: Outcome,
    handler: async (input) => {
      const ctx = ctxOf();
      const row = ctx.db.select().from(t.charity).where(eq(t.charity.id, input.givingId)).get();
      if (!row) return refusal('not_found', 'There is no such record of giving.');

      const next = {
        accountId: input.accountId ?? row.accountId,
        amount: input.amount ?? (row.currency === 'EGP' ? row.egp : (row.usd ?? row.egp)),
        currency: input.currency ?? row.currency ?? 'EGP',
        causeId: input.causeId ?? row.categoryId,
        isZakat: input.isZakat ?? row.isZakat,
        date: input.date ?? row.date,
        note: input.note ?? row.note ?? undefined,
      };
      if (!next.accountId) return refusal('unknown_node', 'That record names no account it came out of.');
      const cause = ctx.db.select().from(t.categories).where(eq(t.categories.id, next.causeId)).get();
      if (!cause) return refusal('not_found', `${next.causeId} is not a cause.`);

      return atomically(ctx, () => {
        undoMovement(ctx, row.movementId);
        ctx.db.delete(t.charity).where(eq(t.charity.id, input.givingId)).run();

        return post(ctx, {
          date: next.date, kind: 'giving', note: next.note,
          legs: [{ fromNodeId: next.accountId!, qtyFrom: next.amount, categoryId: next.causeId }],
        }, `corrected to ${next.amount} ${next.currency} to ${cause.name}, as ${next.isZakat ? 'zakat' : 'sadaqat'}`,
        {
          index: [{ kind: 'giving', recordId: input.givingId, title: cause.name, body: next.note ?? '' }],
          after: (db, movementId) => {
            const rate = next.currency === 'EGP' ? 1 : rateFor(db, next.currency);
            db.insert(t.charity).values({
              id: input.givingId, seq: row.seq, date: next.date,
              egp: next.amount * rate, usd: next.currency === 'USD' ? next.amount : null,
              currency: next.currency, accountId: next.accountId,
              categoryId: next.causeId, note: next.note ?? null,
              isZakat: next.isZakat, movementId,
            }).run();
          },
        });
      });
    },
  }),

  command({
    name: 'giving.remove',
    context: 'giving',
    summary: 'Remove a record of giving, reversing the movement behind it.',
    detail: 'The money returns to the account it left, and the log keeps both the giving and its reversal — nothing is erased.',
    effect: 'irreversible',
    input: z.object({ givingId: z.string() }),
    output: Outcome,
    handler: async ({ givingId }) => {
      const ctx = ctxOf();
      const row = ctx.db.select().from(t.charity).where(eq(t.charity.id, givingId)).get();
      if (!row) return refusal('not_found', 'There is no such record of giving.');
      undoMovement(ctx, row.movementId);
      ctx.db.delete(t.charity).where(eq(t.charity.id, givingId)).run();
      return noted('Taken off the record, and the money returned to the account it left');
    },
  }),

  query({
    name: 'giving.list',
    context: 'giving',
    summary: 'Everything given, newest first, both kinds in one list.',
    input: z.object({
      kind: z.enum(['all', 'zakat', 'sadaqat']).default('all'),
      limit: z.number().int().min(1).max(500).default(100),
    }),
    output: z.array(z.object({
      id: z.string(), date: z.string(), amount: z.number(), currency: z.string(),
      egp: z.number(), isZakat: z.boolean(), causeId: z.string(),
      accountId: z.string().nullable(), note: z.string().nullable(),
    })),
    handler: async ({ kind, limit }) => {
      const { db } = ctxOf();
      return db.select().from(t.charity).orderBy(desc(t.charity.date)).limit(limit).all()
        .filter((c) => kind === 'all' || (kind === 'zakat') === c.isZakat)
        .map((c) => ({
          id: c.id, date: c.date, amount: c.usd ?? c.egp, currency: c.currency,
          egp: c.egp, isZakat: c.isZakat, causeId: c.categoryId,
          accountId: c.accountId, note: c.note,
        }));
    },
  }),

  query({
    name: 'zakat.assessment',
    context: 'giving',
    summary: 'What zakat is due, on what base, against which threshold, and when the hawl closes.',
    detail: 'Filled from what is owned unless figures are supplied. Debts are what is still to be paid inside this hawl — not the whole contract balance of a property, which would wipe the base out while its installments are already counted.',
    input: z.object({
      manual: z.object({ cash: z.number(), gold: z.number(), stocks: z.number() }).optional(),
    }),
    output: z.object({
      due: z.number(), base: z.number(), baseBeforeDebts: z.number(),
      nisab: z.number(), nisabGrams: z.number(), basis: z.string(),
      aboveNisab: z.boolean(),
      hawl: z.object({
        startsOn: z.string(), startsHijri: z.string(),
        dueOn: z.string(), dueHijri: z.string(), daysAway: z.number(),
      }),
      /** what money itself contributes, before anything held back comes off it */
      cash: z.number(), stocks: z.number(),
      /** rent earned but not yet through a full lunar year, so not counted through cash */
      heldBack: z.number(),
      /** rent that has carried a lunar year — already in the base, through the account it landed in */
      countedRent: z.number(),
      /**
       * One line per thing owned: what it is, what it is held for, the dates that decide it,
       * and what it therefore counted. A line that counts nothing says which of the four
       * tests it failed.
       */
      assets: z.array(z.object({
        id: z.string(), name: z.string(), kind: z.string(),
        intention: z.string().nullable(), intentionLabel: z.string(),
        basis: z.string(), value: z.number(), counted: z.number(),
        included: z.boolean(), heldBack: z.number(), aboveNisab: z.boolean(),
        anchorOn: z.string().nullable(), reason: z.string(),
        dates: z.object({
          acquiredOn: z.string().nullable(), intentionSince: z.string().nullable(),
          nisabMetOn: z.string().nullable(),
        }),
        hawl: z.object({
          startOn: z.string(), startHijriText: z.string(),
          dueOn: z.string(), dueHijriText: z.string(),
          yearsComplete: z.number(), complete: z.boolean(),
          daysRemaining: z.number(), elapsedPct: z.number(),
        }).nullable(),
      })),
      debts: z.array(z.object({
        id: z.string(), label: z.string(), amountEgp: z.number(),
        date: z.string(), kind: z.string(),
      })),
      /** money lent out, which counts toward the base rather than against it */
      receivables: z.array(z.object({
        id: z.string(), label: z.string(), amountEgp: z.number(), due: z.string().nullable(),
      })),
      owedToYou: z.number(),
      deductDebts: z.boolean(),
    }),
    handler: async ({ manual }) => {
      const ctx = ctxOf();
      const z = (readPref(ctx.db, 'zakat') as ZakatSettings | undefined) ?? DEFAULT_ZAKAT;
      const { data, market } = buildDataset(ctx.db, ctx.now);

      const rate = (c: string) => (c === 'EGP' ? 1 : market.fxRates[c] ?? 1);

      /**
       * Cash and shares, from what is actually held.
       *
       * The accrual figure is a forecast — it works income and spending forward from the
       * opening position and knows nothing of individual movements. That is right for a
       * projection and wrong here: lending money out has to reduce the cash you are holding
       * at the same moment it becomes something you are owed, or the base counts it twice.
       *
       * Shares come from the same reading rather than from the forecast's own idea of the
       * book, because that idea included the broker's uninvested cash — which is a cash
       * account in this ledger and was therefore being counted on both sides.
       */
      const held = ledgerHoldings(ctx.db, ctx.now, market);
      const cash = held.cash;

      // Money lent out is wealth you happen not to be holding, so it counts — unless you have
      // written it off, in which case it is not wealth at all.
      const receivables = manual ? [] : zakatReceivables(data, rate);
      const owedToYou = receivables.reduce((s2, r) => s2 + r.amountEgp, 0);

      const nisabNow = nisabEgp(market, z);

      /**
       * Things, judged one at a time.
       *
       * A flat lived in counts nothing, a flat held to sell counts in full, a flat let out
       * counts only through the rent it has earned — and each of those turns on dates as well
       * as on the answer, which is why this is worked out rather than assumed.
       *
       * `heldBack` is the other half of the rent rule. Rent that has not yet carried a full
       * lunar year is sitting in a bank account, and the cash figure above has already counted
       * it. Taking it off again is what stops the base charging a year early.
       */
      const owned = manual
        ? { lines: [], counted: 0, countedRent: 0, heldBack: 0,
            metal: { zakatableEgp: 0, personalGrams: 0, investmentGrams: 0, lines: [] } }
        : assetsForZakat(ctx.db, ctx.now, market, nisabNow);
      const heldBack = Math.min(owned.heldBack, cash);

      const included = manual
        ? manual.cash + manual.gold + manual.stocks
        : cash - heldBack + held.shares + owedToYou
          + owned.metal.zakatableEgp + owned.counted;

      const debts = zakatDebts(data, ctx.now, z, rate);
      const owed = debts.reduce((s, d) => s + d.amountEgp, 0);
      const base = Math.max(0, z.deductDebts ? included - owed : included);
      const dates = zakatDates(ctx.now, z);
      const nisab = nisabNow;

      return {
        due: base * 0.025, base, baseBeforeDebts: included,
        nisab, nisabGrams: z.basis === 'silver' ? NISAB_SILVER_G : NISAB_GOLD_G, basis: z.basis,
        aboveNisab: base >= nisab,
        hawl: {
          startsOn: dates.start.toISOString().slice(0, 10), startsHijri: formatHijri(dates.startHijri),
          dueOn: dates.due.toISOString().slice(0, 10), dueHijri: formatHijri(dates.dueHijri),
          daysAway: dates.daysAway,
        },
        debts, receivables, owedToYou, deductDebts: z.deductDebts,
        cash: manual ? manual.cash : cash,
        stocks: manual ? manual.stocks : held.shares,
        heldBack, countedRent: owned.countedRent,
        assets: [...owned.lines, ...owned.metal.lines].map((l) => ({
          id: l.id, name: l.name, kind: l.kind,
          intention: l.intention, intentionLabel: l.intentionLabel,
          basis: l.basis, value: l.value, counted: l.counted, included: l.included,
          heldBack: l.heldBack, aboveNisab: l.aboveNisab, anchorOn: l.anchorOn,
          reason: l.reason, dates: l.dates,
          hawl: l.hawl && {
            startOn: l.hawl.startOn, startHijriText: l.hawl.startHijriText,
            dueOn: l.hawl.dueOn, dueHijriText: l.hawl.dueHijriText,
            yearsComplete: l.hawl.yearsComplete, complete: l.hawl.complete,
            daysRemaining: l.hawl.daysRemaining, elapsedPct: l.hawl.elapsedPct,
          },
        })),
      };
    },
  }),

  command({
    name: 'zakat.configure',
    context: 'giving',
    summary: 'Set the lunar anniversary, the nisab basis, and whether debts are deducted.',
    detail: 'The anniversary is the day wealth first passed nisab and has stayed above it since. Nothing in the data implies it, so it has to be stated. Silver gives the lower threshold and many scholars prefer it.',
    input: z.object({
      anniversaryMonth: z.number().int().min(1).max(12).optional(),
      anniversaryDay: z.number().int().min(1).max(30).optional(),
      basis: z.enum(['gold', 'silver']).optional(),
      silverPerG: z.number().positive().optional(),
      deductDebts: z.boolean().optional(),
    }),
    output: Outcome,
    handler: async (patch) => {
      const ctx = ctxOf();
      const current = (readPref(ctx.db, 'zakat') as ZakatSettings | undefined) ?? DEFAULT_ZAKAT;
      const next = { ...current, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) };
      writePref(ctx.db, 'zakat', next);
      const dates = zakatDates(ctx.now, next as ZakatSettings);
      return noted(
        `Zakat falls due ${next.anniversaryDay} ${HIJRI_MONTHS[next.anniversaryMonth - 1]}, ` +
        `next on ${dates.due.toISOString().slice(0, 10)} — ${dates.daysAway} days away`,
      );
    },
  }),
];
