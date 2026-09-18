import { z } from 'zod';
import { command, query, Outcome } from '@ledger/contracts';
import { schema as t } from '@ledger/db';
import { eq } from 'drizzle-orm';
import type { AppCtx } from '../context.js';
import { refusal, noted, today } from './shared.js';

/**
 * A day, closed.
 *
 * `portfolio.overview` answers what things are worth right now, and the answer moves every
 * time a price does — which is right for "where do I stand today" and wrong for a timeline,
 * where last March has to go on reading what it read in March. A statement is the frozen half
 * of that: one row a day, written once by the scheduler and nothing else, and left alone until
 * a person deliberately corrects it, the same reading a confirmed zakat year already gets.
 */

const Allocation = z.array(z.object({ label: z.string(), amount: z.number(), share: z.number() }));

const StatementRow = z.object({
  id: z.string(), date: z.string(), month: z.string(), currency: z.string(),
  netWorth: z.number(), allocation: Allocation,
  source: z.enum(['auto', 'manual']), note: z.string().nullable(),
  createdAt: z.string(), updatedAt: z.string().nullable(),
});

export const statementCaps = (ctxOf: () => AppCtx) => [
  query({
    name: 'wealth.statement.list',
    context: 'overview',
    summary: 'Every daily statement saved, oldest first.',
    detail: 'The raw rows behind the timeline, one a day. Use wealth.statement.series for a chart already grouped by month or year.',
    input: z.object({}),
    output: z.array(StatementRow),
    handler: async () => {
      const { db } = ctxOf();
      return db.select().from(t.wealthStatements).all()
        .sort((a, b) => a.date.localeCompare(b.date))
        .map((s) => ({ ...s, allocation: s.allocation as z.infer<typeof Allocation> }));
    },
  }),

  query({
    name: 'wealth.statement.series',
    context: 'overview',
    summary: 'The timeline, grouped the way a chart wants it: by day this month, by month this year, or by year over all time.',
    detail: 'Net worth is a level, not a flow, so a bucket reports the last day recorded inside it rather than a sum — the way a balance is read, not the way spending is added up.',
    input: z.object({ span: z.enum(['month', 'year', 'all']).default('month') }),
    output: z.object({
      span: z.enum(['month', 'year', 'all']),
      points: z.array(z.object({
        key: z.string(), date: z.string(), netWorth: z.number(),
        currency: z.string(), source: z.enum(['auto', 'manual']),
      })),
    }),
    handler: async ({ span }) => {
      const ctx = ctxOf();
      const all = ctx.db.select().from(t.wealthStatements).all()
        .sort((a, b) => a.date.localeCompare(b.date));
      const todayIso = today(ctx);

      if (span === 'month') {
        const prefix = todayIso.slice(0, 7);
        return {
          span,
          points: all.filter((r) => r.month === prefix).map((r) => ({
            key: r.date, date: r.date, netWorth: r.netWorth,
            currency: r.currency, source: r.source,
          })),
        };
      }

      // year and all both bucket and keep the last day recorded in each bucket — a net worth
      // read partway through a month or a year means "as it stood then", not an average of it.
      const rows = span === 'year' ? all.filter((r) => r.date.slice(0, 4) === todayIso.slice(0, 4)) : all;
      const bucketOf = (r: (typeof rows)[number]) => (span === 'year' ? r.month : r.date.slice(0, 4));
      const last = new Map<string, (typeof rows)[number]>();
      for (const r of rows) last.set(bucketOf(r), r);

      return {
        span,
        points: [...last.entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, r]) => ({
            key, date: r.date, netWorth: r.netWorth, currency: r.currency, source: r.source,
          })),
      };
    },
  }),

  command({
    name: 'wealth.statement.update',
    context: 'overview',
    summary: 'Correct a saved statement\'s figure or note.',
    detail: 'Once a figure is typed over the one the scheduler worked out, the statement is marked manual — it is a correction, kept apart from what would be recomputed if it were asked for again.',
    input: z.object({
      id: z.string(),
      netWorth: z.number().optional(),
      note: z.string().max(300).nullable().optional(),
    }),
    output: Outcome,
    handler: async ({ id, netWorth, note }) => {
      const ctx = ctxOf();
      const row = ctx.db.select().from(t.wealthStatements).where(eq(t.wealthStatements.id, id)).get();
      if (!row) return refusal('not_found', `${id} is not a saved statement.`);

      const patch: Record<string, unknown> = { updatedAt: ctx.now.toISOString() };
      if (netWorth !== undefined) { patch.netWorth = netWorth; patch.source = 'manual'; }
      if (note !== undefined) patch.note = note;
      ctx.db.update(t.wealthStatements).set(patch).where(eq(t.wealthStatements.id, id)).run();
      return noted(`${row.date} updated`);
    },
  }),

  command({
    name: 'wealth.statement.remove',
    context: 'overview',
    summary: 'Remove a saved statement.',
    detail: 'The timeline loses that day\'s point. Nothing else about the ledger is touched — a statement is a reading, not a record of anything that happened. Removing today\'s does not stop the scheduler writing another for today; it only ever refuses to write a second one for a day that already has one.',
    effect: 'irreversible',
    input: z.object({ id: z.string() }),
    output: Outcome,
    handler: async ({ id }) => {
      const { db } = ctxOf();
      const row = db.select().from(t.wealthStatements).where(eq(t.wealthStatements.id, id)).get();
      if (!row) return refusal('not_found', `${id} is not a saved statement.`);
      db.delete(t.wealthStatements).where(eq(t.wealthStatements.id, id)).run();
      return noted(`${row.date} removed`);
    },
  }),
];
