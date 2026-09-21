import { z } from 'zod';
import { command, query, DateOnly, NodeId, CategoryId, Outcome, type Refusal } from '@ledger/contracts';
import { schema as t } from '@ledger/db';
import { desc, eq } from 'drizzle-orm';
import { zakatDates, zakatDebts, zakatReceivables, nisabEgp, formatHijri, HIJRI_MONTHS,
         NISAB_GOLD_G, NISAB_SILVER_G, ZAKAT_RATE, bucketDue, correctionEntry, zakatYearId,
         zakatTotals, hijriTextOfIso, type ZakatSettings, type ZakatEntry } from '@ledger/engine';
import type { AppCtx } from '../context.js';
import { post, noted, refusal, today, newId, DryRun, undoMovement, atomically,
         inAccountQty } from './shared.js';
import { nextSeq, rateFor } from './spending.js';
import { readPref, writePref, buildDataset } from '../read.js';
import { ledgerHoldings } from '../valuation.js';
import { assetsForZakat } from '../zakat-assets.js';
import { zakatBuckets, ESTATE, type BucketSources } from '../zakat-buckets.js';

const DEFAULT_ZAKAT: ZakatSettings = {
  anniversaryMonth: 9, anniversaryDay: 1, basis: 'gold', silverPerG: 52, deductDebts: false,
};

/**
 * Everything the buckets are built from, read once.
 *
 * The assessment, confirming a year and listing the years all need the same picture of what
 * is held and what is owed. Reading it in one place means the figure an owner confirms is the
 * figure they were shown, which is the whole point of confirming it.
 */
function bucketSources(ctx: AppCtx): BucketSources {
  const settings = (readPref(ctx.db, 'zakat') as ZakatSettings | undefined) ?? DEFAULT_ZAKAT;
  const { data, market } = buildDataset(ctx.db, ctx.now);
  const rate = (c: string) => (c === 'EGP' ? 1 : market.fxRates[c] ?? 1);
  const held = ledgerHoldings(ctx.db, market);
  const nisab = nisabEgp(market, settings);
  const owned = assetsForZakat(ctx.db, ctx.now, market, nisab);
  const receivables = zakatReceivables(data, rate);

  /**
   * The day the books start.
   *
   * A ledger opened from a snapshot says so. Otherwise it is the earliest date anything on
   * record happened on — a movement, a lot of gold bought, a flat acquired. Reading only the
   * movements would say a ledger holding nothing but an opening position and a gold lot from
   * 2019 knows nothing about any year, and no year would ever close on it.
   */
  const snapshot = readPref<{ effectiveFrom?: string }>(ctx.db, 'snapshot');
  const earliest = [
    ...ctx.db.select().from(t.transactions).all().map((x) => x.date),
    ...ctx.db.select().from(t.goldLots).all().map((l) => l.dateText),
    ...ctx.db.select().from(t.nodes).all()
      .flatMap((n) => [n.acquiredOn, n.intentionSince, n.nisabMetOn]),
  ].filter((d): d is string => !!d).sort()[0];

  return {
    now: ctx.now, settings, nisab,
    cash: held.cash, shares: held.shares, brokerageCash: held.brokerageCash,
    receivables,
    debts: zakatDebts(data, ctx.now, settings, rate),
    deductDebts: settings.deductDebts,
    owned,
    ledgerSince: snapshot?.effectiveFrom ?? earliest ?? null,
  };
}

/**
 * A lunar year that has closed writes itself down.
 *
 * What is owed stops moving the day the year closes; the figure behind it does not, because it
 * is worked out from prices that go on changing. Something has to freeze it, and it used to be
 * a button: a year sat closed and unrecorded until somebody pressed Confirm, and the figure
 * they eventually froze was the one prices happened to give that day rather than the one owed
 * on the day it closed. There is no button now. The first read or tick after the year closes
 * writes it, with the prices in force then, and what was owed is on the record from the moment
 * it was owed.
 *
 * A year already on the record is left exactly as it is — including one whose figure the owner
 * has since corrected, which is the whole reason corrections are kept.
 */
