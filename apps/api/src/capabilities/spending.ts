import { z } from 'zod';
import { command, query, DateOnly, NodeId, CategoryId, Outcome } from '@ledger/contracts';
import { schema as t, periodTotals } from '@ledger/db';
import { and, desc, eq, gte, lte } from 'drizzle-orm';
import type { AppCtx } from '../context.js';
import { post, noted, refusal, today, newId, DryRun, undoMovement } from './shared.js';

/**
 * Spending.
 *
 * An expense is money leaving a named account for a destination, so it is a movement with a
 * category on its leg, plus a row in the log the Expenses screen reads. Both are written in
 * the same transaction; the log row is what makes a place and a note searchable, and the
 * movement is what makes the balance change.
 */
export const spendingCaps = (ctxOf: () => AppCtx) => [
  command({
    name: 'expense.record',
    context: 'spending',
    summary: 'Record money spent, against a destination, out of the account it came from.',
    detail: 'Every expense names the account it came from — that is what keeps the balances honest. The account may be left out, and then the destination\'s usual account answers for it, or the ledger\'s own default where the destination has none. Call destinations.list for the category ids and the usual account each one carries.',
    input: z.object({
      /** left out, the destination's usual account answers for it */
      accountId: NodeId.optional(),
      amount: z.number().positive(),
      currency: z.string().regex(/^[A-Z]{3}$/).optional(),
      destinationId: CategoryId,
      date: DateOnly.optional(),
      place: z.string().max(120).optional(),
      note: z.string().max(500).optional(),
    }).merge(DryRun),
    output: Outcome,
    handler: async (input) => {
      const ctx = ctxOf();
      const ledger = ctx.ledger();

      const cat = ctx.db.select().from(t.categories).where(eq(t.categories.id, input.destinationId)).get();
      if (!cat) return refusal('not_found', `${input.destinationId} is not a destination.`, 'Call destinations.list, or add one with destination.add.');

      /**
       * Which account it came out of.
       *
       * Said outright, or answered by the destination — groceries off the debit card, a
       * flight off the dollar account — and only then by the ledger's one default. The rule
       * lives here rather than in the screen that draws the form, so an expense recorded by
       * an agent lands in the same account as one typed in.
       */
      const accountId = input.accountId ?? cat.accountId ?? defaultAccount(ctx.db);
      if (!accountId) {
        return refusal('unknown_node', 'No account was named, and nothing answers for one.',
                       `Name one, give ${cat.name} a usual account with destination.update, or set the ledger's own under Settings.`);
      }
      const acct = ledger.node(accountId);
      if (!acct) return refusal('unknown_node', `${accountId} is not an account in this ledger.`, 'Call accounts.list for the ids.');

      const date = input.date ?? today(ctx);
      const currency = input.currency ?? acct.currency ?? 'EGP';
      const id = newId('exp');

      return post(ctx, {
        date, kind: 'expense', note: input.note,
        legs: [{ fromNodeId: accountId, qtyFrom: input.amount, categoryId: input.destinationId }],
      }, `${input.amount} ${currency} on ${cat.name}${input.place ? ` at ${input.place}` : ''}, out of ${acct.name}`,
      {
        dryRun: input.dryRun,
        index: [{ kind: 'expense', recordId: id, title: input.place ?? cat.name, body: input.note ?? '' }],
        after: (db, movementId) => {
          const rate = currency === 'EGP' ? 1 : rateFor(db, currency);
          db.insert(t.expenses).values({
            id, seq: nextSeq(db, 'expenses'), date, amount: input.amount, currency,
            egpAmount: input.amount * rate, rate, accountId,
            categoryId: input.destinationId, place: input.place ?? null,
            note: input.note ?? null, movementId,
          }).run();
        },
      });
    },
  }),

  query({
    name: 'expense.list',
    context: 'spending',
    summary: 'Expenses, newest first, filtered by destination, account or period.',
    input: z.object({
      destinationId: CategoryId.optional(),
      accountId: NodeId.optional(),
      from: DateOnly.optional(), to: DateOnly.optional(),
      limit: z.number().int().min(1).max(500).default(100),
    }),
    output: z.array(z.object({
      id: z.string(), date: z.string(), amount: z.number(), currency: z.string(),
      egpAmount: z.number(), accountId: z.string().nullable(), destinationId: z.string(),
      place: z.string().nullable(), note: z.string().nullable(),
    })),
    handler: async (input) => {
      const { db } = ctxOf();
      const where = [
        input.destinationId ? eq(t.expenses.categoryId, input.destinationId) : undefined,
        input.accountId ? eq(t.expenses.accountId, input.accountId) : undefined,
        input.from ? gte(t.expenses.date, input.from) : undefined,
        input.to ? lte(t.expenses.date, input.to) : undefined,
      ].filter(Boolean);
      return db.select().from(t.expenses)
        .where(where.length ? and(...(where as any)) : undefined)
        .orderBy(desc(t.expenses.date)).limit(input.limit).all()
        .map((e) => ({
          id: e.id, date: e.date, amount: e.amount, currency: e.currency,
          egpAmount: e.egpAmount, accountId: e.accountId, destinationId: e.categoryId,
          place: e.place, note: e.note,
        }));
    },
  }),

  query({
    name: 'expense.statistics',
    context: 'spending',
    summary: 'Totals per destination per month, read from the projection rather than aggregated.',
    detail: 'This is a handful of indexed rows however large the log grows, which is why the screens can show it without waiting.',
    input: z.object({
      from: z.string().regex(/^\d{4}-\d{2}$/).optional(),
      to: z.string().regex(/^\d{4}-\d{2}$/).optional(),
      context: z.enum(['expense', 'expense_account', 'giving']).default('expense'),
    }),
    output: z.array(z.object({
      bucket: z.string(), key: z.string(), name: z.string(),
      currency: z.string(), amount: z.number(), count: z.number(),
    })),
    handler: async (input) => {
      const { db } = ctxOf();
      const names = new Map<string, string>();
      for (const c of db.select().from(t.categories).all()) names.set(c.id, c.name);
      for (const n of db.select().from(t.nodes).all()) names.set(n.id, n.name);
      return periodTotals(db, input.context, input.from, input.to)
        .map((r) => ({ ...r, name: names.get(r.key) ?? r.key }));
    },
  }),

  command({
    name: 'expense.correct',
    context: 'spending',
    summary: 'Correct a recorded expense — the amount, the account, where it went, the date, the note.',
    detail: 'The movement behind it is reversed and a new one written, so the balances follow and the log says what was corrected rather than quietly showing a different number.',
    input: z.object({
      expenseId: z.string(),
      accountId: NodeId.optional(),
      amount: z.number().positive().optional(),
      currency: z.string().regex(/^[A-Z]{3}$/).optional(),
      destinationId: CategoryId.optional(),
      date: DateOnly.optional(),
      place: z.string().max(120).optional(),
      note: z.string().max(500).optional(),
    }),
    output: Outcome,
    handler: async (input) => {
      const ctx = ctxOf();
      const row = ctx.db.select().from(t.expenses).where(eq(t.expenses.id, input.expenseId)).get();
      if (!row) return refusal('not_found', 'There is no such expense.');

      const next = {
        accountId: input.accountId ?? row.accountId,
        amount: input.amount ?? row.amount,
        currency: input.currency ?? row.currency,
        categoryId: input.destinationId ?? row.categoryId,
        date: input.date ?? row.date,
        place: input.place ?? row.place,
        note: input.note ?? row.note,
      };
      if (!next.accountId) return refusal('unknown_node', 'That expense names no account to come out of.');

      // Reverse what was recorded, then record what was meant. Both stay in the log.
      undoMovement(ctx, row.movementId);
      ctx.db.delete(t.expenses).where(eq(t.expenses.id, input.expenseId)).run();

      const rate = next.currency === 'EGP' ? 1 : rateFor(ctx.db, next.currency);
      return post(ctx, {
        date: next.date, kind: 'expense', note: next.note ?? undefined,
        legs: [{ fromNodeId: next.accountId, qtyFrom: next.amount, categoryId: next.categoryId }],
      }, `corrected to ${next.amount} ${next.currency}`,
      {
        index: [{ kind: 'expense', recordId: input.expenseId,
                  title: next.place ?? '', body: next.note ?? '' }],
        after: (db, movementId) => {
          db.insert(t.expenses).values({
            id: input.expenseId, seq: row.seq, date: next.date, amount: next.amount,
            currency: next.currency, egpAmount: next.amount * rate, rate,
            accountId: next.accountId, categoryId: next.categoryId,
            place: next.place, note: next.note, movementId,
          }).run();
        },
      });
    },
  }),

  command({
    name: 'expense.remove',
    context: 'spending',
    summary: 'Remove a recorded expense, reversing the movement behind it.',
    detail: 'The money comes back to the account it left, and the log keeps both the spending and its reversal — nothing is erased.',
    effect: 'irreversible',
    input: z.object({ expenseId: z.string() }),
    output: Outcome,
    handler: async ({ expenseId }) => {
      const ctx = ctxOf();
      const row = ctx.db.select().from(t.expenses).where(eq(t.expenses.id, expenseId)).get();
      if (!row) return refusal('not_found', 'There is no such expense.');
      undoMovement(ctx, row.movementId);
      ctx.db.delete(t.expenses).where(eq(t.expenses.id, expenseId)).run();
      return noted(`${row.place || 'That expense'} removed, and the money is back in the account`);
    },
  }),

  command({
    name: 'destination.add',
    context: 'spending',
    summary: 'Add a destination for spending, in your own words, with its own mark and colour.',
    detail: 'Destinations are not a fixed list. What you spend on is yours to name.',
    input: z.object({
      name: z.string().min(1).max(60),
      color: z.string().regex(/^#[0-9a-f]{6}$/i).default('#8A8578'),
      icon: z.string().max(32).optional(),
      /** which account this kind of spending usually comes out of; the ledger's default otherwise */
      accountId: NodeId.optional(),
      note: z.string().max(200).optional(),
      domain: z.enum(['expense', 'charity', 'income']).default('expense'),
    }),
    output: z.object({ id: z.string(), summary: z.string() }),
    handler: async (input) => {
      const { db } = ctxOf();
      const id = newId(input.domain === 'charity' ? 'cha' : 'out');
      db.insert(t.categories).values({
        id, domain: input.domain, name: input.name, color: input.color,
        icon: input.icon ?? null, accountId: input.accountId ?? null,
        note: input.note ?? null, archived: false,
      }).run();
      return { id, summary: `${input.name} added` };
    },
  }),

  query({
    name: 'destinations.list',
    context: 'spending',
    summary: 'The destinations spending and giving can be recorded against.',
    input: z.object({ domain: z.enum(['expense', 'charity', 'income']).optional() }),
    output: z.array(z.object({
      id: z.string(), domain: z.string(), name: z.string(),
      color: z.string(), icon: z.string().nullable(),
      /** the account this kind of spending usually comes out of, where one is set */
      accountId: z.string().nullable(), archived: z.boolean(),
    })),
    handler: async ({ domain }) => {
      const { db } = ctxOf();
      return db.select().from(t.categories).all()
        .filter((c) => !domain || c.domain === domain)
        .map((c) => ({ id: c.id, domain: c.domain, name: c.name, color: c.color, icon: c.icon,
                       accountId: c.accountId ?? null, archived: c.archived }));
    },
  }),

  command({
    name: 'destination.update',
    context: 'spending',
    summary: 'Rename a destination, or change its mark, colour, usual account or archived state.',
    detail: 'The usual account is a default for what comes next and nothing more — every expense already recorded keeps the account it actually came out of. Pass an empty string to take the default away again, leaving the ledger\'s own.',
    input: z.object({
      destinationId: CategoryId,
      name: z.string().min(1).max(60).optional(),
      color: z.string().regex(/^#[0-9a-f]{6}$/i).optional(),
      icon: z.string().max(32).optional(),
      /** '' clears it, so the ledger's own default applies again */
      accountId: z.union([NodeId, z.literal('')]).optional(),
      archived: z.boolean().optional(),
    }),
    output: Outcome,
    handler: async ({ destinationId, ...patch }) => {
      const { db } = ctxOf();
      const cat = db.select().from(t.categories).where(eq(t.categories.id, destinationId)).get();
      if (!cat) return refusal('not_found', `${destinationId} is not a destination.`);
      const clean = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
      // an empty account is the way to say "no usual account", which is null and not ''
      if (clean.accountId === '') clean.accountId = null as unknown as string;
      if (Object.keys(clean).length) db.update(t.categories).set(clean).where(eq(t.categories.id, destinationId)).run();
      return noted(`${cat.name} updated`);
    },
  }),

  command({
    name: 'destination.remove',
    context: 'spending',
    summary: 'Delete a destination nothing has been recorded against. One that has been used is archived instead.',
    detail: 'A destination with spending or giving behind it cannot be deleted — those records name it, and a log pointing at a destination that no longer exists says less than it did. Archiving takes it out of the pickers and leaves every record readable.',
    effect: 'irreversible',
    input: z.object({ destinationId: CategoryId }),
    output: Outcome,
    handler: async ({ destinationId }) => {
      const { db } = ctxOf();
      const cat = db.select().from(t.categories).where(eq(t.categories.id, destinationId)).get();
      if (!cat) return refusal('not_found', `${destinationId} is not a destination.`);

      const used = db.select().from(t.expenses).all().filter((e) => e.categoryId === destinationId).length
        + db.select().from(t.charity).all().filter((c) => c.categoryId === destinationId).length
        + db.select().from(t.legs).all().filter((l) => l.categoryId === destinationId).length;
      if (used > 0) {
        return refusal('immutable',
          used === 1 ? `1 record names ${cat.name}.` : `${used} records name ${cat.name}.`,
          'Archive it instead — it leaves the pickers and every record that names it stays readable.');
      }

      // A ceiling over a destination that is gone covers nothing, so the membership goes too.
      db.delete(t.budgetMembers).where(eq(t.budgetMembers.categoryId, destinationId)).run();
      db.delete(t.categories).where(eq(t.categories.id, destinationId)).run();
      return noted(`${cat.name} deleted`);
    },
  }),
];

/**
 * The ledger's own default account — the last answer to "out of what", after the expense
 * itself and the destination it points at. Empty on a ledger where nobody has chosen one.
 */
function defaultAccount(db: any): string | null {
  const settings = db.$raw.prepare("SELECT value FROM preferences WHERE key = 'settings'").get() as
    { value: string } | undefined;
  if (!settings) return null;
  try {
    const parsed = JSON.parse(settings.value) as { burnAccountId?: string };
    return parsed.burnAccountId || null;
  } catch { return null; }
}

/** The seq columns exist so the original import order survives; keep filling them. */
export function nextSeq(db: any, table: string): number {
  const row = db.$raw.prepare(`SELECT COALESCE(MAX(seq), 0) AS s FROM ${table}`).get() as { s: number };
  return row.s + 1;
}

/** The rate to EGP, from the latest tick, falling back to what the ledger last knew. */
export function rateFor(db: any, currency: string): number {
  const row = db.$raw.prepare(
    'SELECT value FROM market_ticks WHERE key = ? ORDER BY at DESC LIMIT 1',
  ).get(`${currency}_EGP`) as { value: number } | undefined;
  return row?.value ?? 1;
}
