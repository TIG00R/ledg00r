import { schema as t, type Db } from '@ledger/db';
import { eq } from 'drizzle-orm';
import {
  zakatDates, formatHijri, bucketTotal, bucketDue, closedOnOf, bucketState, zakatYearId,
  type ZakatSettings, type ZakatDebt, type ZakatReceivable,
  type ZakatBucket, type ZakatEntry, type ConfirmedYear, type Hawl,
} from '@ledger/engine';
import type { AssetsForZakat } from './zakat-assets.js';

/**
 * The ledger's wealth, sorted into pots, each with its own lunar year.
 *
 * The rules are all in the engine; what happens here is the sorting. Cash, shares and what is
 * owed to you move together and share the anniversary the owner stated. Gold has its own year,
 * counted from the day the held weight passed nisab. Silver has another. Each thing bought to
 * resell has its own, counted from the day it was bought or the day the intention was formed.
 * Rent is a fourth kind again — a flow rather than a holding, so its year runs over what came
 * in rather than over what is worth what.
 *
 * Things that are outside zakat altogether — a home, a car driven, jewellery worn — are put on
 * the cash list as lines that count nothing. They belong there for the same reason a bank
 * statement shows a zero: an owner who cannot see their car on the list has no way to tell
 * whether it was considered and excluded or simply forgotten.
 */

const DAY = 86_400_000;
const iso = (d: Date) => d.toISOString().slice(0, 10);

export interface BucketSources {
  now: Date;
  settings: ZakatSettings;
  nisab: number;
  cash: number;
  shares: number;
  receivables: ZakatReceivable[];
  heldBack: number;
  debts: ZakatDebt[];
  deductDebts: boolean;
  owned: AssetsForZakat;
  /**
   * The earliest date the ledger knows anything about.
   *
   * The cash anniversary is a Hijri month and day with no year attached, so the last time it
   * came round is always in the past — including for a ledger opened last week. Without this
   * the app would offer to confirm a year that nobody lived through.
   */
  ledgerSince: string | null;
}

