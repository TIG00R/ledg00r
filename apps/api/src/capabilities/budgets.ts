import { z } from 'zod';
import { command, query, CategoryId, Outcome } from '@ledger/contracts';
import { schema as t } from '@ledger/db';
import { and, eq, gte, lte, inArray } from 'drizzle-orm';
import type { AppCtx } from '../context.js';
import { refusal, noted, today, newId } from './shared.js';
import { readMarket } from '../read.js';
import { toEgp } from '@ledger/engine';

/**
 * Budgets, as pools.
 *
 * A budget is a ceiling over a period and the destinations it covers. A ceiling over one
 * destination is a pool with one member, which is why there is no second, simpler kind of
 * budget: "Groceries, 4,000 a month" and "Food, 9,000 a month over groceries and eating out"
 * are the same object with one member or two. A destination may belong to more than one pool
 * — groceries inside both Food and Household — and nothing here hides that, because a
 * ceiling that silently ignored a second claim on the same spending would be lying about one
 * of them.
 *
 * The ceiling carries the currency it was set in. A ceiling is a decision made in a currency,
 * not a figure to be restated every time the display currency changes; what is spent against
 * it is converted to that currency when the two are compared, at the rate the ledger holds.
 */

export const Period = z.enum(['monthly', 'quarterly', 'annual']);
export type PeriodName = z.infer<typeof Period>;

