import type { DataSet, LedgerNode } from './types.js';

/**
 * What each node holds today, in its own unit.
 *
 * The opening quantity is where a node started; every leg that names it has moved it since.
 * A balance is therefore the opening figure plus the legs, in date order, up to a cut-off —
 * which is what makes an as-of date work at all. Legs carry a quantity per side because an
 * exchange takes dollars out and puts pounds in, and those are different numbers.
 *
 * Nothing here converts between currencies. A balance is a count of the thing itself; what
 * that count is worth is a separate question, asked at whatever rate the caller wants.
 */
export function balances(d: DataSet, upTo?: Date): Record<string, number> {
  const out: Record<string, number> = {};
  for (const n of d.nodes) out[n.id] = n.openingQty;

  const cut = upTo ? isoOf(upTo) : undefined;
  const txs = [...d.transactions]
    .filter((t) => !cut || t.date <= cut)
    .sort((a, b) => (a.date === b.date ? a.seq - b.seq : a.date.localeCompare(b.date)));

  for (const t of txs) {
    for (const leg of [...t.legs].sort((a, b) => a.seq - b.seq)) {
      if (leg.fromNodeId && out[leg.fromNodeId] != null) {
        out[leg.fromNodeId]! -= leg.qtyFrom ?? 0;
      }
      if (leg.toNodeId && out[leg.toNodeId] != null) {
        out[leg.toNodeId]! += leg.qtyTo ?? leg.qtyFrom ?? 0;
      }
      // a fee leaves its own account, which is not always the account being debited
      if (leg.feeQty && leg.feeNodeId && out[leg.feeNodeId] != null) {
        out[leg.feeNodeId]! -= leg.feeQty;
      }
    }
  }
  return out;
}

/** One node's balance. Falls back to the opening quantity for a node with no movements. */
export function balanceOf(d: DataSet, nodeId: string, upTo?: Date): number {
  return balances(d, upTo)[nodeId] ?? 0;
}

/** How many movements name this node. Zero is what makes a node safe to delete. */
export function movementCount(d: DataSet, nodeId: string): number {
  let n = 0;
  for (const t of d.transactions) {
    if (t.legs.some((l) => l.fromNodeId === nodeId || l.toNodeId === nodeId || l.feeNodeId === nodeId)) n += 1;
  }
  return n;
}

/**
 * Whether a movement of this size can come out of this account.
 *
 * A cash account can be short; a credit line is meant to be. The distinction matters because
 * warning about an overdrawn card would be noise, and staying quiet about an overdrawn
 * current account would be a missed cheque.
 */
export function shortfall(d: DataSet, node: LedgerNode, qty: number, upTo?: Date): number {
  if (node.kind !== 'cash') return 0;
  const have = balanceOf(d, node.id, upTo);
  return qty > have ? qty - have : 0;
}

function isoOf(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