/** the cash anniversary, shaped like every other bucket's year */
function cashHawl(now: Date, s: ZakatSettings, ledgerSince: string | null): Hawl {
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

function money(n: number): string {
  return new Intl.NumberFormat('en-GB', { maximumFractionDigits: 0 }).format(Math.round(n));
}

/**
 * Every pot of wealth, with its year and its arithmetic.
 *
 * A bucket's `base` and `due` are always the figures as they stand today — an estimate, which
 * is what a year still running is. What is actually owed sits under `confirmed`, and only gets
 * there when the owner has looked at the closed year and said the figure is right.
 */
export function zakatBuckets(db: Db, src: BucketSources): ZakatBucket[] {
  const { now, settings, nisab, owned } = src;
  const paid = paidByYear(db);
  const out: ZakatBucket[] = [];

  const finish = (b: Omit<ZakatBucket, 'base' | 'due' | 'state' | 'confirmed' | 'closedOn'>): ZakatBucket => {
    const base = bucketTotal(b.entries);
    const closedOn = closedOnOf(b.hawl);
    const confirmed = confirmedFor(db, b.id, closedOn, paid);
    return {
      ...b,
      base,
      // Nothing is owed on wealth that never reached the threshold, however long it sat there.
      due: b.aboveNisab ? bucketDue(base) : 0,
      closedOn,
      state: bucketState(closedOn, !!confirmed),
      confirmed,
    };
  };

  // ── cash, shares, what you are owed, and what you owe ────────────────────────────────
  const cashEntries: ZakatEntry[] = [];
  if (src.cash > 0) {
    cashEntries.push({
      id: 'cash', label: 'Cash', sign: 1, amount: src.cash,
      detail: 'every account, converted at today\'s rates',
    });
  }
  if (src.shares > 0) {
    cashEntries.push({
      id: 'shares', label: 'Shares and funds', sign: 1, amount: src.shares,
      detail: 'the book, at the prices last recorded',
    });
  }
  for (const r of src.receivables) {
    cashEntries.push({
      id: `owed-${r.id}`, label: r.label, sign: 1, amount: r.amountEgp,
      detail: r.due ? `expected back ${r.due}` : 'wealth you happen not to be holding',
    });
  }
  if (src.heldBack > 0) {
    cashEntries.push({
      id: 'held-back', label: 'Rent still inside its lunar year', sign: -1, amount: src.heldBack,
      detail: 'it landed in an account, so cash counted it — and it is not owed on yet',
    });
  }
  if (src.deductDebts) {
    for (const d of src.debts) {
      cashEntries.push({
        id: `debt-${d.id}`, label: d.label, sign: -1, amount: d.amountEgp,
        detail: d.kind === 'installment'
          ? (d.date ? `installment due ${d.date}` : 'installment due inside this year')
          : d.kind === 'credit' ? 'a card balance, owed in full today'
            : 'borrowed from a person, owed in full',
      });
    }
  }

  // Things outside zakat go on this list too, at nought, so their absence from the total is
  // something the owner can see rather than something they have to trust.
  for (const l of owned.lines) {
    if (l.basis !== 'none') continue;
    cashEntries.push({
      id: `excluded-${l.id}`, label: l.name, sign: 0, amount: l.value,
      detail: l.intentionLabel, note: l.reason,
    });
  }

  const cashBase = bucketTotal(cashEntries);
  out.push(finish({
    id: 'cash', label: 'Cash, shares and debts', kind: 'cash',
    anchorOn: null,
    hawl: cashHawl(now, settings, src.ledgerSince),
    entries: cashEntries,
    aboveNisab: nisab > 0 && cashBase >= nisab,
  }));

  // ── metal, one year per metal ────────────────────────────────────────────────────────
  for (const metal of ['gold', 'silver'] as const) {
    const lines = owned.metal.lines.filter((l) => l.id.startsWith(`${metal}-`));
    if (!lines.length) continue;
    const holding = lines.find((l) => l.intention === 'investment');
    const entries: ZakatEntry[] = lines.map((l) => ({
      id: l.id, label: l.name, sign: l.included ? 1 : 0, amount: l.value,
      detail: l.intentionLabel,
      note: l.included ? undefined : l.reason,
    }));
    out.push(finish({
      id: metal, label: metal === 'gold' ? 'Gold' : 'Silver', kind: 'metal',
      anchorOn: holding?.anchorOn ?? null,
      hawl: holding?.hawl ?? null,
      entries,
      aboveNisab: holding?.aboveNisab ?? false,
    }));
  }

  // ── each thing held to sell, and each thing let out ──────────────────────────────────
  for (const l of owned.lines) {
    if (l.basis === 'none') continue;
    const rent = l.basis === 'rent';
    out.push(finish({
      id: `${rent ? 'rent' : 'asset'}:${l.id}`,
      label: rent ? `${l.name} — rent` : l.name,
      kind: rent ? 'rent' : 'trade',
      anchorOn: l.anchorOn,
      hawl: l.hawl,
      entries: [{
        id: l.id,
        label: rent ? 'Rent that carried a full lunar year' : l.name,
        // Rent never adds here. It landed in an account, so the cash bucket is already
        // holding it; this bucket exists to say when it became zakatable, not to charge it
        // a second time.
        sign: rent ? 0 : l.included ? 1 : 0,
        amount: rent ? l.counted : l.value,
        detail: rent
          ? `${l.intentionLabel} · the building itself is outside zakat`
          : `${l.intentionLabel} · worth ${money(l.value)} today`,
        note: rent
          ? l.included
            ? 'Charged through cash, where it landed — counted once, not twice.'
            : l.reason
          : l.included ? undefined : l.reason,
      }],
      // Rent is charged in the cash bucket, so this one never owes anything of its own.
      aboveNisab: rent ? false : l.aboveNisab,
    }));
  }

  return out;
}
