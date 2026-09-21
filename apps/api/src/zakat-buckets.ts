import { schema as t, type Db } from '@ledger/db';
import { eq } from 'drizzle-orm';
import {
  zakatDates, formatHijri, bucketTotal, bucketDue, closedOnOf, bucketState, zakatYearId,
  type ZakatSettings, type ZakatDebt, type ZakatReceivable,
  type ZakatBucket, type ZakatEntry, type EntryFact, type ConfirmedYear, type Hawl,
} from '@ledger/engine';
import type { ZakatLine } from '@ledger/engine';
import type { AssetsForZakat } from './zakat-assets.js';

/**
 * The ledger's wealth as one estate, under one lunar year.
 *
 * Everything an owner holds is counted together on the anniversary they stated: cash, shares,
 * gold, goods bought to resell, money lent out. A stricter reading gives each kind its own
 * year — gold counted from the day the held weight passed nisab, each trade good from the day
 * it was bought — and that reading is defensible, but it hands an owner with one obligation
 * four dates, four figures and four things to confirm. What is kept from it is the part that
 * does the work: the day the estate passed nisab is the day the year starts, and it is stated
 * rather than guessed.
 *
 * So inclusion here turns on what a thing is held for, not on how long that particular thing
 * has been held. A flat lived in counts nothing. A flat held to sell counts in full. A flat
 * let out counts nothing itself — the rent it earned landed in an account, and the cash figure
 * has it already.
 *
 * Things outside zakat go on the list as lines that count nothing. They belong there for the
 * same reason a bank statement shows a zero: an owner who cannot see their car on the list has
 * no way to tell whether it was considered and excluded or simply forgotten.
 */

const DAY = 86_400_000;
const iso = (d: Date) => d.toISOString().slice(0, 10);
/** a figure as a fact reads it: grouped digits, no unit, because the list states its own */
const num = (n: number) =>
  new Intl.NumberFormat('en-GB', { maximumFractionDigits: 0 }).format(Math.round(n));

/** the one pot every year is confirmed against */
export const ESTATE = 'wealth';

export interface BucketSources {
  now: Date;
  settings: ZakatSettings;
  nisab: number;
  cash: number;
  shares: number;
  /**
   * Uninvested money at the broker, which is counted inside `cash` as well.
   *
   * Passed separately so the list can draw the share book the way every other screen draws
   * it — the positions and the wallet behind them as one thing — without changing what the
   * base comes to. It is moved from one line to the other, never added twice.
   */
  brokerageCash: number;
  receivables: ZakatReceivable[];
  debts: ZakatDebt[];
  deductDebts: boolean;
  owned: AssetsForZakat;
  /**
   * The earliest date the ledger knows anything about.
   *
   * The anniversary is a Hijri month and day with no year attached, so the last time it came
   * round is always in the past — including for a ledger opened last week. Without this the
   * app would offer to confirm a year that nobody lived through.
   */
  ledgerSince: string | null;
}

/** the anniversary, shaped as the year it is */
function estateHawl(now: Date, s: ZakatSettings, ledgerSince: string | null): Hawl {
  const d = zakatDates(now, s);
  const startOn = iso(d.start);
  const span = Math.max(1, Math.round((d.due.getTime() - d.start.getTime()) / DAY));
  // A year has closed only if the ledger was already keeping books when it did.
  const closed = !!ledgerSince && startOn >= ledgerSince;
  return {
    startOn, startHijri: d.startHijri, startHijriText: formatHijri(d.startHijri),
    dueOn: iso(d.due), dueHijri: d.dueHijri, dueHijriText: formatHijri(d.dueHijri),
    yearsComplete: closed ? 1 : 0,
    complete: closed,
    daysRemaining: d.daysAway,
    elapsedPct: Math.min(100, Math.max(0, ((span - d.daysAway) / span) * 100)),
  };
}

/** what has been given against each confirmed year */
function paidByYear(db: Db): Record<string, number> {
  const out: Record<string, number> = {};
  for (const c of db.select().from(t.charity).all()) {
    const year = (c as { zakatYearId?: string | null }).zakatYearId;
    if (!year) continue;
    out[year] = (out[year] ?? 0) + c.egp;
  }
  return out;
}

