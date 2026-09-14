import { eq } from 'drizzle-orm';
import type { Db } from './client.js';
import * as t from './schema.js';
import { allBalances, balanceOf } from './projections.js';
import { indexRow } from './search.js';
import type { Ledger, MovementDraft, NodeView, ValidatedMovement } from '@ledger/domain';

/**
 * The repositories.
 *
 * One writer for movements, because a movement is the only thing that changes a balance —
 * everything else is a read or a change to a description. Keeping the write in one place is
 * what makes the projections trustworthy: there is exactly one path that can put them out
 * of step, and it maintains them in the same transaction.
 */

export function ledgerView(db: Db): Ledger {
  const nodes = db.select().from(t.nodes).all();
  const balances = allBalances(db);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  return {
    node(id): NodeView | undefined {
      const n = byId.get(id);
      return n && {
        id: n.id, kind: n.kind, name: n.name,
        currency: n.currency ?? undefined, unit: n.unit ?? undefined, archived: n.archived,
      };
    },
    balance: (id) => balances[id] ?? 0,
  };
}

let seqCache: number | null = null;
function nextSeq(db: Db): number {
  if (seqCache == null) {
    const row = db.$raw.prepare('SELECT COALESCE(MAX(seq), 0) AS s FROM transactions').get() as { s: number };
    seqCache = row.s;
  }
  return ++seqCache;
}

export interface WriteOptions {
  idempotencyKey?: string;
  /** an existing movement this one reverses */
  correctsId?: string;
  /**
   * Rows to add to the search index alongside the movement.
   *
   * `recordId` is the id of the log row a hit should lead back to — the expense, the order,
   * the lot — which is not the movement's id. Without it a search result would name a
   * movement the caller then has to work backwards from.
   */
  index?: Array<{ kind: any; recordId?: string; title: string; body: string }>;
}

/**
 * Write a validated movement, and everything that follows from it, at once.
 *
 * The domain has already decided the movement is legal; this puts it, its legs, the balance
 * deltas and the search rows into the database in a single transaction. Nothing here
 * re-checks the rules, because a repository that also enforces invariants is a second place
 * for them to be enforced differently.
 */
export function writeMovement(db: Db, mv: ValidatedMovement, opts: WriteOptions = {}): string {
  return writeMovementDetailed(db, mv, opts).movementId;
}

/**
 * The same write, saying whether it actually wrote.
 *
 * A retried call must not post twice, and it must not claim to have moved money a second
 * time either — an agent reading a receipt that says a balance changed when it did not
 * would draw the wrong conclusion and act on it.
 */
export function writeMovementDetailed(
  db: Db, mv: ValidatedMovement, opts: WriteOptions = {},
): { movementId: string; replayed: boolean } {
  if (opts.idempotencyKey) {
    const seen = db.$raw.prepare('SELECT id FROM transactions WHERE idempotency_key = ?')
      .get(opts.idempotencyKey) as { id: string } | undefined;
    if (seen) return { movementId: seen.id, replayed: true };
  }

  return db.$raw.transaction(() => {
    const seq = nextSeq(db);
    const id = `tx-${seq}-${Math.random().toString(36).slice(2, 8)}`;

    db.insert(t.transactions).values({
      id, seq, date: mv.date, kind: mv.kind, note: mv.note ?? null,
      automatic: mv.automatic ?? false, correctsId: opts.correctsId ?? null,
      idempotencyKey: opts.idempotencyKey ?? null,
    }).run();

    db.insert(t.legs).values(mv.legs.map((leg, i) => ({
      id: `${id}-l${i + 1}`, transactionId: id, seq: i + 1, date: mv.date,
      fromNodeId: leg.fromNodeId ?? null, toNodeId: leg.toNodeId ?? null,
      qtyFrom: leg.qtyFrom, qtyTo: leg.qtyTo,
      rateApplied: leg.rateApplied ?? null,
      feeQty: leg.feeQty ?? null, feeNodeId: leg.feeNodeId ?? null,
      categoryId: leg.categoryId ?? null,
    }))).run();


    if (mv.note) {
      indexRow(db, { kind: 'movement', recordId: id, occurredOn: mv.date,
                     title: mv.kind, body: mv.note });
    }
    for (const row of opts.index ?? []) {
      indexRow(db, { kind: row.kind, recordId: row.recordId ?? id, occurredOn: mv.date,
                     title: row.title, body: row.body });
    }
    return { movementId: id, replayed: false };
  })();
}

/** Balances before and after, for the receipt. Read before the write, applied afterwards. */
export function changesFor(db: Db, mv: ValidatedMovement): Array<{
  nodeId: string; name: string; currency?: string; unit?: string; before: number; after: number;
}> {
  const out = [];
  for (const [nodeId, delta] of mv.deltas) {
    const node = db.select().from(t.nodes).where(eq(t.nodes.id, nodeId)).get();
    if (!node) continue;
    const before = balanceOf(db, nodeId);
    out.push({
      nodeId, name: node.name,
      currency: node.currency ?? undefined, unit: node.unit ?? undefined,
      before, after: before + delta,
    });
  }
  return out;
}

export { allBalances, balanceOf };
export type { MovementDraft };