export const budgetCaps = (ctxOf: () => AppCtx) => [
  command({
    name: 'budget.add',
    context: 'budgets',
    summary: 'Set a ceiling on spending over a period, covering one destination or several.',
    detail: 'Several destinations under one ceiling is a pool: what they spend between them is counted against one figure. One destination is the same thing with one member. The ceiling is in the currency you set it in; spending in other currencies is converted to it when the two are compared.',
    input: z.object({
      name: z.string().min(1).max(60),
      amount: z.number().positive(),
      currency: z.string().regex(/^[A-Z]{3}$/).default('EGP'),
      period: Period.default('monthly'),
      destinationIds: z.array(CategoryId).min(1),
      color: z.string().regex(/^#[0-9a-f]{6}$/i).default('#8A8578'),
      icon: z.string().max(32).optional(),
      /**
       * The date the periods are counted from.
       *
       * Which day a month turns over, and which month a year does. Without it a quarterly
       * ceiling has no answer to "which quarter" — and a financial year that starts in July
       * is not the calendar's.
       */
      anchor: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      /** how close to the ceiling is close enough to be warned, as a fraction of it */
      warnAt: z.number().min(0).max(1).default(0.8),
      note: z.string().max(200).optional(),
    }),
    output: z.object({ id: z.string(), summary: z.string() }),
    handler: async (input) => {
      const ctx = ctxOf();
      const id = newId('bud');
      const anchor = input.anchor ?? today(ctx);
      ctx.db.insert(t.budgets).values({
        id, name: input.name, color: input.color, icon: input.icon ?? null,
        period: input.period, amount: input.amount, currency: input.currency,
        anchor, warnAt: input.warnAt, note: input.note ?? null,
        archived: false, createdAt: new Date().toISOString(),
      }).run();
      for (const categoryId of new Set(input.destinationIds)) {
        ctx.db.insert(t.budgetMembers).values({ budgetId: id, categoryId }).run();
      }
      return { id, summary: `${input.name}: ${input.amount} ${input.currency} ${input.period}` };
    },
  }),

  command({
    name: 'budget.update',
    context: 'budgets',
    summary: 'Change a ceiling, its period, what it covers, or its name, mark and colour.',
    detail: 'Giving destinationIds replaces the pool\'s membership outright, so a pool is described rather than patched a destination at a time.',
    input: z.object({
      budgetId: z.string(),
      name: z.string().min(1).max(60).optional(),
      amount: z.number().positive().optional(),
      currency: z.string().regex(/^[A-Z]{3}$/).optional(),
      period: Period.optional(),
      destinationIds: z.array(CategoryId).min(1).optional(),
      color: z.string().regex(/^#[0-9a-f]{6}$/i).optional(),
      icon: z.string().max(32).optional(),
      anchor: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      warnAt: z.number().min(0).max(1).optional(),
      note: z.string().max(200).optional(),
      archived: z.boolean().optional(),
    }),
    output: Outcome,
    handler: async ({ budgetId, destinationIds, ...patch }) => {
      const { db } = ctxOf();
      const row = db.select().from(t.budgets).where(eq(t.budgets.id, budgetId)).get();
      if (!row) return refusal('not_found', `${budgetId} is not a budget.`);
      const clean = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
      if (Object.keys(clean).length) {
        db.update(t.budgets).set(clean as any).where(eq(t.budgets.id, budgetId)).run();
      }
      if (destinationIds) {
        db.delete(t.budgetMembers).where(eq(t.budgetMembers.budgetId, budgetId)).run();
        for (const categoryId of new Set(destinationIds)) {
          db.insert(t.budgetMembers).values({ budgetId, categoryId }).run();
        }
      }
      return noted(`${row.name} updated`);
    },
  }),

  command({
    name: 'budget.remove',
    context: 'budgets',
    summary: 'Remove a budget. Nothing that was spent is touched.',
    detail: 'A ceiling is a thing you decided, not a record of anything, so removing one erases no history — the expenses it watched stay exactly as they were.',
    effect: 'irreversible',
    input: z.object({ budgetId: z.string() }),
    output: Outcome,
    handler: async ({ budgetId }) => {
      const { db } = ctxOf();
      const row = db.select().from(t.budgets).where(eq(t.budgets.id, budgetId)).get();
      if (!row) return refusal('not_found', `${budgetId} is not a budget.`);
      db.delete(t.budgetMembers).where(eq(t.budgetMembers.budgetId, budgetId)).run();
      db.delete(t.budgets).where(eq(t.budgets.id, budgetId)).run();
      return noted(`${row.name} removed; nothing it watched was touched`);
    },
  }),

  query({
    name: 'budgets.list',
    context: 'budgets',
    summary: 'Every budget, with what it covers and how the period it is in is going.',
    detail: 'For each pool: the ceiling, the period it runs on, the days left in it, what has been spent against it so far, and the same broken down by destination. Amounts are in the budget\'s own currency.',
    input: z.object({
      includeArchived: z.boolean().default(false),
      /** which period to report; the one containing today when it is not said */
      at: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    }),
    output: z.array(z.object({
      id: z.string(), name: z.string(), color: z.string(), icon: z.string().nullable(),
      period: z.string(), amount: z.number(), currency: z.string(),
      anchor: z.string(), warnAt: z.number(), note: z.string().nullable(),
      archived: z.boolean(),
      /** the period being reported, as dates you can put on a screen */
      from: z.string(), to: z.string(), daysLeft: z.number(),
      spent: z.number(), remaining: z.number(), share: z.number(),
      /** 'within', 'close' once past warnAt, 'over' once past the ceiling */
      standing: z.enum(['within', 'close', 'over']),
      members: z.array(z.object({
        id: z.string(), name: z.string(), color: z.string(), icon: z.string().nullable(),
        spent: z.number(), count: z.number(),
      })),
    })),
    handler: async (input) => {
      const ctx = ctxOf();
      const on = input.at ?? today(ctx);
      return readBudgets(ctx, on).filter((b) => input.includeArchived || !b.archived);
    },
  }),

  query({
    name: 'budget.series',
    context: 'budgets',
    summary: 'Spending over time, one line per destination, for the budget chart.',
    detail: 'One point per bucket per destination — months across a year, years across all time. Each point carries the total converted into the currency asked for and the amounts as they were actually recorded, so a chart can show both. Destinations with nothing in the window are left out.',
    input: z.object({
      span: z.enum(['year', 'all']).default('year'),
      /** which year, when the span is a year; this one when it is not said */
      year: z.string().regex(/^\d{4}$/).optional(),
      /** what to convert the totals into; the ledger's base when it is not said */
      currency: z.string().regex(/^[A-Z]{3}$/).default('EGP'),
      /** only these destinations, where the chart is showing one pool */
      destinationIds: z.array(CategoryId).optional(),
    }),
    output: z.object({
      span: z.string(), currency: z.string(),
      /** every bucket in the window, in order, including the empty ones */
      buckets: z.array(z.string()),
      lines: z.array(z.object({
        id: z.string(), name: z.string(), color: z.string(), icon: z.string().nullable(),
        total: z.number(),
        points: z.array(z.object({
          bucket: z.string(), amount: z.number(), count: z.number(),
          /** what was recorded, in the currencies it was recorded in */
          native: z.array(z.object({ currency: z.string(), amount: z.number() })),
        })),
      })),
      /** the ceilings that apply, drawn as rules across the chart */
      ceilings: z.array(z.object({
        id: z.string(), name: z.string(), color: z.string(),
        /** the ceiling restated per bucket, so a monthly ceiling reads against a monthly bar */
        perBucket: z.number(), destinationIds: z.array(z.string()),
      })),
    }),
    handler: async (input) => {
      const ctx = ctxOf();
      const market = readMarket(ctx.db);
      const into = (amount: number, currency: string) =>
        fromEgpAt(toEgp(amount, currency, market), input.currency, market);

      const cats = ctx.db.select().from(t.categories).all()
        .filter((c) => c.domain === 'expense');
      const wanted = input.destinationIds?.length ? new Set<string>(input.destinationIds) : null;

      const year = input.year ?? String(ctx.now.getFullYear());
      const rows = ctx.db.select().from(t.expenses).all()
        .filter((e) => (input.span === 'all' ? true : e.date.slice(0, 4) === year))
        .filter((e) => !wanted || wanted.has(e.categoryId));

      // months inside a year, years across all time — whichever the span is made of
      const bucketOfDate = (d: string) => (input.span === 'all' ? d.slice(0, 4) : d.slice(0, 7));
      const buckets = input.span === 'all'
        ? [...new Set(rows.map((e) => bucketOfDate(e.date)))].sort()
        : Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, '0')}`);

      const byCat = new Map<string, Map<string, { amount: number; count: number; native: Map<string, number> }>>();
      for (const e of rows) {
        const line = byCat.get(e.categoryId) ?? new Map();
        byCat.set(e.categoryId, line);
        const b = bucketOfDate(e.date);
        const point = line.get(b) ?? { amount: 0, count: 0, native: new Map<string, number>() };
        point.amount += into(e.amount, e.currency);
        point.count += 1;
        point.native.set(e.currency, (point.native.get(e.currency) ?? 0) + e.amount);
        line.set(b, point);
      }

      const lines = [...byCat.entries()].map(([id, points]) => {
        const cat = cats.find((c) => c.id === id);
        return {
          id, name: cat?.name ?? id, color: cat?.color ?? '#8A8578', icon: cat?.icon ?? null,
          total: [...points.values()].reduce((s, p) => s + p.amount, 0),
          points: buckets.filter((b) => points.has(b)).map((b) => {
            const p = points.get(b)!;
            return { bucket: b, amount: p.amount, count: p.count,
                     native: [...p.native.entries()].map(([currency, amount]) => ({ currency, amount })) };
          }),
        };
      }).sort((a, b) => b.total - a.total);

      const members = ctx.db.select().from(t.budgetMembers).all();
      const ceilings = ctx.db.select().from(t.budgets).all()
        .filter((b) => !b.archived)
        .map((b) => {
          const ids = members.filter((m) => m.budgetId === b.id).map((m) => m.categoryId);
          const perYear = b.period === 'monthly' ? b.amount * 12
                        : b.period === 'quarterly' ? b.amount * 4 : b.amount;
          return {
            id: b.id, name: b.name, color: b.color, destinationIds: ids,
            // the ceiling as the bucket reads it: a month of a monthly ceiling, a year of it
            // across all time. Drawing a monthly figure across a yearly bar says nothing.
            perBucket: into(input.span === 'all' ? perYear : perYear / 12, b.currency),
          };
        })
        .filter((c) => !wanted || c.destinationIds.some((id) => wanted.has(id)));

      return { span: input.span, currency: input.currency, buckets, lines, ceilings };
    },
  }),
];

/**
 * The period a budget is in on a given day, as the two dates that bound it.
 *
 * Counted from the pool's anchor rather than from the calendar, so a ceiling set on the 25th
 * runs the 25th to the 24th, and a financial year that starts in July is not made to start in
 * January. Exported because the reminder engine asks the same question.
 */
export function periodOf(period: PeriodName, anchor: string, on: string): { from: string; to: string } {
  const a = new Date(`${anchor}T12:00:00`);
  const d = new Date(`${on}T12:00:00`);
  const day = a.getDate();
  const iso = (x: Date) => x.toISOString().slice(0, 10);

  if (period === 'monthly') {
    const from = new Date(d.getFullYear(), d.getMonth(), day, 12);
    if (from > d) from.setMonth(from.getMonth() - 1);
    const to = new Date(from); to.setMonth(to.getMonth() + 1); to.setDate(to.getDate() - 1);
    return { from: iso(from), to: iso(to) };
  }
  if (period === 'quarterly') {
    // counted in whole quarters from the anchor, forwards or back, so every quarter since
    // the pool was made lines up with the one it was made in
    const months = (d.getFullYear() - a.getFullYear()) * 12 + (d.getMonth() - a.getMonth());
    const steps = Math.floor((months - (d.getDate() < day ? 1 : 0)) / 3);
    const from = new Date(a.getFullYear(), a.getMonth() + steps * 3, day, 12);
    const to = new Date(from); to.setMonth(to.getMonth() + 3); to.setDate(to.getDate() - 1);
    return { from: iso(from), to: iso(to) };
  }
  const from = new Date(d.getFullYear(), a.getMonth(), day, 12);
  if (from > d) from.setFullYear(from.getFullYear() - 1);
  const to = new Date(from); to.setFullYear(to.getFullYear() + 1); to.setDate(to.getDate() - 1);
  return { from: iso(from), to: iso(to) };
}

export interface BudgetReading {
  id: string; name: string; color: string; icon: string | null;
  period: string; amount: number; currency: string; anchor: string; warnAt: number;
  note: string | null; archived: boolean;
  from: string; to: string; daysLeft: number;
  spent: number; remaining: number; share: number;
  standing: 'within' | 'close' | 'over';
  members: Array<{ id: string; name: string; color: string; icon: string | null;
                   spent: number; count: number }>;
}

/**
 * Every pool, and how the period it is in is going.
 *
 * One read of the expenses per pool, filtered by the destinations it covers and the dates of
 * the period it is in. Expenses are converted into the pool's own currency, because that is
 * the currency the ceiling was decided in.
 */
export function readBudgets(ctx: AppCtx, on: string): BudgetReading[] {
  const market = readMarket(ctx.db);
  const cats = new Map(ctx.db.select().from(t.categories).all().map((c) => [c.id, c]));
  const members = ctx.db.select().from(t.budgetMembers).all();

  return ctx.db.select().from(t.budgets).all().map((b) => {
    const ids = members.filter((m) => m.budgetId === b.id).map((m) => m.categoryId);
    const { from, to } = periodOf(b.period as PeriodName, b.anchor, on);
    const rows = ids.length
      ? ctx.db.select().from(t.expenses)
          .where(and(inArray(t.expenses.categoryId, ids as string[]),
                     gte(t.expenses.date, from), lte(t.expenses.date, to)))
          .all()
      : [];

    const into = (amount: number, currency: string) =>
      fromEgpAt(toEgp(amount, currency, market), b.currency, market);

    const byCat = new Map<string, { spent: number; count: number }>();
    let spent = 0;
    for (const e of rows) {
      const value = into(e.amount, e.currency);
      spent += value;
      const g = byCat.get(e.categoryId) ?? { spent: 0, count: 0 };
      byCat.set(e.categoryId, { spent: g.spent + value, count: g.count + 1 });
    }

    const share = b.amount > 0 ? spent / b.amount : 0;
    const days = Math.max(0, Math.round(
      (new Date(`${to}T23:59:59`).getTime() - new Date(`${on}T12:00:00`).getTime()) / 86_400_000));

    return {
      id: b.id, name: b.name, color: b.color, icon: b.icon,
      period: b.period, amount: b.amount, currency: b.currency,
      anchor: b.anchor, warnAt: b.warnAt, note: b.note, archived: b.archived,
      from, to, daysLeft: days,
      spent, remaining: b.amount - spent, share,
      standing: share >= 1 ? 'over' : share >= b.warnAt ? 'close' : 'within',
      members: ids.map((id) => ({
        id, name: cats.get(id)?.name ?? id, color: cats.get(id)?.color ?? '#8A8578',
        icon: cats.get(id)?.icon ?? null,
        spent: byCat.get(id)?.spent ?? 0, count: byCat.get(id)?.count ?? 0,
      })).sort((x, y) => y.spent - x.spent),
    };
  });
}

/** EGP out, the asked-for currency in. The engine converts one way; this is the other. */
function fromEgpAt(egp: number, currency: string, market: ReturnType<typeof readMarket>): number {
  if (currency === 'EGP') return egp;
  const rate = market.fxRates?.[currency] ?? (currency === 'USD' ? market.usdEgp : 0);
  return rate > 0 ? egp / rate : egp;
}