function confirmedFor(
  db: Db, bucket: string, closedOn: string | null, paid: Record<string, number>,
): ConfirmedYear | null {
  if (!closedOn) return null;
  const id = zakatYearId(bucket, closedOn);
  const row = db.select().from(t.zakatYears).where(eq(t.zakatYears.id, id)).get();
  if (!row) return null;
  const given = paid[id] ?? 0;
  return {
    id: row.id, dueOn: row.dueOn, dueHijri: row.dueHijri, confirmedAt: row.confirmedAt,
    base: row.base, due: row.due,
    entries: (row.entries as ZakatEntry[]) ?? [],
    note: row.note,
    paid: given,
    remaining: Math.max(0, row.due - given),
  };
}

/**
 * The list, with the owner's own corrections applied to it.
 *
 * Three things can have been said about a line. It can be left alone, which is every line
 * until somebody touches one. It can carry a figure of the owner's instead of the ledger's —
 * the ledger's own answer is kept beside it, because it is still what the arithmetic says and
 * the correction has to be undoable. Or it can be taken out of the reckoning altogether,
 * which is not the same as the ledger not knowing about it: the thing is still owned, it is
 * simply not being counted.
 *
 * And lines can be added that the ledger has no way to produce: gold at a relative's house,
 * a loan nobody wrote down. Those are the owner's outright, and are removed outright.
 */
function withOwnLines(db: Db, bucket: string, computed: ZakatEntry[]): ZakatEntry[] {
  const rows = db.select().from(t.zakatEntries).all().filter((r) => r.bucket === bucket);
  if (rows.length === 0) return computed;

  const corrections = new Map(rows.filter((r) => r.entryId).map((r) => [r.entryId!, r]));
  const kept: ZakatEntry[] = [];
  for (const entry of computed) {
    const said = corrections.get(entry.id);
    if (!said) { kept.push(entry); continue; }
    if (said.removed) continue;
    if (said.amount == null) { kept.push(entry); continue; }
    kept.push({
      ...entry,
      amount: said.amount,
      computed: entry.amount,
      overridden: true,
      note: said.note ?? entry.note,
    });
  }

  for (const own of rows.filter((r) => !r.entryId && !r.removed)) {
    const group = (own.grp as ZakatEntry['group']) ?? 'counted';
    kept.push({
      id: own.id,
      label: own.label ?? 'A line of your own',
      sign: (own.sign === -1 ? -1 : own.sign === 0 ? 0 : 1) as ZakatEntry['sign'],
      amount: own.amount ?? 0,
      group,
      detail: 'yours, not the ledger\'s',
      note: own.note ?? undefined,
      typed: true,
    });
  }
  return kept;
}

/** the dates a thing turns on, for the reader who wants to check them */
function datesOf(l: ZakatLine): EntryFact[] {
  const out: EntryFact[] = [];
  if (l.dates.acquiredOn) out.push({ label: 'Acquired', value: l.dates.acquiredOn });
  if (l.dates.intentionSince) out.push({ label: 'Held so since', value: l.dates.intentionSince });
  if (l.dates.nisabMetOn) out.push({ label: 'Passed nisab', value: l.dates.nisabMetOn });
  return out;
}

/**
 * The estate, with its year and its arithmetic.
 *
 * `base` and `due` are always the figures as they stand today — an estimate, which is what a
 * year still running is. What is actually owed sits under `confirmed`, and only gets there
 * when the owner has looked at the closed year and said the figure is right.
 *
 * An array of one, because a confirmed year is still filed per pot and years closed under the
 * older per-kind reading are still on record. Nothing new is ever added to it.
 */