export function closeDueYears(ctx: AppCtx): string[] {
  const written: string[] = [];
  const src = bucketSources(ctx);
  for (const bucket of zakatBuckets(ctx.db, src)) {
    if (!bucket.closedOn || bucket.confirmed) continue;
    const id = zakatYearId(bucket.id, bucket.closedOn);
    if (ctx.db.select().from(t.zakatYears).where(eq(t.zakatYears.id, id)).get()) continue;
    const prices = pricesNow(ctx);
    ctx.db.insert(t.zakatYears).values({
      id, bucket: bucket.id, label: bucket.label,
      startOn: bucket.hawl?.startOn ?? bucket.closedOn,
      dueOn: bucket.closedOn,
      dueHijri: bucket.hawl?.startHijriText ?? '',
      anchorOn: bucket.anchorOn,
      base: bucket.base, due: bucketDue(bucket.base),
      nisab: src.nisab, basis: src.settings.basis,
      goldPerG: prices.goldPerG, silverPerG: prices.silverPerG,
      entries: bucket.entries, note: null,
      confirmedAt: ctx.now.toISOString(),
      manual: false, paidManual: 0,
    }).onConflictDoNothing().run();
    written.push(id);
  }
  return written;
}

/** the market prices behind a confirmed figure, so it can be read back years later */
function pricesNow(ctx: AppCtx) {
  const { market } = buildDataset(ctx.db, ctx.now);
  return { goldPerG: market.goldPerG ?? null, silverPerG: market.prices.silver_g ?? null };
}

/**
 * Which year a zakat payment discharges.
 *
 * Named outright when the owner says so. Otherwise, if exactly one confirmed year is still
 * short, that is the one — there is no other it could be. Two years outstanding and the
 * payment is left unattributed rather than credited to a guess, because a payment credited to
 * the wrong year leaves one year overpaid and another still owed, and nothing on the screen
 * says which.
 */
function resolveZakatYear(
  ctx: AppCtx, named: string | undefined, isZakat: boolean,
): { id: string | null } | Refusal {
  if (!named) {
    if (!isZakat) return { id: null };
    const given = ctx.db.select().from(t.charity).all();
    const short = ctx.db.select().from(t.zakatYears).all().filter((y) => {
      const paid = given
        .filter((c) => (c as { zakatYearId?: string | null }).zakatYearId === y.id)
        .reduce((s2, c) => s2 + c.egp, 0);
      return y.due - paid > 0;
    });
    return { id: short.length === 1 ? short[0]!.id : null };
  }
  if (!isZakat) {
    return refusal('immutable', 'Sadaqat discharges no obligation, so it cannot be booked against a zakat year.',
      'Record it with isZakat true, or leave the year off.');
  }
  const year = ctx.db.select().from(t.zakatYears).where(eq(t.zakatYears.id, named)).get();
  if (!year) {
    return refusal('not_found', `${named} is not a confirmed zakat year.`,
      'Call zakat.years to list them, or zakat.confirm to close one first.');
  }
  return { id: year.id };
}

const BucketShape = z.object({
  id: z.string(), label: z.string(), kind: z.string(),
  anchorOn: z.string().nullable(),
  closedOn: z.string().nullable(),
  state: z.enum(['running', 'draft', 'confirmed']),
  base: z.number(), due: z.number(), aboveNisab: z.boolean(),
  entries: z.array(z.object({
    id: z.string(), label: z.string(), detail: z.string().optional(),
    sign: z.union([z.literal(1), z.literal(-1), z.literal(0)]),
    amount: z.number(), note: z.string().optional(),
    group: z.enum(['counted', 'excluded', 'debt']).optional(),
    facts: z.array(z.object({ label: z.string(), value: z.string() })).optional(),
    /** what the ledger worked the line out to be, where the owner has said otherwise */
    computed: z.number().optional(),
    overridden: z.boolean().optional(),
    /** a line the owner wrote rather than one the ledger produced */
    typed: z.boolean().optional(),
  })),
  hawl: z.object({
    startOn: z.string(), startHijriText: z.string(),
    dueOn: z.string(), dueHijriText: z.string(),
    yearsComplete: z.number(), complete: z.boolean(),
    daysRemaining: z.number(), elapsedPct: z.number(),
  }).nullable(),
  confirmed: z.object({
    id: z.string(), dueOn: z.string(), dueHijri: z.string(), confirmedAt: z.string(),
    base: z.number(), due: z.number(), note: z.string().nullable(),
    paid: z.number(), remaining: z.number(),
    entries: z.array(z.object({
      id: z.string(), label: z.string(), detail: z.string().optional(),
      sign: z.union([z.literal(1), z.literal(-1), z.literal(0)]),
      amount: z.number(), note: z.string().optional(),
      group: z.enum(['counted', 'excluded', 'debt']).optional(),
      facts: z.array(z.object({ label: z.string(), value: z.string() })).optional(),
    })),
  }).nullable(),
});

