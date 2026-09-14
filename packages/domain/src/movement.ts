import { roundMoney, type Currency, type DateOnly, type MovementKind, type NodeKind } from '@ledger/contracts';
import { refuse } from './errors.js';

/**
 * The Movement aggregate.
 *
 * Every change to what you own is a movement carrying one or more legs, and a movement is
 * the only thing that changes a balance. Nothing else in the system may write to a node.
 *
 * The rules below are the ones the interface has been enforcing on its own. Moving them here
 * means they hold for the agent, the scheduler and the importer too — a rule that only one
 * caller obeys is not a rule.
 */

export interface NodeView {
  id: string;
  kind: NodeKind;
  name: string;
  currency?: Currency;
  unit?: string;
  archived?: boolean;
}

export interface LegDraft {
  fromNodeId?: string;
  toNodeId?: string;
  /** how much left the source, in the source's own unit */
  qtyFrom?: number;
  /** how much arrived, in the destination's own unit; defaults to qtyFrom when they match */
  qtyTo?: number;
  /** required when the two sides are in different currencies */
  rateApplied?: number;
  feeQty?: number;
  feeNodeId?: string;
  categoryId?: string;
}

export interface MovementDraft {
  date: DateOnly;
  kind: MovementKind;
  note?: string;
  automatic?: boolean;
  legs: LegDraft[];
}

export interface Ledger {
  node(id: string): NodeView | undefined;
  /** what the node holds now, in its own unit */
  balance(id: string): number;
}

export interface ValidatedLeg extends LegDraft {
  qtyFrom: number;
  qtyTo: number;
}

export interface ValidatedMovement extends MovementDraft {
  legs: ValidatedLeg[];
  /** node id to signed change, in that node's own unit */
  deltas: Map<string, number>;
}

/**
 * Check a movement against the ledger it would be written into, and work out what it moves.
 *
 * Returns the deltas rather than applying them, so the same call serves the dry run that
 * powers the preview in the interface and the real write that follows it.
 */
export function validate(draft: MovementDraft, ledger: Ledger): ValidatedMovement {
  if (draft.legs.length === 0) {
    refuse('unbalanced', 'A movement with no legs moves nothing.',
           'Give it at least one leg naming a source, a destination, or both.');
  }

  const deltas = new Map<string, number>();
  const add = (id: string, qty: number) => deltas.set(id, (deltas.get(id) ?? 0) + qty);
  const legs: ValidatedLeg[] = [];

  for (const [i, leg] of draft.legs.entries()) {
    const where = `Leg ${i + 1}`;

    if (!leg.fromNodeId && !leg.toNodeId) {
      refuse('unbalanced', `${where} names neither a source nor a destination.`,
             'A leg that moves nothing is a note, not a movement.');
    }

    const from = leg.fromNodeId ? nodeOrRefuse(ledger, leg.fromNodeId, where) : undefined;
    const to = leg.toNodeId ? nodeOrRefuse(ledger, leg.toNodeId, where) : undefined;

    if (from?.archived) {
      refuse('archived_node', `${from.name} is archived and takes no new movements.`,
             'Restore it first, or point the leg at a live account.');
    }
    if (to?.archived) {
      refuse('archived_node', `${to.name} is archived and takes no new movements.`,
             'Restore it first, or point the leg at a live account.');
    }

    const qtyFrom = leg.qtyFrom ?? leg.qtyTo ?? 0;
    if (!(qtyFrom > 0)) {
      refuse('unbalanced', `${where} moves ${qtyFrom}.`, 'An amount has to be more than nothing.');
    }

    // Crossing currencies without saying at what rate leaves a record nobody can read back.
    const crosses = from && to && from.currency && to.currency && from.currency !== to.currency;
    if (crosses && leg.rateApplied == null && leg.qtyTo == null) {
      refuse('missing_rate',
             `${where} moves ${from!.currency} into ${to!.currency} without a rate.`,
             'Give the rate the bank actually applied, or state what arrived.');
    }
    const qtyTo = leg.qtyTo ?? (crosses ? qtyFrom * (leg.rateApplied ?? 1) : qtyFrom);

    if (leg.feeQty != null && leg.feeQty < 0) {
      refuse('unbalanced', `${where} carries a negative fee.`, 'A fee is a positive amount or nothing.');
    }
    if (leg.feeQty && leg.feeQty > qtyFrom) {
      refuse('unbalanced', `${where} has a fee larger than the amount being moved.`,
             'Reduce the fee, or raise the amount.');
    }

    if (leg.fromNodeId) add(leg.fromNodeId, -qtyFrom);
    if (leg.toNodeId) add(leg.toNodeId, qtyTo);
    if (leg.feeQty && leg.feeNodeId) add(leg.feeNodeId, -leg.feeQty);

    legs.push({ ...leg, qtyFrom, qtyTo });
  }

  // A cash account may not be driven negative. A liability is meant to be — that is what
  // being a debt means — so the check applies to cash alone.
  for (const [id, delta] of deltas) {
    if (delta >= 0) continue;
    const node = ledger.node(id)!;
    if (node.kind !== 'cash') continue;
    const have = ledger.balance(id);
    const after = have + delta;
    if (roundMoney(after, node.currency ?? 'EGP') < 0) {
      refuse('insufficient_funds',
             `${node.name} holds ${fmt(have, node)}, which is ${fmt(-after, node)} short.`,
             'Move less, move money in first, or take it out of another account.');
    }
  }

  return { ...draft, legs, deltas };
}

function nodeOrRefuse(ledger: Ledger, id: string, where: string): NodeView {
  const n = ledger.node(id);
  if (!n) refuse('unknown_node', `${where} names ${id}, which is not an account in this ledger.`,
                 'List the accounts and use one of their ids.');
  return n!;
}

function fmt(qty: number, node: NodeView): string {
  const rounded = roundMoney(qty, node.currency ?? 'EGP');
  return node.unit ? `${rounded} ${node.unit}` : `${node.currency ?? ''} ${rounded}`.trim();
}
