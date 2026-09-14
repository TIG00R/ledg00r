import type { DataSet, MarketState, Snapshot } from './types.js';
import { compute } from './accrual.js';
import { monthLabelOf, isoLocalDate, monthsSinceSnapshot, parseMonthLabel } from './dates.js';

/**
 * Close the books at `now` and start rolling forward from there instead.
 *
 * The accrual is an estimate that widens with time: income is applied at today's rate for
 * the whole elapsed period, and any month without logged expenses falls back to the budget
 * baseline. Re-baselining replaces those months of estimate with one measured position.
 */
export function rebaseline(d: DataSet, m: MarketState, now: Date): Snapshot {
  const v = compute(d, m, now);
  return {
    label: monthLabelOf(now),
    effectiveFrom: isoLocalDate(now),
    cashEgp: Math.round(v.cash),
    goldGramsOwn: v.accrual.goldGrams,
    reEgp: Math.round(v.re),
    paidByProperty: Object.fromEntries(
      Object.entries(v.accrual.paidByProperty).map(([k, n]) => [k, Math.round(n)]),
    ),
    totalByProperty: { ...d.snapshot.totalByProperty },
  };
}

export interface SnapshotHealth {
  months: number;
  /** the share of the burn that is the budget baseline standing in for unlogged months */
  estimatedShare: number;
  stale: boolean;
  reason: string;
}

/**
 * How much of what you are looking at is measured rather than assumed.
 * `staleAfterMonths` is a preference — three months is a default, not a fact.
 */
export function snapshotHealth(d: DataSet, m: MarketState, now: Date, staleAfterMonths = 3): SnapshotHealth {
  const v = compute(d, m, now);
  const months = monthsSinceSnapshot(parseMonthLabel(d.snapshot.label), now);
  const estimatedShare = v.accrual.burn > 0 ? v.accrual.burnBaseline / v.accrual.burn : 0;
  const stale = months >= staleAfterMonths;
  return {
    months, estimatedShare, stale,
    reason: stale
      ? `${months.toFixed(1)} months of rolling forward — ${(estimatedShare * 100).toFixed(0)}% of the spending is the baseline rather than anything you logged`
      : `${months.toFixed(1)} months since the last close`,
  };
}