/** trim a bucket to the shape the contract publishes */
function publish(b: ReturnType<typeof zakatBuckets>[number]) {
  return {
    id: b.id, label: b.label, kind: b.kind,
    anchorOn: b.anchorOn, closedOn: b.closedOn, state: b.state,
    base: b.base, due: b.due, aboveNisab: b.aboveNisab,
    entries: b.entries,
    hawl: b.hawl && {
      startOn: b.hawl.startOn, startHijriText: b.hawl.startHijriText,
      dueOn: b.hawl.dueOn, dueHijriText: b.hawl.dueHijriText,
      yearsComplete: b.hawl.yearsComplete, complete: b.hawl.complete,
      daysRemaining: b.hawl.daysRemaining, elapsedPct: b.hawl.elapsedPct,
    },
    confirmed: b.confirmed,
  };
}

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
      /** the confirmed year this discharges; left off, a lone outstanding year is assumed */
      zakatYearId: z.string().optional(),
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

      const year = resolveZakatYear(ctx, input.zakatYearId, input.isZakat);
      if ('ok' in year) return year;

      const date = input.date ?? today(ctx);
      const currency = input.currency ?? acct.currency ?? 'EGP';
      const id = newId('give');

      // what the account actually loses, in what the account is held in
      const leaves = inAccountQty(ctx.db, input.amount, currency, acct.currency);

      return post(ctx, {
        date, kind: 'giving', note: input.note,
        legs: [{ fromNodeId: input.accountId, qtyFrom: leaves, categoryId: input.causeId }],
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
            note: input.note ?? null, isZakat: input.isZakat,
            zakatYearId: year.id, movementId,
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
      /** pass null to unbook it from the year it was paying */
      zakatYearId: z.string().nullable().optional(),
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

      // Explicit null unbooks it; leaving the field off keeps whatever year it already paid,
      // unless the correction has stopped it being zakat at all.
      const named = input.zakatYearId === undefined
        ? (row as { zakatYearId?: string | null }).zakatYearId ?? undefined
        : input.zakatYearId ?? undefined;
      const year = input.zakatYearId === null
        ? { id: null }
        : resolveZakatYear(ctx, named, next.isZakat);
      if ('ok' in year) return year;

      const acct = ctx.ledger().node(next.accountId);
      if (!acct) return refusal('unknown_node', `${next.accountId} is not an account in this ledger.`);
      const leaves = inAccountQty(ctx.db, next.amount, next.currency, acct.currency);

      /**
       * A correction that moves no money does not move any.
       *
       * The same rule spending keeps: where the account, the amount, its currency and the
       * date are all as they were, the record is corrected in place rather than reversed and
       * reposted, so an edit to a note or a cause does not read in the log as money handed
       * back and given again.
       */
      const moved = next.accountId !== row.accountId
        || next.amount !== (row.currency === 'EGP' ? row.egp : (row.usd ?? row.egp))
        || next.currency !== row.currency
        || next.date !== row.date;
      if (!moved) {
        ctx.db.update(t.charity).set({
          categoryId: next.causeId, note: next.note ?? null,
          isZakat: next.isZakat, zakatYearId: year.id,
        }).where(eq(t.charity.id, input.givingId)).run();
        if (row.movementId) {
          ctx.db.update(t.legs).set({ categoryId: next.causeId })
            .where(eq(t.legs.transactionId, row.movementId)).run();
          ctx.db.update(t.transactions).set({ note: next.note ?? null })
            .where(eq(t.transactions.id, row.movementId)).run();
        }
        return noted(`Updated. Nothing moved — the account, the amount and the date are as they were.`);
      }

      return atomically(ctx, () => {
        undoMovement(ctx, row.movementId);
        ctx.db.delete(t.charity).where(eq(t.charity.id, input.givingId)).run();

        return post(ctx, {
          date: next.date, kind: 'giving', note: next.note,
          legs: [{ fromNodeId: next.accountId!, qtyFrom: leaves, categoryId: next.causeId }],
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
              isZakat: next.isZakat, zakatYearId: year.id, movementId,
            }).run();
          },
        });
      });
    },
  }),

  command({
    name: 'giving.remove',
    context: 'giving',
    summary: 'Remove a record of giving, reversing the movement behind it — or take the record off and leave the money given.',
    detail: 'Reversing is the usual answer: the money returns to the account it left and the log keeps both halves, since nothing is erased. Pass reverse false where the money really was given and only this record of it is wrong — the same gift entered twice, say. The record goes and the balance stands.',
    effect: 'irreversible',
    input: z.object({
      givingId: z.string(),
      /** whether the movement behind it is reversed, putting the money back */
      reverse: z.boolean().default(true),
    }),
    output: Outcome,
    handler: async ({ givingId, reverse }) => {
      const ctx = ctxOf();
      const row = ctx.db.select().from(t.charity).where(eq(t.charity.id, givingId)).get();
      if (!row) return refusal('not_found', 'There is no such record of giving.');
      if (reverse) undoMovement(ctx, row.movementId);
      ctx.db.delete(t.charity).where(eq(t.charity.id, givingId)).run();
      return noted(reverse
        ? 'Taken off the record, and the money returned to the account it left'
        : 'Taken off the record. The movement it recorded still stands, so no balance has changed.');
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
      zakatYearId: z.string().nullable(),
    })),
    handler: async ({ kind, limit }) => {
      const { db } = ctxOf();
      return db.select().from(t.charity).orderBy(desc(t.charity.date)).limit(limit).all()
        .filter((c) => kind === 'all' || (kind === 'zakat') === c.isZakat)
        .map((c) => ({
          id: c.id, date: c.date, amount: c.usd ?? c.egp, currency: c.currency,
          egp: c.egp, isZakat: c.isZakat, causeId: c.categoryId,
          accountId: c.accountId, note: c.note,
          zakatYearId: (c as { zakatYearId?: string | null }).zakatYearId ?? null,
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
      /** what money itself contributes */
      cash: z.number(), stocks: z.number(),
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
      /**
       * The settings the figures above were worked out under.
       *
       * The screen holds its own copy so a change answers instantly, but the ledger's copy is
       * the one the arithmetic used — and a screen showing one anniversary beside dates
       * reckoned from another is worse than a screen that waits.
       */
      settings: z.object({
        anniversaryMonth: z.number(), anniversaryDay: z.number(),
        basis: z.enum(['gold', 'silver']), silverPerG: z.number(), deductDebts: z.boolean(),
      }),
      /**
       * The estate, under one lunar year.
       *
       * Everything owned is counted together on the anniversary the owner stated, so this is
       * an array of one — kept as an array because confirmed years are filed per pot and the
       * years closed under the older per-kind reading are still on record. The bucket's own
       * `base` and `due` are the figures as they stand today; what is actually owed sits
       * under `confirmed`, frozen on the day the owner accepted it.
       */
      buckets: z.array(BucketShape),
      totals: z.object({
        base: z.number(), due: z.number(), paid: z.number(), remaining: z.number(),
        estimatedBase: z.number(), estimatedDue: z.number(), drafts: z.number(),
      }),
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
       *
       * That wallet is split out here rather than left in the cash pile. It is money and the
       * base counts it either way, but every screen that draws the share book draws the
       * positions and the wallet behind them as one thing, and an owner comparing the two
       * pages has to read the same split on both.
       */
      const held = ledgerHoldings(ctx.db, market);
      const cash = held.cash - held.brokerageCash;

      // Money lent out is wealth you happen not to be holding, so it counts — unless you have
      // written it off, in which case it is not wealth at all.
      const receivables = manual ? [] : zakatReceivables(data, rate);
      const owedToYou = receivables.reduce((s2, r) => s2 + r.amountEgp, 0);

      const nisabNow = nisabEgp(market, z);

      /**
       * Things, judged one at a time.
       *
       * A flat lived in counts nothing, a flat held to sell counts in full, a flat let out
       * counts nothing itself — its rent landed in an account, and cash has it already. Each
       * of those turns on what the thing is held for, which is why this is worked out rather
       * than assumed.
       */
      const owned = manual
        ? { lines: [], counted: 0, countedRent: 0, heldBack: 0,
            metal: { zakatableEgp: 0, personalGrams: 0, investmentGrams: 0, lines: [] } }
        : assetsForZakat(ctx.db, ctx.now, market, nisabNow);

      const debts = manual ? [] : zakatDebts(data, ctx.now, z, rate);
      const owed = debts.reduce((s, d) => s + d.amountEgp, 0);
      const dates = zakatDates(ctx.now, z);
      const nisab = nisabNow;

      /**
       * The estate, and the answer.
       *
       * The headline figure is the bucket's own rather than a second reckoning beside it.
       * Two sums over the same wealth would disagree the first time either was changed, and
       * the one an owner is asked to confirm has to be the one they were shown.
       */
      // A year that has closed is written down before it is read about, so the figure the
      // screen shows as owed is the one on the record rather than one still moving.
      if (!manual) closeDueYears(ctx);
      const buckets = manual ? [] : zakatBuckets(ctx.db, bucketSources(ctx));
      const totals = zakatTotals(buckets);
      const estate = buckets[0];

      const included = manual
        ? manual.cash + manual.gold + manual.stocks
        : (estate?.entries ?? []).filter((e) => e.group !== 'debt')
            .reduce((s2, e) => s2 + e.sign * e.amount, 0);
      const base = manual
        ? Math.max(0, z.deductDebts ? included - owed : included)
        : estate?.base ?? 0;

      return {
        buckets: buckets.map(publish),
        totals,
        settings: {
          anniversaryMonth: z.anniversaryMonth, anniversaryDay: z.anniversaryDay,
          basis: z.basis, silverPerG: z.silverPerG, deductDebts: z.deductDebts,
        },
        due: base * ZAKAT_RATE, base, baseBeforeDebts: Math.max(0, included),
        nisab, nisabGrams: z.basis === 'silver' ? NISAB_SILVER_G : NISAB_GOLD_G, basis: z.basis,
        aboveNisab: base >= nisab,
        hawl: {
          startsOn: dates.start.toISOString().slice(0, 10), startsHijri: formatHijri(dates.startHijri),
          dueOn: dates.due.toISOString().slice(0, 10), dueHijri: formatHijri(dates.dueHijri),
          daysAway: dates.daysAway,
        },
        debts, receivables, owedToYou, deductDebts: z.deductDebts,
        cash: manual ? manual.cash : cash,
        stocks: manual ? manual.stocks : held.shares + held.brokerageCash,
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
    name: 'zakat.year.add',
    context: 'giving',
    summary: 'Write down a year from before this ledger: what was owed, and what was paid against it.',
    detail: 'Years the ledger lived through close themselves off what was held. This is for the ones it did not: all that survives of them is the figure and the payment, and a record of zakat that starts the day the app was installed is not a record of zakat. Nothing here is worked out from anything — it is what you remember, kept where the rest is kept.',
    input: z.object({
      label: z.string().min(1).max(80).default('Everything you own'),
      /** the day the year closed, which is what it is filed under */
      dueOn: DateOnly,
      /** what was owed that year */
      due: z.number().min(0),
      /** what was paid against it, where that is remembered as one figure */
      paid: z.number().min(0).default(0),
      /** the wealth it was reckoned on, where that is remembered at all */
      base: z.number().min(0).optional(),
      note: z.string().max(500).optional(),
    }),
    output: Outcome,
    handler: async (input) => {
      const ctx = ctxOf();
      const id = zakatYearId(ESTATE, input.dueOn);
      const already = ctx.db.select().from(t.zakatYears).where(eq(t.zakatYears.id, id)).get();
      if (already) {
        return refusal('duplicate', `A year is already filed under ${input.dueOn}.`,
                       'Correct that one with zakat.year.update, or file this under the day it actually closed.');
      }
      // a year is filed by the lunar date it closed on, the same as one the ledger closed
      const hijri = hijriTextOfIso(input.dueOn) ?? '';
      ctx.db.insert(t.zakatYears).values({
        id, bucket: ESTATE, label: input.label,
        // A year typed in has one date that means anything, and it is the day it closed.
        startOn: input.dueOn, dueOn: input.dueOn, dueHijri: hijri,
        anchorOn: null,
        base: input.base ?? input.due / ZAKAT_RATE, due: input.due,
        nisab: 0, basis: 'gold', goldPerG: null, silverPerG: null,
        entries: [], note: input.note ?? null,
        confirmedAt: ctx.now.toISOString(),
        manual: true, paidManual: input.paid,
      }).run();
      return noted(`${input.label} for ${input.dueOn}: ${Math.round(input.due)} owed, ${Math.round(input.paid)} paid`);
    },
  }),

  command({
    name: 'zakat.year.update',
    context: 'giving',
    summary: 'Correct a year on the record — what was owed, what it was reckoned on, what was paid, the note.',
    detail: 'A year closed by the ledger holds the arithmetic it was closed on; correcting the figure leaves that arithmetic standing beside it, which is the point of having kept it. What was paid can only be stated outright on a year typed in by hand — on the others it is the giving records booked against the year, and those are corrected where they are.',
    input: z.object({
      yearId: z.string(),
      base: z.number().min(0).optional(),
      due: z.number().min(0).optional(),
      /** only on a year typed in by hand */
      paid: z.number().min(0).optional(),
      label: z.string().min(1).max(80).optional(),
      note: z.string().max(500).optional(),
    }),
    output: Outcome,
    handler: async ({ yearId, ...patch }) => {
      const ctx = ctxOf();
      const row = ctx.db.select().from(t.zakatYears).where(eq(t.zakatYears.id, yearId)).get();
      if (!row) return refusal('not_found', 'There is no year on the record with that id.');
      if (patch.paid != null && !(row as { manual?: boolean }).manual) {
        return refusal('immutable',
          'What has been paid against this year is the giving recorded against it.',
          'Correct the payment itself, or record another against the year.');
      }
      const clean: Record<string, unknown> = {};
      if (patch.base != null) clean.base = patch.base;
      if (patch.due != null) clean.due = patch.due;
      if (patch.paid != null) clean.paidManual = patch.paid;
      if (patch.label) clean.label = patch.label;
      if (patch.note !== undefined) clean.note = patch.note;
      if (Object.keys(clean).length) {
        ctx.db.update(t.zakatYears).set(clean).where(eq(t.zakatYears.id, yearId)).run();
      }
      return noted(`${patch.label ?? row.label} for ${row.dueOn} updated`);
    },
  }),

  command({
    name: 'zakat.year.remove',
    context: 'giving',
    summary: 'Take a year off the record.',
    detail: 'A year the ledger closed for itself will close again the next time it is asked, since the lunar year it stands on has still passed — removing one is for the years typed in by hand. Payments booked against it keep their record and lose the year they were paying.',
    effect: 'irreversible',
    input: z.object({ yearId: z.string() }),
    output: Outcome,
    handler: async ({ yearId }) => {
      const ctx = ctxOf();
      const row = ctx.db.select().from(t.zakatYears).where(eq(t.zakatYears.id, yearId)).get();
      if (!row) return refusal('not_found', 'There is no year on the record with that id.');
      ctx.db.update(t.charity).set({ zakatYearId: null })
        .where(eq(t.charity.zakatYearId, yearId)).run();
      ctx.db.delete(t.zakatYears).where(eq(t.zakatYears.id, yearId)).run();
      return noted(`${row.label} for ${row.dueOn} taken off the record`);
    },
  }),

  command({
    name: 'zakat.entry.set',
    context: 'giving',
    summary: 'State a line of the reckoning yourself: correct one the ledger worked out, leave one out, or add one it cannot see.',
    detail: 'Naming an entry corrects that line — the ledger\'s own figure is kept beside yours and the correction can be taken back. Naming none adds a line of your own, which is how wealth the app has never been told about is counted: gold at a relative\'s, a loan nobody wrote down.',
    input: z.object({
      /** the computed line being corrected; left out, this is a line of your own */
      entryId: z.string().optional(),
      /** what to call a line of your own */
      label: z.string().min(1).max(80).optional(),
      /** which section it is read under */
      group: z.enum(['counted', 'excluded', 'debt']).optional(),
      /** 1 counts towards the base, -1 comes off it, 0 is shown and counts nothing */
      sign: z.union([z.literal(1), z.literal(-1), z.literal(0)]).optional(),
      amount: z.number().min(0).optional(),
      /** whether to leave the line out of the reckoning altogether */
      removed: z.boolean().optional(),
      note: z.string().max(300).optional(),
    }),
    output: Outcome,
    handler: async (input) => {
      const ctx = ctxOf();
      if (!input.entryId && !input.label) {
        return refusal('invalid_period', 'A line of your own needs a name.',
                       'Give a label, or name the entry you meant to correct.');
      }
      if (!input.entryId && input.amount == null) {
        return refusal('invalid_period', 'A line of your own needs an amount.');
      }

      const existing = input.entryId
        ? ctx.db.select().from(t.zakatEntries).all()
            .find((r) => r.bucket === ESTATE && r.entryId === input.entryId)
        : undefined;

      if (existing) {
        ctx.db.update(t.zakatEntries).set({
          amount: input.amount ?? existing.amount,
          removed: input.removed ?? existing.removed,
          note: input.note ?? existing.note,
        }).where(eq(t.zakatEntries.id, existing.id)).run();
        return noted(input.removed ? 'That line is left out of the reckoning' : 'That line now reads as you stated it');
      }

      const id = newId('zent');
      ctx.db.insert(t.zakatEntries).values({
        id, bucket: ESTATE, entryId: input.entryId ?? null,
        label: input.label ?? null, grp: input.group ?? 'counted',
        sign: input.sign ?? (input.group === 'debt' ? -1 : input.group === 'excluded' ? 0 : 1),
        amount: input.amount ?? null,
        removed: input.removed ?? false,
        note: input.note ?? null,
        createdAt: ctx.now.toISOString(),
      }).run();
      return noted(input.entryId
        ? (input.removed ? 'That line is left out of the reckoning' : 'That line now reads as you stated it')
        : `${input.label} counted in the reckoning`);
    },
  }),

  command({
    name: 'zakat.entry.clear',
    context: 'giving',
    summary: 'Take back what you said about a line: the ledger\'s own figure stands again, or a line of your own goes.',
    input: z.object({
      /** the computed line to restore, or the id of a line of your own to delete */
      entryId: z.string(),
    }),
    output: Outcome,
    handler: async ({ entryId }) => {
      const ctx = ctxOf();
      const row = ctx.db.select().from(t.zakatEntries).all()
        .find((r) => r.bucket === ESTATE && (r.entryId === entryId || r.id === entryId));
      if (!row) return refusal('not_found', 'Nothing has been said about that line.');
      ctx.db.delete(t.zakatEntries).where(eq(t.zakatEntries.id, row.id)).run();
      return noted(row.entryId ? 'The ledger\'s own figure stands again' : `${row.label ?? 'That line'} removed`);
    },
  }),

  query({
    name: 'zakat.years',
    context: 'giving',
    summary: 'Every lunar year confirmed, in full: the arithmetic it was worked out from, what it owed, what has been paid against it, and what is left.',
    detail: 'This is the record of past years. Each one carries the lines it was worked out from and the prices in force the day it closed, so a figure from three years ago can be read back and explained rather than merely remembered.',
    input: z.object({
      bucket: z.string().optional(),
      outstanding: z.boolean().default(false),
      limit: z.number().int().min(1).max(200).default(50),
    }),
    output: z.array(z.object({
      id: z.string(), bucket: z.string(), label: z.string(),
      /** whether it was typed in for the record rather than closed by the ledger */
      manual: z.boolean(),
      startOn: z.string(), dueOn: z.string(), dueHijri: z.string(),
      anchorOn: z.string().nullable(),
      base: z.number(), due: z.number(), paid: z.number(), remaining: z.number(),
      nisab: z.number(), basis: z.string(), confirmedAt: z.string(),
      note: z.string().nullable(),
      /** the prices the figure was struck at, so it can be checked years later */
      goldPerG: z.number().nullable(), silverPerG: z.number().nullable(),
      /** the signed lines as they stood when the year was confirmed */
      entries: z.array(z.object({
        id: z.string(), label: z.string(), detail: z.string().optional(),
        sign: z.union([z.literal(1), z.literal(-1), z.literal(0)]),
        amount: z.number(), note: z.string().optional(),
        group: z.enum(['counted', 'excluded', 'debt']).optional(),
        facts: z.array(z.object({ label: z.string(), value: z.string() })).optional(),
      })),
      payments: z.array(z.object({
        id: z.string(), date: z.string(), egp: z.number(), causeId: z.string(),
        note: z.string().nullable(),
        /**
         * What was actually handed over, and out of what.
         *
         * `egp` is the figure the year is discharged by, which is the payment converted. A
         * screen correcting one has to show what was recorded — 200 dollars, out of the
         * dollar account — because sending the converted figure back would rewrite a dollar
         * payment as a pound one at today's rate.
         */
        amount: z.number(), currency: z.string(), accountId: z.string().nullable(),
      })),
    })),
    handler: async ({ bucket, outstanding, limit }) => {
      const ctx = ctxOf();
      const { db } = ctx;
      // A year that has closed is on the record by the time anyone reads the record.
      closeDueYears(ctx);
      const given = db.select().from(t.charity).all();
      return db.select().from(t.zakatYears).orderBy(desc(t.zakatYears.dueOn)).limit(limit).all()
        .map((y) => {
          const payments = given
            .filter((c) => (c as { zakatYearId?: string | null }).zakatYearId === y.id)
            .map((c) => ({
              id: c.id, date: c.date, egp: c.egp, causeId: c.categoryId, note: c.note,
              amount: c.currency === 'EGP' ? c.egp : (c.usd ?? c.egp),
              currency: c.currency ?? 'EGP', accountId: c.accountId ?? null,
            }))
            // newest first, as every other log in the ledger reads
            .sort((a, b) => b.date.localeCompare(a.date));
          // what was booked against it, plus what a year typed in by hand remembers being paid
          const paid = payments.reduce((s2, c) => s2 + c.egp, 0)
            + ((y as { paidManual?: number }).paidManual ?? 0);
          return {
            id: y.id, bucket: y.bucket, label: y.label,
            manual: !!(y as { manual?: boolean }).manual,
            startOn: y.startOn, dueOn: y.dueOn, dueHijri: y.dueHijri, anchorOn: y.anchorOn,
            base: y.base, due: y.due, paid, remaining: Math.max(0, y.due - paid),
            nisab: y.nisab, basis: y.basis, confirmedAt: y.confirmedAt, note: y.note,
            goldPerG: y.goldPerG, silverPerG: y.silverPerG,
            entries: (y.entries as ZakatEntry[]) ?? [],
            payments,
          };
        })
        .filter((y) => (!outstanding || y.remaining > 0) && (!bucket || y.bucket === bucket));
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
