import { z } from 'zod';
import { DomainError, validate, type MovementDraft } from '@ledger/domain';
import { writeMovementDetailed, changesFor, schema as t, type Db } from '@ledger/db';
import { eq } from 'drizzle-orm';
import type { Receipt, Refusal } from '@ledger/contracts';
import { compareToSource, type SourceComparison } from '@ledger/engine';
import type { MarketState } from '@ledger/engine';
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

/** what one unit of a currency is worth in pounds, from the latest tick the ledger holds */
export function rateToEgp(db: Db, currency?: string | null): number {
  if (!currency || currency === 'EGP') return 1;
  const row = db.$raw.prepare(
    'SELECT value FROM market_ticks WHERE key = ? ORDER BY at DESC LIMIT 1',
  ).get(`${currency}_EGP`) as { value: number } | undefined;
  return row?.value ?? 1;
}

/**
 * What actually leaves or reaches the account, in the account's own unit.
 *
 * A record states an amount and the currency it was in; a leg moves the account's own unit
 * and nothing else. The two are the same number only when the two currencies are, and where
 * they were not the raw figure was being taken out as though it were the account's: 5,000
 * pounds spent off a dollar account took five thousand dollars, which either emptied the
 * account or was refused as being four thousand dollars short. Neither is what happened.
 *
 * Converted through pounds, which is the one rate this ledger keeps for every currency, at
 * the rate in force now — the same conversion `asset.add` has always made for the money that
 * paid for a thing. The record keeps the amount and the currency it was actually stated in.
 */
export function inAccountQty(
  db: Db, amount: number, currency: string | null | undefined, accountCurrency: string | null | undefined,
): number {
  const from = currency ?? 'EGP';
  const to = accountCurrency ?? 'EGP';
  if (from === to) return amount;
  return (amount * rateToEgp(db, from)) / rateToEgp(db, to);
}
export const bucketOf = (date: string) => date.slice(0, 7);

/**
 * How a node reads in a sentence meant for someone reading a receipt, not a database.
 *
 * Its own name, with the institution that holds it named beside it when it has one — "EGP
 * current · Nile Bank" rather than a node id nobody but the ledger recognises. A property or
 * any other node with no institution is just its name, because there is nothing else to say
 * about where it sits. A confirmation that names an id instead of this reads as a receipt from
 * the database rather than one from the ledger.
 */
export function nameOf(db: Db, nodeId: string | null | undefined): string {
  if (!nodeId) return '—';
  const node = db.select().from(t.nodes).where(eq(t.nodes.id, nodeId)).get();
  if (!node) return nodeId;
  const inst = node.parentId
    ? db.select().from(t.institutions).where(eq(t.institutions.id, node.parentId)).get()
    : undefined;
  return inst ? `${node.name} · ${inst.name}` : node.name;
}

/**
 * Ids are readable on purpose: a person reading the log should recognise what they name.
 *
 * The random tail is what keeps them apart, and it comes from the engine so that every id in
 * the ledger — these and the movement ids the repository writes — is drawn the same way.
 */
export { newId } from '@ledger/engine';

export const DryRun = z.object({ dryRun: z.boolean().default(false) });

/** The seven fields every `sourceComparison` reading reports, all null together when absent. */
export const SOURCE_FIELDS = {
  sourceCurrency: z.string().nullable(),
  sourceAmount: z.number().nullable(),
  sourceRateThen: z.number().nullable(),
  sourceRateNow: z.number().nullable(),
  sourceValueNowEgp: z.number().nullable(),
  sourceDiffEgp: z.number().nullable(),
  sourceDiffPct: z.number().nullable(),
};

export interface NoSourceReading {
  sourceCurrency: null; sourceAmount: null; sourceRateThen: null; sourceRateNow: null;
  sourceValueNowEgp: null; sourceDiffEgp: null; sourceDiffPct: null;
}
const NO_SOURCE: NoSourceReading = {
  sourceCurrency: null, sourceAmount: null, sourceRateThen: null, sourceRateNow: null,
  sourceValueNowEgp: null, sourceDiffEgp: null, sourceDiffPct: null,
};

/**
 * A holding's second reading, flattened onto the row it belongs to.
 *
 * Reads back whatever was actually recorded — a currency, an amount, a rate, all three or
 * none — and asks `compareToSource` what that money would be worth now against what the
 * holding itself is worth now. Nothing recorded reads back as every field null, not as an
 * absent one: a screen can spread this straight onto a row without a special case for the
 * holdings that predate it.
 */
export function sourceReading(
  source: { currency: string | null; amount: number | null; rate: number | null } | null | undefined,
  holdingValueEgp: number,
  market: Pick<MarketState, 'fxRates'>,
): SourceComparison | NoSourceReading {
  if (!source?.currency || !source.amount || !source.rate) return NO_SOURCE;
  return compareToSource(
    { currency: source.currency, amount: source.amount, rate: source.rate },
    holdingValueEgp, market,
  ) ?? NO_SOURCE;
}


/**
 * A movement, the other way round.
 *
 * Each leg is mirrored — what went out comes back, what came in goes — and a leg that
 * carried a fee gets that fee handed back as a leg of its own. A fee only ever subtracts, so
 * it cannot be mirrored in place; left out altogether, reversing a purchase that cost a
 * commission put the metal back and kept the commission, which is money vanishing.
 */
export function reversalLegs(legs: Array<{
  fromNodeId: string | null; toNodeId: string | null;
  qtyFrom: number | null; qtyTo: number | null;
  feeQty: number | null; feeNodeId: string | null; categoryId: string | null;
}>) {
  return [
    ...legs.map((l) => ({
      fromNodeId: l.toNodeId ?? undefined,
      toNodeId: l.fromNodeId ?? undefined,
      qtyFrom: l.qtyTo ?? l.qtyFrom ?? 0,
      qtyTo: l.qtyFrom ?? undefined,
      categoryId: l.categoryId ?? undefined,
    })),
    ...legs
      .filter((l) => l.feeQty && l.feeNodeId)
      .map((l) => ({ toNodeId: l.feeNodeId!, qtyFrom: l.feeQty!, qtyTo: l.feeQty! })),
  ];
}

/**
 * Movements that no longer stand, because something reversed them.
 *
 * Undoing a movement writes its opposite rather than deleting it: the balances come back and
 * the log keeps both rows, which is what makes a ledger checkable. A list of records is not
 * the log, though — it answers "what happened", and a payment that has been taken back did
 * not happen. Lists built straight off the transactions table went on showing undone records
 * until someone reloaded against a table that knew better, so they ask here instead.
 *
 * Records kept in a table of their own — expenses, giving, orders, metal lots — are removed
 * by the undo itself and never reach this.
 */
export function reversedMovements(db: AppCtx['db']): Set<string> {
  return new Set(db.select().from(t.transactions).all()
    .map((x) => x.correctsId)
    .filter((id): id is string => !!id));
}

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
    legs: reversalLegs(legs),
  }, ctx.ledger());
  writeMovementDetailed(ctx.db, mv, { correctsId: movementId });
}