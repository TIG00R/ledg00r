import { z } from 'zod';
import { DomainError, validate, type MovementDraft } from '@ledger/domain';
import { writeMovementDetailed, changesFor, schema as t, type Db } from '@ledger/db';
import { eq } from 'drizzle-orm';
import type { Receipt, Refusal } from '@ledger/contracts';
import type { AppCtx } from '../context.js';

/**
 * The three things every write does.
 *
 * Validate against the domain, work out what changes, then either write it or describe what
 * would have been written. Sharing this is what guarantees the dry run and the real call
 * cannot drift apart — there is one path, and `dryRun` decides only whether it stops before
 * the last step.
 */
export function post(
  ctx: AppCtx,
  draft: MovementDraft,
  summary: string,
  opts: { dryRun?: boolean; index?: Array<{ kind: any; recordId?: string; title: string; body: string }>;
          after?: (db: Db, movementId: string) => void; warnings?: string[] } = {},
): Receipt | Refusal {
  try {
    const mv = validate(draft, ctx.ledger());
    const changes = changesFor(ctx.db, mv);
    const dry = opts.dryRun || ctx.dryRun;

    if (dry) {
      return { ok: true, dryRun: true, kind: draft.kind, date: draft.date,
               summary, changes, warnings: opts.warnings ?? [] };
    }

    const { movementId, replayed } = writeMovementDetailed(ctx.db, mv, {
      idempotencyKey: ctx.idempotencyKey, index: opts.index,
    });
    if (!replayed) opts.after?.(ctx.db, movementId);

    // A replay already happened. Report the balances as they stand, not as they would have
    // been had this call been the first one.
    return {
      ok: true, movementId, dryRun: false, kind: draft.kind, date: draft.date, summary,
      changes: replayed ? changes.map((c) => ({ ...c, after: c.before })) : changes,
      warnings: replayed
        ? [...(opts.warnings ?? []), 'Already recorded under this idempotency key. Nothing moved this time.']
        : (opts.warnings ?? []),
    };
  } catch (e) {
    if (e instanceof DomainError) return e.toRefusal();
    throw e;
  }
}

/**
 * Reversing something and writing it again, or doing neither.
 *
 * Correcting a record that moved money means undoing the movement and posting a new one, and
 * the second half can be refused — the account it should have come out of may not cover it.
 * A correction that stopped there would leave the reversal standing and nothing in its place,
 * which is worse than the mistake it was fixing. So the whole of it happens inside one
 * transaction and a refusal takes it all back: either the record was corrected, or it is
 * exactly as it was.
 */
export function atomically(ctx: AppCtx, write: () => Receipt | Refusal): Receipt | Refusal {
  let outcome: Receipt | Refusal | undefined;
  const rollback = Symbol('rolled back');
  try {
    ctx.db.$raw.transaction(() => {
      outcome = write();
      if (!outcome.ok) throw rollback;
    })();
  } catch (e) {
    if (e !== rollback) throw e;
  }
  return outcome ?? refusal('not_found', 'Nothing was written.');
}

/** A write that changes a description rather than a balance, so it has no movement. */
export function noted(summary: string, warnings: string[] = []): Receipt {
  return { ok: true, dryRun: false, kind: 'edit', date: new Date().toISOString().slice(0, 10),
           summary, changes: [], warnings };
}

export function refusal(code: Refusal['code'], message: string, remedy?: string): Refusal {
  return { ok: false, code, message, remedy };
}

export const today = (ctx: AppCtx) => ctx.now.toISOString().slice(0, 10);
export const bucketOf = (date: string) => date.slice(0, 7);

/** Ids are readable on purpose: a person reading the log should recognise what they name. */
export const newId = (prefix: string) =>
  `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export const DryRun = z.object({ dryRun: z.boolean().default(false) });


/**
 * Reverse a movement, if there is one.
 *
 * Correcting or removing a log row has to undo what it moved, or the balances go on
 * reflecting something the record no longer claims. Written as its own movement so the log
 * keeps both — a ledger whose past can be edited is a ledger nobody can check.
 */
export function undoMovement(ctx: AppCtx, movementId: string | null | undefined): void {
  if (!movementId) return;
  const legs = ctx.db.select().from(t.legs).where(eq(t.legs.transactionId, movementId)).all();
  if (legs.length === 0) return;

  const already = ctx.db.select().from(t.transactions).all().some((x) => x.correctsId === movementId);
  if (already) return;

  const mv = validate({
    date: today(ctx), kind: 'correction', note: 'reverses a corrected record',
    legs: legs.map((l) => ({
      fromNodeId: l.toNodeId ?? undefined,
      toNodeId: l.fromNodeId ?? undefined,
      qtyFrom: l.qtyTo ?? l.qtyFrom ?? 0,
      qtyTo: l.qtyFrom ?? undefined,
      categoryId: l.categoryId ?? undefined,
    })),
  }, ctx.ledger());
  writeMovementDetailed(ctx.db, mv, { correctsId: movementId });
}