export function zakatBuckets(db: Db, src: BucketSources): ZakatBucket[] {
  const { now, settings, nisab, owned } = src;
  const entries: ZakatEntry[] = [];

  // ── what counts ─────────────────────────────────────────────────────────────────────
  // The broker's uninvested cash is money, and the base counts it either way. Which line it
  // is read under is the question, and the answer is the one the portfolio already gives: the
  // share book is the positions and the wallet behind them, and cash is what is held at a bank.
  const bankCash = src.cash - src.brokerageCash;
  const book = src.shares + src.brokerageCash;
  if (bankCash > 0) {
    entries.push({
      id: 'cash', label: 'Cash', sign: 1, amount: bankCash, group: 'counted',
      detail: 'every account, converted at today\'s rates',
    });
  }
  if (book > 0) {
    entries.push({
      id: 'shares', label: 'Shares and funds', sign: 1, amount: book, group: 'counted',
      detail: 'the whole book — positions at the prices last recorded, and the cash at the broker',
      facts: src.brokerageCash > 0
        ? [{ label: 'Uninvested at the broker', value: num(src.brokerageCash) }]
        : [],
    });
  }
  for (const l of owned.metal.lines) {
    if (l.basis !== 'value') continue;
    entries.push({
      id: l.id, label: l.name, sign: 1, amount: l.value, group: 'counted',
      detail: `${l.intentionLabel} · charged on its weight at today's price`,
      facts: datesOf(l),
    });
  }
  for (const l of owned.lines) {
    if (l.basis !== 'value') continue;
    entries.push({
      id: l.id, label: l.name, sign: 1, amount: l.value, group: 'counted',
      detail: `${l.intentionLabel} · charged on its whole value`,
      facts: datesOf(l),
    });
  }
  for (const r of src.receivables) {
    entries.push({
      id: `owed-${r.id}`, label: r.label, sign: 1, amount: r.amountEgp, group: 'counted',
      detail: 'wealth you happen not to be holding',
      facts: r.due ? [{ label: 'Expected back', value: r.due }] : [],
    });
  }

  // ── what is shown and counted for nothing ───────────────────────────────────────────
  for (const l of [...owned.metal.lines, ...owned.lines]) {
    if (l.basis === 'value') continue;
    const rent = l.basis === 'rent';
    entries.push({
      id: `excluded-${l.id}`, label: l.name, sign: 0, amount: l.value, group: 'excluded',
      detail: l.intentionLabel,
      note: rent
        ? 'Let out, so the building is outside zakat. The rent it earned landed in an account, and cash has counted it already.'
        : l.reason,
      facts: datesOf(l),
    });
  }

  // ── what comes off ──────────────────────────────────────────────────────────────────
  for (const d of src.debts) {
    entries.push({
      id: `debt-${d.id}`, label: d.label,
      // Listed either way. Whether debts come off is the owner's choice, and a debt that
      // vanishes from the page when the choice is made leaves them no way to see what the
      // choice was about.
      sign: src.deductDebts ? -1 : 0,
      amount: d.amountEgp, group: 'debt',
      detail: d.kind === 'installment' ? 'an installment falling inside this year'
        : d.kind === 'credit' ? 'a card balance, owed in full today'
          : 'borrowed from a person, owed in full',
      note: src.deductDebts ? undefined : 'Not subtracted — the deduction is switched off.',
      facts: [{ label: 'Due', value: d.date || 'owed now' }],
    });
  }

  const reckoned = withOwnLines(db, ESTATE, entries);
  const base = bucketTotal(reckoned);
  const hawl = estateHawl(now, settings, src.ledgerSince);
  const closedOn = closedOnOf(hawl);
  const confirmed = confirmedFor(db, ESTATE, closedOn, paidByYear(db));
  const aboveNisab = nisab > 0 && base >= nisab;

  return [{
    id: ESTATE, label: 'Everything you own', kind: 'estate',
    // The anniversary is stated by the owner rather than read off a purchase, so there is no
    // date to anchor to beyond the one the hawl already carries.
    anchorOn: null,
    hawl,
    entries: reckoned,
    base,
    // Nothing is owed on wealth that never reached the threshold, however long it sat there.
    due: aboveNisab ? bucketDue(base) : 0,
    aboveNisab,
    closedOn,
    state: bucketState(closedOn, !!confirmed),
    confirmed,
  }];
}
