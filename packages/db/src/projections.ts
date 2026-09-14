import type { Db } from './client.js';

/**
 * Balances, read from the log.
 *
 * A balance is an account's opening quantity plus everything the movements have done to it.
 * That sum is computed here, on every read, rather than kept in a table alongside the log —
 * because a stored total is a second thing that can be right, and when the two disagree the
 * ledger has no way to say which one the owner should believe.
 *
 * This was not free to learn: the running total was seeded without its opening quantity, so
 * the first movement on an account silently erased whatever it opened with, and the screens
 * showed a number that was merely plausible. The reconciliation check that caught it only
 * needed to exist because there was something to reconcile.
 *
 * The cost of asking the log directly is one indexed pass over `legs` per read: a tenth of a
 * millisecond at a thousand legs, thirty-three at a hundred thousand, and under a second at
 * a million — which is further than a lifetime of daily use reaches. A ledger this size has
 * nothing to gain from a cache and everything to lose from disagreeing with itself.
 */

/** opening + what came in - what went out - fees paid, for one node or for all of them. */
const WALK = `
  n.opening_qty
    + COALESCE((SELECT SUM(COALESCE(l.qty_to, l.qty_from, 0)) FROM legs l WHERE l.to_node_id = n.id), 0)
    - COALESCE((SELECT SUM(COALESCE(l.qty_from, 0)) FROM legs l WHERE l.from_node_id = n.id), 0)
    - COALESCE((SELECT SUM(COALESCE(l.fee_qty, 0)) FROM legs l WHERE l.fee_node_id = n.id), 0)
`;

export function balanceOf(db: Db, nodeId: string): number {
  const row = db.$raw.prepare(`SELECT ${WALK} AS qty FROM nodes n WHERE n.id = ?`)
    .get(nodeId) as { qty: number } | undefined;
  return row?.qty ?? 0;
}

export function allBalances(db: Db): Record<string, number> {
  const rows = db.$raw.prepare(`SELECT n.id AS id, ${WALK} AS qty FROM nodes n`)
    .all() as Array<{ id: string; qty: number }>;
  const out: Record<string, number> = {};
  for (const r of rows) out[r.id] = r.qty;
  return out;
}

/**
 * Monthly totals, also read from the log.
 *
 * `context` names which log is being summed and what the key on each row means: spending by
 * destination, spending by account, or giving by cause. The buckets are months, `YYYY-MM`,
 * because that is the period a person actually asks about.
 */
export function periodTotals(
  db: Db, context: string, from?: string, to?: string,
): Array<{ bucket: string; key: string; currency: string; amount: number; count: number }> {
  const source: Record<string, { table: string; key: string; amount: string }> = {
    expense: { table: 'expenses', key: 'category_id', amount: 'amount' },
    expense_account: { table: 'expenses', key: "COALESCE(account_id, 'unassigned')", amount: 'amount' },
    giving: { table: 'charity', key: 'category_id', amount: 'egp' },
  };
  const s = source[context];
  if (!s) return [];

  const where: string[] = [];
  if (from) where.push('substr(date, 1, 7) >= @from');
  if (to) where.push('substr(date, 1, 7) <= @to');

  return db.$raw.prepare(`
    SELECT substr(date, 1, 7) AS bucket, ${s.key} AS key, currency,
           SUM(${s.amount}) AS amount, COUNT(*) AS count
    FROM ${s.table}
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    GROUP BY bucket, key, currency
    ORDER BY bucket DESC
  `).all({ from: from ?? null, to: to ?? null }) as Array<{
    bucket: string; key: string; currency: string; amount: number; count: number;
  }>;
}
