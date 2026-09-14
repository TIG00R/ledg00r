import { eq } from 'drizzle-orm';
import { schema as t, type Db } from '@ledger/db';
import { validate } from '@ledger/domain';
import { writeMovement, ledgerView } from '@ledger/db';
import { installmentDueDate } from '@ledger/engine';
import { nextOccurrence, readTemplates } from './capabilities/planning.js';
import type { RecurringTemplate } from '@ledger/engine';
import type { AppCtx } from './context.js';

/**
 * The tick that makes a promise into a behaviour.
 *
 * Two things post themselves: standing charges whose date has come, and installments on a
 * plan the owner has asked the ledger to pay. Both are recorded as ordinary movements marked
 * `automatic`, so nothing about them is hidden — they appear in the log, in the flow chart
 * and in the balances exactly as a hand-recorded one would.
 *
 * Every posting is guarded so running the tick twice, or restarting the container mid-day,
 * cannot double-post: templates carry the date they last fired, installments carry the date
 * they were paid, and both are checked inside the same transaction as the write.
 */
export interface TickResult {
  posted: Array<{ what: string; movementId: string; amount: number }>;
  skipped: Array<{ what: string; because: string }>;
}

export function tick(ctx: AppCtx): TickResult {
  const posted: TickResult['posted'] = [];
  const skipped: TickResult['skipped'] = [];
  const todayIso = ctx.now.toISOString().slice(0, 10);

  for (const tpl of readTemplates(ctx)) {
    if (!tpl.enabled || tpl.amount == null) continue;

    const row = ctx.db.select().from(t.recurringTemplates)
      .where(eq(t.recurringTemplates.id, tpl.id)).get();
    const due = dueBy(tpl, ctx.now, row?.lastPostedFor ?? null);
    if (!due) continue;
    const dueIso = due.toISOString().slice(0, 10);
    if (dueIso > todayIso) continue;
    if (row?.lastPostedFor === dueIso) continue;

    try {
      const mv = validate({
        date: dueIso, kind: tpl.internal ? 'transfer' : (tpl.toNodeId && !tpl.fromNodeId ? 'income' : 'expense'),
        note: tpl.note ?? tpl.name, automatic: true,
        legs: [{ fromNodeId: tpl.fromNodeId, toNodeId: tpl.toNodeId,
                 qtyFrom: tpl.amount, categoryId: tpl.categoryId }],
      }, ledgerView(ctx.db));

      const movementId = writeMovement(ctx.db, mv, { idempotencyKey: `rec:${tpl.id}:${dueIso}` });
      ctx.db.update(t.recurringTemplates).set({ lastPostedFor: dueIso })
        .where(eq(t.recurringTemplates.id, tpl.id)).run();
      posted.push({ what: tpl.name, movementId, amount: tpl.amount });
    } catch (e) {
      // A template whose account is short is reported, not retried into a negative balance.
      skipped.push({ what: tpl.name, because: (e as Error).message });
    }
  }

  for (const auto of ctx.db.select().from(t.autopay).all()) {
    if (!auto.enabled) continue;
    for (const inst of ctx.db.select().from(t.installments).all()) {
      if (inst.propertyId !== auto.propertyId || inst.paidAt) continue;
      const due = inst.dueDate ? new Date(`${inst.dueDate}T12:00:00`)
                               : installmentDueDate(inst.monthLabel, inst.dueDayKind, inst.dueDayNum ?? undefined);
      if (!due) continue;
      const dueIso = due.toISOString().slice(0, 10);
      if (dueIso > todayIso) continue;

      const property = ctx.db.select().from(t.nodes).where(eq(t.nodes.id, inst.propertyId)).get();
      const equity = !/maintenance|service|fee/i.test(inst.note);

      try {
        const mv = validate({
          date: dueIso, kind: 'installment', note: inst.note || property?.name, automatic: true,
          legs: [equity && property
            ? { fromNodeId: auto.fromNodeId, qtyFrom: inst.amountEgp, toNodeId: property.id, qtyTo: inst.amountEgp }
            : { fromNodeId: auto.fromNodeId, qtyFrom: inst.amountEgp }],
        }, ledgerView(ctx.db));

        const movementId = writeMovement(ctx.db, mv, { idempotencyKey: `inst:${inst.id}` });
        ctx.db.update(t.installments).set({ paidAt: dueIso, movementId })
          .where(eq(t.installments.id, inst.id)).run();
        posted.push({ what: `${property?.name ?? inst.propertyId} installment`, movementId, amount: inst.amountEgp });
      } catch (e) {
        skipped.push({ what: `${property?.name ?? inst.propertyId} installment due ${dueIso}`,
                       because: (e as Error).message });
      }
    }
  }

  return { posted, skipped };
}

const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0);

/**
 * The most recent date this template was due, at or before today.
 *
 * `nextOccurrence` only ever looks forward, so asking it from this morning answers with next
 * month whenever today is past the day — which meant a charge posted on its own day and on no
 * other. A container switched off on the 1st and started again on the 6th skipped that month
 * entirely, and nobody was told.
 *
 * Looking back is only done for a charge that has posted before, and only as far as the last
 * date it posted for. A template added today does not reach back and post last month, and a
 * ledger reopened after a year does not post a year of standing charges on the morning
 * somebody looks at it — those are for a person to record deliberately.
 */
function dueBy(tpl: RecurringTemplate, now: Date, lastPostedFor: string | null): Date | null {
  const ahead = nextOccurrence(tpl, startOfDay(now));
  if (ahead && ahead <= now) return ahead;
  if (!lastPostedFor) return ahead ?? null;

  // Walk forward from a period back, keeping the last occurrence that is not in the future.
  const step = tpl.cadence === 'quarterly' ? 3 : tpl.cadence === 'annually' ? 12 : 1;
  let cursor = tpl.cadence === 'weekly'
    ? new Date(now.getFullYear(), now.getMonth(), now.getDate() - 7)
    : new Date(now.getFullYear(), now.getMonth() - step, 1);
  let missed: Date | null = null;
  for (let i = 0; i < 24; i += 1) {
    const at = nextOccurrence(tpl, cursor);
    if (!at || at > now) break;
    missed = at;
    cursor = new Date(at.getFullYear(), at.getMonth(), at.getDate() + 1);
  }

  if (!missed) return ahead ?? null;
  return missed.toISOString().slice(0, 10) > lastPostedFor ? missed : (ahead ?? null);
}

/** Run the tick on boot and hourly. An hour is fine: nothing here is due to the minute. */
export function startScheduler(ctxOf: () => AppCtx, onResult?: (r: TickResult) => void): () => void {
  const run = () => {
    try { onResult?.(tick(ctxOf())); }
    catch (e) { console.error('[scheduler]', e); }
  };
  run();
  const handle = setInterval(run, 60 * 60 * 1000);
  return () => clearInterval(handle);
}
