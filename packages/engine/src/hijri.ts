/**
 * The lunar calendar, for zakat only.
 *
 * Zakat is owed once a lunar year — a hawl — after wealth first passed nisab, so the date it
 * falls due drifts about eleven days earlier each Gregorian year. Everything else in this
 * ledger runs on the Gregorian calendar; mixing the two anywhere else would be a bug.
 *
 * The conversion is the tabular civil algorithm, which is arithmetic rather than
 * observational. Real moon-sighting can differ by a day, so a date produced here is close
 * enough to plan around and not close enough to argue from — which is why the anniversary is
 * a setting the owner states rather than something the app infers.
 */

export const HIJRI_MONTHS = [
  'Muharram', 'Safar', 'Rabiʿ al-Awwal', 'Rabiʿ al-Thani', 'Jumada al-Ula', 'Jumada al-Akhira',
  'Rajab', 'Shaʿban', 'Ramadan', 'Shawwal', 'Dhul-Qaʿda', 'Dhul-Hijja',
] as const;

/**
 * The same twelve months, short enough for a calendar cell.
 *
 * A day cell has room for a number and about eight characters. Printing the month as a digit
 * saves the space and loses the point — nobody reads "24/3" as Rabiʿ al-Awwal — so the months
 * keep their names and give up their qualifiers instead.
 */
export const HIJRI_MONTHS_SHORT = [
  'Muharram', 'Safar', 'Rabiʿ I', 'Rabiʿ II', 'Jumada I', 'Jumada II',
  'Rajab', 'Shaʿban', 'Ramadan', 'Shawwal', 'Dhul-Qaʿda', 'Dhul-Hijja',
] as const;

export interface HijriDate { year: number; month: number; day: number } // month is 1-12

const floor = Math.floor;

/** Gregorian date to Julian Day Number, at noon. */
function toJdn(y: number, m: number, d: number): number {
  const a = floor((14 - m) / 12);
  const yy = y + 4800 - a;
  const mm = m + 12 * a - 3;
  return d + floor((153 * mm + 2) / 5) + 365 * yy + floor(yy / 4) - floor(yy / 100) + floor(yy / 400) - 32045;
}

function fromJdn(jdn: number): { y: number; m: number; d: number } {
  const a = jdn + 32044;
  const b = floor((4 * a + 3) / 146097);
  const c = a - floor((146097 * b) / 4);
  const dd = floor((4 * c + 3) / 1461);
  const e = c - floor((1461 * dd) / 4);
  const mm = floor((5 * e + 2) / 153);
  return {
    d: e - floor((153 * mm + 2) / 5) + 1,
    m: mm + 3 - 12 * floor(mm / 10),
    y: 100 * b + dd - 4800 + floor(mm / 10),
  };
}

const HIJRI_EPOCH = 1948440; // 1 Muharram 1 AH in the civil tabular reckoning

export function toHijri(date: Date): HijriDate {
  const jdn = toJdn(date.getFullYear(), date.getMonth() + 1, date.getDate());
  const days = jdn - HIJRI_EPOCH;
  const year = floor((30 * days + 10646) / 10631);
  const firstOfYear = hijriToJdn(year, 1, 1);
  const dayOfYear = jdn - firstOfYear;
  const month = Math.min(12, floor(dayOfYear / 29.5) + 1);
  const day = jdn - hijriToJdn(year, month, 1) + 1;
  return { year, month, day };
}

function hijriToJdn(y: number, m: number, d: number): number {
  return d + Math.ceil(29.5 * (m - 1)) + (y - 1) * 354 + floor((3 + 11 * y) / 30) + HIJRI_EPOCH - 1;
}

export function fromHijri(h: HijriDate): Date {
  const g = fromJdn(hijriToJdn(h.year, h.month, h.day));
  return new Date(g.y, g.m - 1, g.d, 12, 0, 0);
}

export function formatHijri(h: HijriDate): string {
  return `${h.day} ${HIJRI_MONTHS[h.month - 1]} ${h.year}`;
}

/** "24 Rabiʿ I" — the day and its month by name, for somewhere with no room for the year. */
export function formatHijriShort(h: HijriDate): string {
  return `${h.day} ${HIJRI_MONTHS_SHORT[h.month - 1]}`;
}

/**
 * The next time a given lunar anniversary comes round, at or after `from`.
 *
 * Passing the anniversary in the current lunar year means it has already been paid this
 * hawl, so the answer is next year's.
 */
export function nextHawl(anniversary: { month: number; day: number }, from: Date): { date: Date; hijri: HijriDate } {
  const here = toHijri(from);
  for (const year of [here.year, here.year + 1]) {
    const h = { year, month: anniversary.month, day: anniversary.day };
    const date = fromHijri(h);
    if (date >= from) return { date, hijri: h };
  }
  const h = { year: here.year + 2, ...anniversary };
  return { date: fromHijri(h), hijri: h };
}

/** The hawl that is currently running: the anniversary just gone. */
export function currentHawlStart(anniversary: { month: number; day: number }, from: Date): { date: Date; hijri: HijriDate } {
  const next = nextHawl(anniversary, from);
  const h = { ...next.hijri, year: next.hijri.year - 1 };
  return { date: fromHijri(h), hijri: h };
}

/**
 * A lunar year later, to the same day of the same lunar month.
 *
 * This is what a hawl is measured in. Adding 354 days is close and wrong: it drifts against
 * the calendar the obligation is actually reckoned in, and by the third year the answer is a
 * different day of a different month.
 */
export function addHijriYears(h: HijriDate, years: number): HijriDate {
  return { year: h.year + years, month: h.month, day: h.day };
}

/** A date written as yyyy-mm-dd, in the lunar calendar. Noon, so no timezone can move it. */
export function hijriOfIso(iso: string): HijriDate | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
  return toHijri(new Date(`${iso}T12:00:00`));
}

/** "12 Ramadan 1447" for a plain yyyy-mm-dd, or null when there is no date to convert. */
export function hijriTextOfIso(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const h = hijriOfIso(iso);
  return h ? formatHijri(h) : null;
}
