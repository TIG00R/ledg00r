/**
 * Zakat as the owner reads it: one signed list, under one lunar year.
 *
 * Three ideas live here and nothing else does.
 *
 * The first is that wealth is counted together. Gold, cash, shares, goods held to sell and
 * money lent out are one estate on one anniversary, not a handful of pots each keeping its
 * own calendar. The stricter reading gives each kind its own year, and it is defensible — but
 * it produces several dates, several figures and several things to confirm for an owner with
 * one obligation, and an obligation nobody can state in one number is one nobody pays.
 *
 * The second is the entry: one line of arithmetic with a sign on it. A line that adds, a line
 * that subtracts, and — the one that makes the list trustworthy — a line that counts nothing
 * but is shown anyway, because an owner who cannot see their car on the list does not know
 * whether the app considered it or forgot it.
 *
 * The third is the difference between a year that has closed and one still running. What is
 * owed was fixed on the day the hawl closed; what the running year will owe is a guess that
 * moves with the gold price. Both are worth showing and they are not the same number, so a
 * bucket carries both and never adds them together.
 *
 * Nothing here reads a database or a clock.
 */

import type { Hawl } from './zakat-assets.js';

/** the share of zakatable wealth that is owed */
export const ZAKAT_RATE = 0.025;

/**
 * Where a line belongs when the list is read as three sections.
 *
 * Separate from the sign because the two answer different questions. `sign` is arithmetic:
 * what the line does to the total. `group` is where an owner expects to find it — and the two
 * come apart. Rent still inside its lunar year subtracts, but it is not a debt; it belongs
 * with the things that are not being counted, shown as the deduction it is.
 */
export type EntryGroup = 'counted' | 'excluded' | 'debt';

/** one more thing worth knowing about a line, printed under it */
export interface EntryFact {
  label: string;
  value: string;
}

/**
 * One line of the arithmetic.
 *
 * `sign` is the whole of the arithmetic: 1 adds, -1 takes away, and 0 is shown and counted for
 * nothing. The amount is always positive, so a screen never has to decide whether to print a
 * minus of its own — the sign says it, once.
 */
export interface ZakatEntry {
  id: string;
  label: string;
  /** what this line is, in a few words, under the label */
  detail?: string;
  sign: 1 | -1 | 0;
  amount: number;
  /** why a line counts nothing, for the lines that count nothing */
  note?: string;
  /**
   * Which of the three sections the line is read under.
   *
   * Optional because years confirmed before the list was sectioned have no answer, and
   * inventing one for them would put old lines in places their owner never saw them. A line
   * without a group falls back to what its sign implies.
   */
  group?: EntryGroup;
  /** the dates and figures behind the line, for the reader who wants them */
  facts?: EntryFact[];
  /**
   * What the ledger worked this line out to be, where the owner has said otherwise.
   *
   * An override replaces the amount the arithmetic produced; the arithmetic's own answer is
   * kept beside it rather than discarded, so the list can show both and the change can be
   * undone. Absent on every line nobody has touched.
   */
  computed?: number;
  /** whether the amount on this line is the owner's rather than the ledger's */
  overridden?: boolean;
  /**
   * A line the owner wrote, rather than one the ledger worked out.
   *
   * Wealth the app cannot see — coins at a relative's house, a debt nobody recorded — belongs
   * in the reckoning all the same. A typed line is removed outright when it is no longer
   * true; a computed one can only be overridden or hidden, because the thing behind it is
   * still in the ledger.
   */
  typed?: boolean;
}

/** where a line sits when it does not say — the reading the sign implies */
export function groupOf(e: ZakatEntry): EntryGroup {
  return e.group ?? (e.sign === 1 ? 'counted' : e.sign === -1 ? 'debt' : 'excluded');
}

/**
 * What a pot is made of.
 *
 * `estate` is the whole of it now that wealth is counted together; the narrower kinds are kept
 * because confirmed years recorded under them are still on file and still have to be read.
 */
