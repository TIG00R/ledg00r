import type { Cadence, Currency } from './types.js';
import { daysInMonth } from './dates.js';

/**
 * A movement that repeats. The same shape covers money arriving and money leaving —
 * a salary is one whose source is outside your accounts, a bank fee is one whose
 * destination is. Treating them as one thing means a fee is as visible as the income
 * that pays it, which is exactly where the old app went quiet.
 */
export interface RecurringTemplate {
  id: string;
  name: string;
  /** undefined on the incoming side means it arrives from outside your accounts */
  fromNodeId?: string;
  /** undefined on the outgoing side means it leaves them */
  toNodeId?: string;
  amount: number | null;        // null when it varies
  currency: Currency;
  cadence: Cadence;
  dayOfMonth?: number | 'last';
  startDate?: string;
  endDate?: string;
  categoryId?: string;
  enabled: boolean;
  note?: string;
  /** value moved between things you own rather than spent */
  internal?: boolean;
}

export function perMonth(t: RecurringTemplate): number {
  if (t.amount == null) return 0;
  switch (t.cadence) {
    case 'weekly': return (t.amount * 52) / 12;
    case 'monthly': return t.amount;
    case 'quarterly': return t.amount / 3;
    case 'annually': return t.amount / 12;
    default: return 0;
  }
}

export function isRunning(t: RecurringTemplate, on: Date): boolean {
  if (!t.enabled) return false;
  if (t.startDate && new Date(`${t.startDate}T00:00:00`) > on) return false;
  if (t.endDate && new Date(`${t.endDate}T23:59:59`) < on) return false;
  return true;
}

/** The next date this template fires, at or after `from`. */
export function nextOccurrence(t: RecurringTemplate, from: Date): Date | null {
  if (t.cadence === 'irregular' || t.cadence === 'one_off') return null;
  const step = t.cadence === 'quarterly' ? 3 : t.cadence === 'annually' ? 12 : 1;
  const cur = new Date(from.getFullYear(), from.getMonth(), 1);
  for (let i = 0; i < 60; i += 1) {
    const y = cur.getFullYear(), mo = cur.getMonth();
    const day = t.dayOfMonth === 'last' ? daysInMonth(y, mo) : (t.dayOfMonth ?? 1);
    const d = new Date(y, mo, day, 12, 0, 0);
    if (d >= from && isRunning(t, d)) return d;
    cur.setMonth(cur.getMonth() + step);
  }
  return null;
}
