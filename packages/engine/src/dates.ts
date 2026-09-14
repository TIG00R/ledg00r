/**
 * Local-calendar date helpers.
 *
 * `isoLocalDate` exists because `toISOString()` shifts to UTC and would report the
 * previous day for local times before the offset (INVENTORY F-035, implicit note 20).
 * Every date in this engine is a local calendar date.
 */

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'] as const;

export function isoLocalDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function daysInMonth(year: number, monthIndex: number): number {
  return new Date(year, monthIndex + 1, 0).getDate();
}

/** "May 2026" -> Date(2026, 4, 1). Falls back to 1 May 2026 exactly as F-039 does. */
export function parseMonthLabel(label: string): Date {
  const parts = label.trim().split(/\s+/);
  if (parts.length === 2) {
    const m = MONTHS.indexOf(parts[0]!.slice(0, 3) as (typeof MONTHS)[number]);
    const y = Number(parts[1]);
    if (m >= 0 && Number.isFinite(y)) return new Date(y, m, 1);
  }
  return new Date(2026, 4, 1);
}

/** "Oct 23, 2025" -> that day. "Feb 2026" -> the 15th, per F-045. */
export function parseLotDate(text: string): { date: Date; precision: 'day' | 'month' } {
  const cleaned = text.replace(/,/g, ' ').trim();
  const parts = cleaned.split(/\s+/);
  if (parts.length >= 3) {
    const m = MONTHS.indexOf(parts[0]!.slice(0, 3) as (typeof MONTHS)[number]);
    const d = Number(parts[1]);
    const y = Number(parts[2]);
    if (m >= 0 && Number.isFinite(d) && Number.isFinite(y)) {
      return { date: new Date(y, m, d), precision: 'day' };
    }
  }
  if (parts.length === 2) {
    const m = MONTHS.indexOf(parts[0]!.slice(0, 3) as (typeof MONTHS)[number]);
    const y = Number(parts[1]);
    if (m >= 0 && Number.isFinite(y)) return { date: new Date(y, m, 15), precision: 'month' };
  }
  return { date: new Date(2026, 4, 15), precision: 'month' };
}

/**
 * The due date of an installment, at 23:59:59 local.
 * `'last'` means the last day of the month; anything else non-numeric falls back to
 * day 1, replicating F-046 rather than silently correcting it.
 */
export function installmentDueDate(
  monthLabel: string,
  dueDayKind: 'day' | 'last',
  dueDayNum?: number,
): Date | null {
  const base = parseMonthLabel(monthLabel);
  if (monthLabel.trim().split(/\s+/).length !== 2) return null;
  const y = base.getFullYear();
  const m = base.getMonth();
  const day = dueDayKind === 'last'
    ? daysInMonth(y, m)
    : (Number.isFinite(dueDayNum) && (dueDayNum as number) > 0 ? (dueDayNum as number) : 1);
  return new Date(y, m, day, 23, 59, 59);
}

/**
 * Whole months elapsed plus a fraction of the current one.
 * The fraction uses `(day - 1) / daysInMonth`, so the 1st of a month contributes zero.
 * The burn walk deliberately uses `day / daysInMonth` instead — the off-by-one between
 * them is preserved from F-040 and F-042.
 */
export function monthsSinceSnapshot(snapshotAt: Date, now: Date): number {
  let months = (now.getFullYear() - snapshotAt.getFullYear()) * 12
             + (now.getMonth() - snapshotAt.getMonth());
  const frac = (now.getDate() - 1) / daysInMonth(now.getFullYear(), now.getMonth());
  months += frac;
  return Math.max(0, months);
}

export function monthKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

export function monthLabelOf(d: Date): string {
  return `${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

export function daysUntil(target: Date, now: Date): number {
  return Math.ceil((target.getTime() - now.getTime()) / 86_400_000);
}

export { MONTHS };
