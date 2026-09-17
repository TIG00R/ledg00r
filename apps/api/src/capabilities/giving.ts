import { z } from 'zod';
import { command, query, DateOnly, NodeId, CategoryId, Outcome, type Refusal } from '@ledger/contracts';
import { schema as t } from '@ledger/db';
import { desc, eq } from 'drizzle-orm';
import { zakatDates, zakatDebts, zakatReceivables, nisabEgp, formatHijri, HIJRI_MONTHS,
         NISAB_GOLD_G, NISAB_SILVER_G, ZAKAT_RATE, bucketDue, correctionEntry, zakatYearId,
         zakatTotals, type ZakatSettings, type ZakatEntry } from '@ledger/engine';
import type { AppCtx } from '../context.js';
import { post, noted, refusal, today, newId, DryRun, undoMovement, atomically } from './shared.js';
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
    name: 'zakat.confirm',
    context: 'giving',
    summary: 'Close a lunar year: freeze what is owed so it stops moving.',
    detail: 'What is owed was fixed on the day the year closed, but the figure behind it is worked out from today\'s prices and moves every time it is asked for. Confirming writes it down. Supply a base of your own if the ledger has it wrong — the difference is recorded as a line of its own rather than replacing the arithmetic.',
    input: z.object({
      /** the estate, which is the only pot a year is closed on now */
      bucketId: z.string().default(ESTATE),
      base: z.number().min(0).optional(),
      note: z.string().max(500).optional(),
    }).merge(DryRun),
    output: Outcome,
    handler: async (input) => {
      const ctx = ctxOf();
      const src = bucketSources(ctx);
      const bucket = zakatBuckets(ctx.db, src).find((b) => b.id === input.bucketId);
      if (!bucket) return refusal('not_found', `${input.bucketId} is not a pot of wealth in this ledger.`,
        `Everything owned is now counted together — confirm '${ESTATE}'.`);
      if (!bucket.closedOn) {
        return refusal('invalid_period',
          `${bucket.label} has no closed lunar year yet${bucket.hawl ? ` — the first closes in ${bucket.hawl.daysRemaining} days` : ''}.`,
          'Nothing is owed until a full lunar year has run, so there is nothing to confirm.');
      }
      if (bucket.confirmed) {
        return refusal('duplicate',
          `${bucket.label} is already confirmed for ${bucket.closedOn}, at ${Math.round(bucket.confirmed.due)}.`,
          'Call zakat.reopen to work it out again.');
      }

      const corrected = input.base ?? bucket.base;
      const adjustment = correctionEntry(bucket.base, corrected);
      const entries: ZakatEntry[] = adjustment ? [...bucket.entries, adjustment] : bucket.entries;
      const due = bucketDue(corrected);
      const id = zakatYearId(bucket.id, bucket.closedOn);
      const prices = pricesNow(ctx);
      const summary = `${bucket.label}: ${Math.round(due)} owed on ${Math.round(corrected)}, for the year that closed ${bucket.closedOn}`;

      if (input.dryRun) return { ...noted(summary), dryRun: true };

      ctx.db.insert(t.zakatYears).values({
        id, bucket: bucket.id, label: bucket.label,
        startOn: bucket.hawl?.startOn ?? bucket.closedOn,
        dueOn: bucket.closedOn,
        dueHijri: bucket.hawl?.startHijriText ?? '',
        anchorOn: bucket.anchorOn,
        base: corrected, due, nisab: src.nisab, basis: src.settings.basis,
        goldPerG: prices.goldPerG, silverPerG: prices.silverPerG,
        entries, note: input.note ?? null,
        confirmedAt: ctx.now.toISOString(),
      }).run();

      return noted(summary, adjustment
        ? [`Your figure differs from the ledger's by ${Math.round(adjustment.sign * adjustment.amount)}, recorded as its own line.`]
        : []);
    },
  }),

  command({
    name: 'zakat.reopen',
    context: 'giving',
    summary: 'Undo a confirmed year so it can be worked out again.',
    detail: 'The frozen figure goes and the pot returns to being worked out from what is held. Payments already booked against it are not deleted — they lose the year they paid, and have to be pointed at one again.',
    effect: 'irreversible',
    input: z.object({ yearId: z.string(), force: z.boolean().default(false) }),
    output: Outcome,
    handler: async ({ yearId, force }) => {
      const ctx = ctxOf();
      const row = ctx.db.select().from(t.zakatYears).where(eq(t.zakatYears.id, yearId)).get();
      if (!row) return refusal('not_found', 'There is no confirmed year by that name.');

      const payments = ctx.db.select().from(t.charity).all()
        .filter((c) => (c as { zakatYearId?: string | null }).zakatYearId === yearId);
      if (payments.length && !force) {
        return refusal('immutable',
          payments.length === 1
            ? '1 payment already discharges this year.'
            : `${payments.length} payments already discharge this year.`,
          'Call again with force true to unpick it — the payments stay on the record but stop counting against any year.');
      }

      return atomically(ctx, () => {
        for (const c of payments) {
          ctx.db.update(t.charity).set({ zakatYearId: null }).where(eq(t.charity.id, c.id)).run();
        }
        ctx.db.delete(t.zakatYears).where(eq(t.zakatYears.id, yearId)).run();
        return noted(
          `${row.label} for ${row.dueOn} is open again`,
          payments.length
            ? [payments.length === 1
                ? '1 payment no longer discharges any year.'
                : `${payments.length} payments no longer discharge any year.`]
            : [],
        );
      });
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
      })),
    })),
    handler: async ({ bucket, outstanding, limit }) => {
      const { db } = ctxOf();
      const given = db.select().from(t.charity).all();
      return db.select().from(t.zakatYears).orderBy(desc(t.zakatYears.dueOn)).limit(limit).all()
        .map((y) => {
          const payments = given
            .filter((c) => (c as { zakatYearId?: string | null }).zakatYearId === y.id)
            .map((c) => ({ id: c.id, date: c.date, egp: c.egp, causeId: c.categoryId, note: c.note }))
            .sort((a, b) => a.date.localeCompare(b.date));
          const paid = payments.reduce((s2, c) => s2 + c.egp, 0);
          return {
            id: y.id, bucket: y.bucket, label: y.label,
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
