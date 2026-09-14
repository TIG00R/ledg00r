import { z } from 'zod';
import { query } from '@ledger/contracts';
import { schema as t } from '@ledger/db';
import { toEgp } from '@ledger/engine';
import type { AppCtx } from '../context.js';
import { readMarket } from '../read.js';

/**
 * The dashboards.
 *
 * One shape answers all of them: a period, a subject, and totals grouped by where the money
 * went, with a series alongside so the shape over time is visible rather than a single
 * number. The grouping is done in SQL against an index built for exactly these three
 * questions — this month, this year, all time — so a dashboard is a handful of index reads
 * however long the log grows.
 */
const Period = z.enum(['month', 'year', 'all']);

export const dashboardCaps = (ctxOf: () => AppCtx) => [
  query({
    name: 'dashboard.read',
    context: 'dashboard',
    summary: 'Totals for one subject over one period, grouped by destination, with a series over time.',
    detail: 'Subjects are "expenses", "income" and "giving". Period is this month, this year, or everything. Amounts are in the ledger\'s base currency so they can be compared; the currencies they were actually in are listed alongside.',
    input: z.object({
      subject: z.enum(['expenses', 'income', 'giving']).default('expenses'),
      period: Period.default('month'),
      /** which month or year; defaults to the current one */
      at: z.string().regex(/^\d{4}(-\d{2})?$/).optional(),
    }),
    output: z.object({
      subject: z.string(), period: z.string(), label: z.string(),
      total: z.number(), count: z.number(),
      /** the same figure for the period before, so a total has something to be read against */
      previous: z.number(),
      groups: z.array(z.object({
        key: z.string(), name: z.string(), color: z.string().nullable(),
        icon: z.string().nullable(), amount: z.number(), count: z.number(), share: z.number(),
      })),
      series: z.array(z.object({ bucket: z.string(), amount: z.number(), count: z.number() })),
      currencies: z.array(z.object({ currency: z.string(), amount: z.number() })),
    }),
    handler: async (input) => {
      const ctx = ctxOf();
      const market = readMarket(ctx.db);
      const nowMonth = ctx.now.toISOString().slice(0, 7);
      const nowYear = nowMonth.slice(0, 4);

      const at = input.at ?? (input.period === 'year' ? nowYear : nowMonth);
      const prefix = input.period === 'all' ? '' : input.period === 'year' ? at.slice(0, 4) : at;
      const prev = input.period === 'month' ? monthBefore(at)
                 : input.period === 'year' ? String(Number(at.slice(0, 4)) - 1)
                 : '';

      const rows = read(ctx, input.subject, prefix, market);
      const before = prev ? read(ctx, input.subject, prev, market) : [];

      const total = rows.reduce((s, r) => s + r.egp, 0);
      const cats = new Map(ctx.db.select().from(t.categories).all().map((c) => [c.id, c]));
      const nodes = new Map(ctx.db.select().from(t.nodes).all().map((n) => [n.id, n]));
      const sources = new Map(ctx.db.select().from(t.incomeSources).all().map((s) => [s.id, s]));

      const byKey = new Map<string, { amount: number; count: number }>();
      const byCurrency = new Map<string, number>();
      const byBucket = new Map<string, { amount: number; count: number }>();
      for (const r of rows) {
        const g = byKey.get(r.key) ?? { amount: 0, count: 0 };
        byKey.set(r.key, { amount: g.amount + r.egp, count: g.count + 1 });
        byCurrency.set(r.currency, (byCurrency.get(r.currency) ?? 0) + r.amount);
        // months inside a year, years across all time — whichever the period is made of
        const bucket = input.period === 'all' ? r.date.slice(0, 4) : r.date.slice(0, 7);
        const b = byBucket.get(bucket) ?? { amount: 0, count: 0 };
        byBucket.set(bucket, { amount: b.amount + r.egp, count: b.count + 1 });
      }

      const name = (key: string) =>
        cats.get(key)?.name ?? nodes.get(key)?.name ?? sources.get(key)?.name ?? key;

      return {
        subject: input.subject,
        period: input.period,
        label: input.period === 'all' ? 'All time'
             : input.period === 'year' ? at.slice(0, 4)
             : new Date(`${at}-01T12:00:00`).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' }),
        total,
        count: rows.length,
        previous: before.reduce((s, r) => s + r.egp, 0),
        groups: [...byKey.entries()]
          .map(([key, g]) => ({
            key, name: name(key),
            color: cats.get(key)?.color ?? sources.get(key)?.color ?? null,
            icon: cats.get(key)?.icon ?? sources.get(key)?.icon ?? null,
            amount: g.amount, count: g.count,
            share: total ? g.amount / total : 0,
          }))
          .sort((a, b) => b.amount - a.amount),
        series: [...byBucket.entries()]
          .map(([bucket, v]) => ({ bucket, ...v }))
          .sort((a, b) => a.bucket.localeCompare(b.bucket)),
        currencies: [...byCurrency.entries()]
          .map(([currency, amount]) => ({ currency, amount }))
          .sort((a, b) => b.amount - a.amount),
      };
    },
  }),
];

interface Row { key: string; amount: number; currency: string; egp: number; date: string }

/**
 * One read per subject, filtered by a date prefix.
 *
 * `date LIKE '2026-09%'` is what the month and year indexes were built for, so this stays an
 * index scan rather than a table scan as the log grows.
 */
function read(ctx: AppCtx, subject: string, prefix: string, market: ReturnType<typeof readMarket>): Row[] {
  const like = prefix ? `${prefix}%` : '%';

  if (subject === 'expenses') {
    return (ctx.db.$raw.prepare(`
      SELECT category_id AS key, amount, currency, date FROM expenses WHERE date LIKE ?
    `).all(like) as Array<{ key: string; amount: number; currency: string; date: string }>)
      .map((r) => ({ ...r, egp: toEgp(r.amount, r.currency, market) }));
  }

  if (subject === 'giving') {
    return (ctx.db.$raw.prepare(`
      SELECT category_id AS key, egp AS amount, currency, date, is_zakat FROM charity WHERE date LIKE ?
    `).all(like) as Array<{ key: string; amount: number; currency: string; date: string }>)
      .map((r) => ({ ...r, egp: r.amount }));
  }

  // Income is not a log of its own — it is every movement of that kind, keyed by where it
  // came from, which is what makes a source's total add up to what actually landed.
  return (ctx.db.$raw.prepare(`
    SELECT COALESCE(l.from_node_id, 'unattributed') AS key,
           COALESCE(l.qty_to, l.qty_from, 0) AS amount,
           tx.date AS date,
           (SELECT currency FROM nodes WHERE id = l.to_node_id) AS currency
    FROM legs l JOIN transactions tx ON tx.id = l.transaction_id
    WHERE tx.kind = 'income' AND tx.date LIKE ?
  `).all(like) as Array<{ key: string; amount: number; currency: string | null; date: string }>)
    .map((r) => ({
      key: r.key, amount: r.amount, currency: r.currency ?? 'EGP', date: r.date,
      egp: toEgp(r.amount, r.currency ?? 'EGP', market),
    }));
}

function monthBefore(month: string): string {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(y!, m! - 2, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