export type BucketKind = 'estate' | 'cash' | 'metal' | 'trade' | 'rent';

/**
 * Where a bucket's most recent lunar year stands.
 *
 * `running` means no year has closed yet, so there is nothing owed and nothing to confirm.
 * `draft` means one has closed and has not been looked at — the figure is what the app makes
 * it, and it keeps moving with the market until it is confirmed. `confirmed` is a figure that
 * has stopped moving, which is the only kind that can be owed and paid against.
 */
export type BucketState = 'running' | 'draft' | 'confirmed';

/** a year the owner has confirmed, and what has been paid against it */
export interface ConfirmedYear {
  id: string;
  dueOn: string;
  dueHijri: string;
  confirmedAt: string;
  base: number;
  due: number;
  entries: ZakatEntry[];
  note: string | null;
  paid: number;
  remaining: number;
}

export interface ZakatBucket {
  /** `wealth` for the estate; older confirmed years are filed under the kind they closed as */
  id: string;
  label: string;
  kind: BucketKind;
  /** the day this pot passed nisab, from which its year is counted */
  anchorOn: string | null;
  /** the year in progress: when it started, when it closes, how far along it is */
  hawl: Hawl | null;
  /** the day the most recent lunar year closed, which is the year that can be confirmed */
  closedOn: string | null;
  /**
   * The arithmetic as it stands today.
   *
   * For a `draft` this is the figure being offered for confirmation. For a `running` or
   * `confirmed` bucket it is an estimate of the year now in progress, and moves daily.
   */
  entries: ZakatEntry[];
  base: number;
  due: number;
  aboveNisab: boolean;
  state: BucketState;
  /** what was confirmed for the closed year, when it has been */
  confirmed: ConfirmedYear | null;
}

/**
 * What the lines come to.
 *
 * Floored at nought, because debts larger than wealth mean nothing is owed — not that zakat
 * is owed backwards.
 */
export function bucketTotal(entries: ZakatEntry[]): number {
  return Math.max(0, entries.reduce((s, e) => s + e.sign * e.amount, 0));
}

export function bucketDue(base: number): number {
  return Math.max(0, base) * ZAKAT_RATE;
}

/**
 * The day the most recent lunar year closed.
 *
 * `hawlFrom` reports the window in progress, so its start is the last anniversary that came
 * round — which is exactly the year that has closed. Before the first anniversary there is
 * none, and nothing is owed.
 */
export function closedOnOf(hawl: Hawl | null): string | null {
  return hawl && hawl.yearsComplete >= 1 ? hawl.startOn : null;
}

export function bucketState(closedOn: string | null, confirmed: boolean): BucketState {
  if (confirmed) return 'confirmed';
  return closedOn ? 'draft' : 'running';
}

export interface ZakatTotals {
  /** confirmed years only: what is actually owed, what is paid, what is left */
  base: number;
  due: number;
  paid: number;
  remaining: number;
  /** every bucket's year in progress, which is a forecast and never added to the above */
  estimatedBase: number;
  estimatedDue: number;
  /** closed years waiting to be looked at */
  drafts: number;
}

export function zakatTotals(buckets: ZakatBucket[]): ZakatTotals {
  const owed = buckets.map((b) => b.confirmed).filter((c): c is ConfirmedYear => !!c);
  return {
    base: owed.reduce((s, c) => s + c.base, 0),
    due: owed.reduce((s, c) => s + c.due, 0),
    paid: owed.reduce((s, c) => s + c.paid, 0),
    remaining: owed.reduce((s, c) => s + c.remaining, 0),
    estimatedBase: buckets.reduce((s, b) => s + b.base, 0),
    estimatedDue: buckets.reduce((s, b) => s + b.due, 0),
    drafts: buckets.filter((b) => b.state === 'draft').length,
  };
}

/** the id a confirmed year is filed under: one per bucket per closing date */
export function zakatYearId(bucket: string, dueOn: string): string {
  return `zy-${bucket.replace(/[^A-Za-z0-9]+/g, '-')}-${dueOn}`;
}
