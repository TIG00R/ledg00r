import { z } from 'zod';
import { command, query, DateOnly, MovementKind, Outcome } from '@ledger/contracts';
import { schema as t, writeMovement, ledgerView, allBalances } from '@ledger/db';
import { validate } from '@ledger/domain';
import { desc, eq } from 'drizzle-orm';
import type { AppCtx } from '../context.js';
import { atomically, noted, post, refusal, reversalLegs, today, undoMovement } from './shared.js';
import { settleOwnership } from './holdings.js';

/**
 * Reading, correcting and undoing what was recorded.
 *
 * A movement is never edited in place and never deleted. Both would rewrite what already
 * happened, and a ledger whose past can change is a ledger whose figures cannot be trusted.
 *
 * Undoing writes the opposite movement, so the balance returns to where it was and the log
 * still says both things occurred. Correcting does the same and then writes the intended
 * movement in its place. Either way the correction is visible as one, which is the whole
 * reason the interface separates operating from editing.
 */
export const movementCaps = (ctxOf: () => AppCtx) => [
  query({
    name: 'movements.list',
    context: 'ledger',
    summary: 'The movement log, newest first, with what each one moved.',
    detail: 'Filter by account to see everything that touched it, or by kind for one sort of movement. A reversed movement says what reversed it.',
    input: z.object({
      accountId: z.string().optional(),
      kind: z.string().optional(),
      from: DateOnly.optional(), to: DateOnly.optional(),
      limit: z.number().int().min(1).max(500).default(100),
    }),
    output: z.array(z.object({
      id: z.string(), date: z.string(), kind: z.string(), note: z.string().nullable(),
      automatic: z.boolean(), reversedBy: z.string().nullable(), reverses: z.string().nullable(),
      legs: z.array(z.object({
        fromNodeId: z.string().nullable(), fromName: z.string().nullable(),
        toNodeId: z.string().nullable(), toName: z.string().nullable(),
        qtyFrom: z.number().nullable(), qtyTo: z.number().nullable(),
        rateApplied: z.number().nullable(), feeQty: z.number().nullable(),
        categoryId: z.string().nullable(),
      })),
    })),
    handler: async (input) => {
      const { db } = ctxOf();
      const names = new Map(db.select().from(t.nodes).all().map((n) => [n.id, n.name]));
      const legs = db.select().from(t.legs).all();
      const all = db.select().from(t.transactions).all();
      const reversedBy = new Map(all.filter((x) => x.correctsId).map((x) => [x.correctsId!, x.id]));

      return all
        .filter((tx) => !input.kind || tx.kind === input.kind)
        .filter((tx) => !input.from || tx.date >= input.from)
        .filter((tx) => !input.to || tx.date <= input.to)
        .filter((tx) => !input.accountId || legs.some((l) => l.transactionId === tx.id
          && (l.fromNodeId === input.accountId || l.toNodeId === input.accountId)))
        .sort((a, b) => (a.date === b.date ? b.seq - a.seq : b.date.localeCompare(a.date)))
        .slice(0, input.limit)
        .map((tx) => ({
          id: tx.id, date: tx.date, kind: tx.kind, note: tx.note,
          automatic: tx.automatic,
          reversedBy: reversedBy.get(tx.id) ?? null,
          reverses: tx.correctsId,
          legs: legs.filter((l) => l.transactionId === tx.id).sort((a, b) => a.seq - b.seq).map((l) => ({
            fromNodeId: l.fromNodeId, fromName: l.fromNodeId ? names.get(l.fromNodeId) ?? null : null,
            toNodeId: l.toNodeId, toName: l.toNodeId ? names.get(l.toNodeId) ?? null : null,
            qtyFrom: l.qtyFrom, qtyTo: l.qtyTo, rateApplied: l.rateApplied,
            feeQty: l.feeQty, categoryId: l.categoryId,
          })),
        }));
    },
  }),

  command({
    name: 'movement.undo',
    context: 'ledger',
    summary: 'Undo a movement by writing its opposite. The balance returns; the log keeps both.',
    detail: 'This is what "delete" means in a ledger. Nothing is removed — a movement that reverses it is written, so the figures come back to where they were and the record still says what happened and what was undone.',
    input: z.object({
      movementId: z.string(),
      note: z.string().max(300).optional(),
      dryRun: z.boolean().default(false),
    }),
    output: Outcome,
    handler: async (input) => {
      const ctx = ctxOf();
      const tx = ctx.db.select().from(t.transactions).where(eq(t.transactions.id, input.movementId)).get();
      if (!tx) return refusal('not_found', `${input.movementId} is not a movement in this ledger.`);

      const already = ctx.db.select().from(t.transactions).all().find((x) => x.correctsId === tx.id);
      if (already) {
        return refusal('duplicate', 'That movement has already been undone.',
                       `It was reversed by ${already.id}.`);
      }
      if (tx.correctsId) {
        return refusal('immutable', 'That movement is itself a reversal.',
                       'Undoing an undo would restore the thing it corrected — record it again instead.');
      }

      const legs = ctx.db.select().from(t.legs).where(eq(t.legs.transactionId, tx.id)).all();
      const flipped = reversalLegs(legs);

      try {
        const mv = validate({
          date: today(ctx), kind: 'correction',
          note: input.note ?? `Undoes ${tx.note ?? tx.kind} of ${tx.date}`,
          legs: flipped,
        }, ctx.ledger());

        if (input.dryRun) {
          return { ok: true as const, dryRun: true, kind: 'correction', date: today(ctx),
                   summary: `Would undo ${tx.kind} of ${tx.date}`, changes: [], warnings: [] };
        }
        const id = writeMovement(ctx.db, mv, { correctsId: tx.id, idempotencyKey: `undo:${tx.id}` });
        detachRecords(ctx, tx.id);
        return { ok: true as const, movementId: id, dryRun: false, kind: 'correction', date: today(ctx),
                 summary: `Undid ${tx.kind} of ${tx.date}`, changes: [], warnings: [] };
      } catch (e) {
        const err = e as { code?: any; message: string; remedy?: string };
        return refusal(err.code ?? 'unbalanced', err.message, err.remedy);
      }
    },
  }),

  command({
    name: 'movement.amend',
    context: 'ledger',
    summary: 'Correct a movement: what it moved, where it moved, when, and what it was called.',
    detail: 'The movement is not rewritten — it is reversed and the corrected one is posted in its place, so the balances follow the correction and the log still says what was first recorded and what replaced it. Anything left out keeps the value it had. If the corrected movement is refused, the reversal is taken back with it.',
    input: z.object({
      movementId: z.string(),
      date: DateOnly.optional(),
      kind: MovementKind.optional(),
      note: z.string().max(500).nullable().optional(),
      fromAccountId: z.string().nullable().optional(),
      toAccountId: z.string().nullable().optional(),
      amount: z.number().positive().optional(),
      rateApplied: z.number().positive().nullable().optional(),
      dryRun: z.boolean().default(false),
    }),
    output: Outcome,
    handler: async (input) => {
      const ctx = ctxOf();
      const tx = ctx.db.select().from(t.transactions).where(eq(t.transactions.id, input.movementId)).get();
      if (!tx) return refusal('not_found', `${input.movementId} is not a movement in this ledger.`);
      if (tx.correctsId) {
        return refusal('immutable', 'That movement is itself a correction.',
                       'Correct the movement it replaced, or record a new one.');
      }
      const already = ctx.db.select().from(t.transactions).all().some((x) => x.correctsId === tx.id);
      if (already) {
        return refusal('duplicate', 'That movement has already been undone.',
                       'Record the movement you meant instead of correcting one that no longer stands.');
      }

      const legs = ctx.db.select().from(t.legs).where(eq(t.legs.transactionId, tx.id))
        .all().sort((a, b) => a.seq - b.seq);
      const first = legs[0];
      if (!first) return refusal('not_found', 'That movement has no legs to correct.');
      if (legs.length > 1) {
        return refusal('immutable', 'That movement has more than one leg.',
                       'Undo it and record the corrected movement, so each leg is stated deliberately.');
      }

      // absent means unchanged; null means deliberately cleared, which only the open ends of a
      // movement allow — money leaving to nowhere named, or arriving from nowhere named
      const has = <K extends keyof typeof input>(k: K) => input[k] !== undefined;
      const fromNodeId = has('fromAccountId') ? input.fromAccountId ?? undefined : first.fromNodeId ?? undefined;
      const toNodeId = has('toAccountId') ? input.toAccountId ?? undefined : first.toNodeId ?? undefined;
      const qtyFrom = input.amount ?? first.qtyFrom ?? 0;
      const rateApplied = has('rateApplied') ? input.rateApplied ?? undefined : first.rateApplied ?? undefined;

      const draft = {
        date: input.date ?? tx.date,
        kind: input.kind ?? (tx.kind as MovementKind),
        note: has('note') ? input.note ?? undefined : tx.note ?? undefined,
        legs: [{
          fromNodeId, toNodeId, qtyFrom,
          rateApplied,
          feeQty: first.feeQty ?? undefined,
          feeNodeId: first.feeQty ? first.fromNodeId ?? undefined : undefined,
          categoryId: first.categoryId ?? undefined,
        }],
      } as Parameters<typeof post>[1];

      if (input.dryRun) return post(ctx, draft, `Would correct the ${tx.kind} of ${tx.date}`, { dryRun: true });

      // the reversal and the replacement are one act: a refusal takes both back
      return atomically(ctx, () => {
        undoMovement(ctx, tx.id);
        detachRecords(ctx, tx.id);
        return post(ctx, draft, `Corrected the ${tx.kind} of ${tx.date}`);
      });
    },
  }),

  command({
    name: 'movement.annotate',
    context: 'ledger',
    summary: 'Change the note on a movement. What it moved stays exactly as recorded.',
    detail: 'The only part of a movement that can be edited in place, because a note describes the record rather than being part of it.',
    input: z.object({ movementId: z.string(), note: z.string().max(500) }),
    output: Outcome,
    handler: async ({ movementId, note }) => {
      const { db } = ctxOf();
      const tx = db.select().from(t.transactions).where(eq(t.transactions.id, movementId)).get();
      if (!tx) return refusal('not_found', `${movementId} is not a movement in this ledger.`);
      db.update(t.transactions).set({ note }).where(eq(t.transactions.id, movementId)).run();
      return noted('Note changed');
    },
  }),
];

/**
 * A movement usually has a log row beside it — an expense, a lot, an order. Undoing the
 * movement has to take that row with it, or the screens would keep showing something the
 * balances no longer agree with.
 */
function detachRecords(ctx: AppCtx, movementId: string): void {
  ctx.db.delete(t.expenses).where(eq(t.expenses.movementId, movementId)).run();
  ctx.db.delete(t.charity).where(eq(t.charity.movementId, movementId)).run();
  ctx.db.delete(t.goldLots).where(eq(t.goldLots.movementId, movementId)).run();
  ctx.db.delete(t.orders).where(eq(t.orders.movementId, movementId)).run();

  // A payment being undone is a plan that is no longer finished, so whatever it bought goes
  // back to being paid for. Which properties are affected has to be read before the rows are
  // cleared, or there is nothing left to point at.
  const touched = ctx.db.select().from(t.installments)
    .where(eq(t.installments.movementId, movementId)).all().map((i) => i.propertyId);
  ctx.db.update(t.installments).set({ paidAt: null, movementId: null })
    .where(eq(t.installments.movementId, movementId)).run();
  for (const propertyId of new Set(touched)) settleOwnership(ctx.db, propertyId);
}

export { allBalances, ledgerView, desc };
