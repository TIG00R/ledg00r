import type { DataSet, MarketState } from './types.js';
import { installmentDueDate } from './dates.js';
import { currentHawlStart, nextHawl, type HijriDate } from './hijri.js';

/**
 * The two classical thresholds, in grams of metal. Silver's is worth far less than gold's
 * today, so choosing it makes zakat due on smaller wealth — which is why it is a choice the
 * owner makes rather than a constant the app picks.
 */
export const NISAB_GOLD_G = 85;
export const NISAB_SILVER_G = 595;

export type NisabBasis = 'gold' | 'silver';

export interface ZakatSettings {
  /** the lunar anniversary wealth first passed nisab */
  anniversaryMonth: number; // 1-12
  anniversaryDay: number;
  basis: NisabBasis;
  /** silver is quoted per gram in the ledger's currency; gold comes from the market */
  silverPerG: number;
  deductDebts: boolean;
}

export interface ZakatDebt {
  id: string;
  label: string;
  amountEgp: number;
  date: string;
  /** what kind of obligation this is, so the screen can say why it counts */
  kind: 'installment' | 'credit' | 'borrowed';
}

/**
 * Money owed to you.
 *
 * A debt you expect back is wealth you happen not to be holding, and the common position is
 * that zakat is owed on it. A debt you have written off is not — which is why writing one off
 * is a recorded act rather than a flag.
 */
export interface ZakatReceivable { id: string; label: string; amountEgp: number; due: string | null }

export function zakatReceivables(d: DataSet, rate: (currency: string) => number): ZakatReceivable[] {
  return (d.debts ?? [])
    .filter((x) => x.direction === 'lent' && !x.settledAt && !x.writtenOffAt)
    .map((x) => ({
      id: x.id,
      label: `Owed by ${x.counterparty}`,
      amountEgp: x.outstanding * rate(x.currency),
      due: x.dueOn ?? null,
    }));
}

/**
 * Debts deductible from the zakat base.
 *
 * Only what is still to be paid inside the hawl counts. Two things are deliberately left
 * out. Installments already paid are not owed — the money has gone, and the assets they
 * bought are what the base is measuring. And the outstanding balance of a property contract
 * is not a debt of this year: it is the sum of installments stretching over a decade, and
 * subtracting it would wipe the base out entirely while the schedule that produces it is
 * already counted month by month.
 *
 * What is left is what a person would actually answer if asked what they owe this year:
 * the payments still ahead of them before the hawl closes, plus any revolving balance
 * sitting against a card right now.
 */
export function zakatDebts(
  d: DataSet, now: Date, s: ZakatSettings,
  /** one unit of a currency in the base currency; defaults to treating everything as base */
  rate: (currency: string) => number = () => 1,
): ZakatDebt[] {
  const to = nextHawl({ month: s.anniversaryMonth, day: s.anniversaryDay }, now).date;
  const out: ZakatDebt[] = [];

  for (const i of d.installments) {
    const due = installmentDueDate(i.monthLabel, i.dueDayKind, i.dueDayNum);
    if (!due || due < now || due > to) continue;
    const property = d.nodes.find((n) => n.id === i.propertyId);
    out.push({
      id: i.id,
      label: `${property?.name ?? 'Installment'}${i.note ? ` · ${i.note}` : ''}`,
      amountEgp: i.amountEgp,
      date: due.toISOString().slice(0, 10),
      kind: 'installment',
    });
  }

  // A revolving balance is owed today in full, so all of it falls inside any hawl. A
  // liability hanging off an asset is a contract balance, not a debt of this year — its
  // payments are already in the loop above.
  const institutions = new Set(d.institutions.map((i) => i.id));
  for (const n of d.nodes) {
    if (n.kind !== 'liability' || n.archived) continue;
    if (n.openingQty <= 0) continue;
    if (!n.parentId || !institutions.has(n.parentId)) continue;
    out.push({ id: n.id, label: n.name, amountEgp: n.openingQty, date: '', kind: 'credit' });
  }

  // Money borrowed from a person is owed in full, the same as a card balance — and unlike a
  // property contract it has no schedule spreading it over years.
  for (const x of d.debts ?? []) {
    if (x.direction !== 'borrowed' || x.settledAt) continue;
    if (x.outstanding <= 0) continue;
    out.push({
      id: x.id,
      label: `Owed to ${x.counterparty}`,
      amountEgp: x.outstanding * rate(x.currency),
      date: x.dueOn ?? '',
      kind: 'borrowed',
    });
  }

  return out.sort((a, b) => a.date.localeCompare(b.date));
}

export function nisabEgp(m: MarketState, s: ZakatSettings): number {
  return s.basis === 'silver' ? NISAB_SILVER_G * s.silverPerG : NISAB_GOLD_G * m.goldPerG;
}

export interface ZakatDates { start: Date; startHijri: HijriDate; due: Date; dueHijri: HijriDate; daysAway: number }

export function zakatDates(now: Date, s: ZakatSettings): ZakatDates {
  const a = { month: s.anniversaryMonth, day: s.anniversaryDay };
  const start = currentHawlStart(a, now);
  const due = nextHawl(a, now);
  return {
    start: start.date, startHijri: start.hijri,
    due: due.date, dueHijri: due.hijri,
    daysAway: Math.max(0, Math.round((due.date.getTime() - now.getTime()) / 86_400_000)),
  };
}
