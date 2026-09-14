/**
 * Zakat on things rather than on money.
 *
 * Cash is simple: you hold it, it counts. Everything else turns on why you hold it. A flat
 * you live in is not wealth being grown, a flat bought to resell is trade stock and counts at
 * what it would fetch, and a flat let out is neither — the building is outside zakat and the
 * rent it throws off is what can be owed on. A car is the same argument with a smaller
 * number. Gold worn by a woman is not a holding at all.
 *
 * So an asset's treatment is decided by four things, in this order: what kind of thing it is,
 * what it is held for, whether the amount in question ever reached nisab, and whether a full
 * lunar year has run since it did. All four are needed — which is why every asset here
 * carries dates, and why the dates are reckoned in the lunar calendar rather than the one the
 * rest of the ledger runs on.
 *
 * Nothing in this file reads a database or a clock. It takes what is owned, the threshold in
 * force and the moment to judge it at, and answers with a line per asset saying what it
 * counted and why.
 */

import { toHijri, fromHijri, addHijriYears, formatHijri, type HijriDate } from './hijri.js';

export type AssetClass = 'property' | 'vehicle' | 'metal' | 'other';

/** Why a thing is held. The answer decides whether zakat reaches it at all. */
export type Intention =
  | 'live_in'     // property: a home
  | 'rent'        // property or vehicle: let out
  | 'sale'        // property or vehicle: bought to resell — trade stock
  | 'personal'    // vehicle: driven; metal: worn
  | 'investment'; // metal: held as a store of value

export interface IntentionOption {
  id: Intention;
  label: string;
  /** the sentence shown under the option, so the rule is read where the choice is made */
  blurb: string;
}

/**
 * The options each kind of asset offers, and the words under them.
 *
 * They are here rather than in the interface because they are the rule, not the wording of a
 * screen: what the option means is exactly what the calculation below does with it.
 */
export const INTENTIONS: Record<AssetClass, IntentionOption[]> = {
  property: [
    { id: 'live_in', label: 'To live in',
      blurb: 'A home is not wealth being grown. No zakat is owed on it, however much it is worth.' },
    { id: 'rent', label: 'To rent out',
      blurb: 'The building itself stays outside zakat. Only the rent it earns is reached — and only once that rent has passed nisab and a full lunar year has run over it.' },
    { id: 'sale', label: 'To sell',
      blurb: 'Bought to resell, so it is trade stock: its whole market value counts, once it has passed nisab and a full lunar year has run since you intended to sell it.' },
  ],
  vehicle: [
    { id: 'personal', label: 'Personal use',
      blurb: 'A car you drive is a possession, not a holding. No zakat is owed on it.' },
    { id: 'rent', label: 'Rented out',
      blurb: 'The car itself is outside zakat. Only what it earns is reached — and only once that income has passed nisab and a full lunar year has run over it.' },
    { id: 'sale', label: 'Held to sell',
      blurb: 'Bought to resell, so it counts as trade stock at what it would fetch, once it has passed nisab and a full lunar year has run since you intended to sell it.' },
  ],
  metal: [
    { id: 'personal', label: 'Worn — a woman\'s jewellery',
      blurb: 'Jewellery in ordinary use is not a holding on the position this ledger follows, so no zakat is owed on it.' },
    { id: 'investment', label: 'Held as a holding',
      blurb: 'Kept as a store of value, so it is zakatable at its weight in the market — once it has passed nisab and a full lunar year has run over it.' },
  ],
  other: [
    { id: 'personal', label: 'Personal use',
      blurb: 'Something you use rather than hold to grow. No zakat is owed on it.' },
    { id: 'rent', label: 'Earns an income',
      blurb: 'The thing itself is outside zakat; what it earns is reached once that income has passed nisab and a full lunar year has run over it.' },
    { id: 'sale', label: 'Held to sell',
      blurb: 'Trade stock: it counts at what it would fetch, once it has passed nisab and a full lunar year has run over it.' },
  ],
};

export function intentionsFor(kind: string): IntentionOption[] {
  return INTENTIONS[(kind as AssetClass)] ?? INTENTIONS.other;
}

export function defaultIntention(kind: string): Intention {
  return kind === 'property' ? 'live_in' : kind === 'metal' ? 'investment' : 'personal';
}

export function intentionLabel(kind: string, intention: Intention | null | undefined): string {
  const opt = intentionsFor(kind).find((o) => o.id === intention);
  return opt?.label ?? 'Not stated';
}

// ── the lunar year ───────────────────────────────────────────────────────────────────

export interface Hawl {
  /** the day the count started: when this wealth first passed nisab */
  startOn: string;
  startHijri: HijriDate;
  startHijriText: string;
  /** a lunar year later, which is when zakat falls due on it */
  dueOn: string;
  dueHijri: HijriDate;
  dueHijriText: string;
  /** whole lunar years completed since the count started */
  yearsComplete: number;
  complete: boolean;
  daysRemaining: number;
  elapsedPct: number;
}

const DAY = 86_400_000;
const iso = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/**
 * The lunar year running from an anchor date.
 *
 * `yearsComplete` is what says whether anything is owed yet: nought means the first year is
 * still running, one means a hawl has closed and zakat fell due on the anniversary. The
 * window reported is always the one in progress, so a screen can show a countdown rather than
 * a date that has already gone.
 */
export function hawlFrom(anchorIso: string, now: Date): Hawl | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(anchorIso)) return null;
  const anchor = new Date(`${anchorIso}T12:00:00`);
  if (Number.isNaN(anchor.getTime())) return null;
  const anchorHijri = toHijri(anchor);

  let years = 0;
  while (years < 200 && fromHijri(addHijriYears(anchorHijri, years + 1)) <= now) years += 1;

  const startHijri = addHijriYears(anchorHijri, years);
  const dueHijri = addHijriYears(anchorHijri, years + 1);
  const start = years === 0 ? anchor : fromHijri(startHijri);
  const due = fromHijri(dueHijri);
  const span = Math.max(1, Math.round((due.getTime() - start.getTime()) / DAY));
  const remaining = Math.max(0, Math.ceil((due.getTime() - now.getTime()) / DAY));

  return {
    startOn: iso(start), startHijri, startHijriText: formatHijri(startHijri),
    dueOn: iso(due), dueHijri, dueHijriText: formatHijri(dueHijri),
    yearsComplete: years,
    complete: years >= 1,
    daysRemaining: remaining,
    elapsedPct: Math.min(100, Math.max(0, ((span - remaining) / span) * 100)),
  };
}

// ── rent, which is a flow rather than a holding ──────────────────────────────────────

export interface Receipt { date: string; amountEgp: number }

export interface RentPot {
  /** the day the running total first reached nisab, and so the day the count starts */
  anchorOn: string | null;
  /** received inside the year now running */
  accruing: number;
  /** received inside the last year that closed, which is what zakat is owed on */
  dueWindow: number;
  /** everything received since the count started */
  received: number;
  hawl: Hawl | null;
}

/**
 * What a let asset has actually earned, and where in the lunar year it sits.
 *
 * Rent is a flow, so the question is not what it is worth today but what came in and when.
 * The count starts the day the running total first reaches nisab — before that there is
 * nothing for a year to run over — and each lunar anniversary closes a window. The window
 * that has closed is what is owed on; the one still running is not owed on yet, and this is
 * the distinction the base has to respect or it charges a year early.
 */
export function rentPot(receipts: Receipt[], nisab: number, now: Date): RentPot {
  const rows = receipts
    .filter((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.date) && r.amountEgp > 0)
    .sort((a, b) => a.date.localeCompare(b.date));

  let running = 0;
  let anchorOn: string | null = null;
  for (const r of rows) {
    running += r.amountEgp;
    if (!anchorOn && nisab > 0 && running >= nisab) anchorOn = r.date;
  }

  const received = running;
  if (!anchorOn) return { anchorOn: null, accruing: received, dueWindow: 0, received, hawl: null };

  const hawl = hawlFrom(anchorOn, now);
  if (!hawl) return { anchorOn, accruing: received, dueWindow: 0, received, hawl: null };

  const inWindow = (from: string, to: string) => rows
    .filter((r) => r.date >= from && r.date < to)
    .reduce((s, r) => s + r.amountEgp, 0);

  const anchorHijri = toHijri(new Date(`${anchorOn}T12:00:00`));
  const closedFrom = hawl.yearsComplete >= 1
    ? iso(fromHijri(addHijriYears(anchorHijri, hawl.yearsComplete - 1)))
    : null;

  return {
    anchorOn,
    accruing: inWindow(hawl.startOn, hawl.dueOn),
    dueWindow: closedFrom ? inWindow(closedFrom, hawl.startOn) : 0,
    received,
    hawl,
  };
}

// ── metal, whose whole history of weights is on record ───────────────────────────────

export interface MetalLot { date: string; grams: number; direction: 'buy' | 'sell'; intention?: Intention | null }

export interface MetalBucket {
  intention: Intention;
  grams: number;
  /** the day the held weight first reached nisab and has stayed there since */
  anchorOn: string | null;
  hawl: Hawl | null;
}

/**
 * Weight held, split by why it is held, with the day the zakatable part passed nisab.
 *
 * Metal is the one holding whose whole history is in the ledger, lot by lot, so the day it
 * crossed the threshold is not a setting anybody has to remember — it can be read off the
 * record. Selling back below nisab restarts the count, which is the rule: the year runs over
 * wealth that stayed above the threshold, not over wealth that once touched it.
 */
export function metalBuckets(lots: MetalLot[], nisabGrams: number, now: Date): MetalBucket[] {
  const rows = lots
    .filter((l) => /^\d{4}-\d{2}-\d{2}$/.test(l.date) && l.grams > 0)
    .sort((a, b) => a.date.localeCompare(b.date));

  const held: Record<string, number> = {};
  const anchors: Record<string, string | null> = {};

  for (const l of rows) {
    const key = l.intention === 'personal' ? 'personal' : 'investment';
    held[key] = (held[key] ?? 0) + (l.direction === 'sell' ? -l.grams : l.grams);
    if (held[key] < 0) held[key] = 0;
    if (key !== 'investment') continue;
    if (nisabGrams > 0 && held[key] >= nisabGrams) anchors[key] ??= l.date;
    else anchors[key] = null;
  }

  return (['investment', 'personal'] as Intention[]).map((intention) => {
    const grams = held[intention] ?? 0;
    const anchorOn = intention === 'investment' ? anchors.investment ?? null : null;
    return { intention, grams, anchorOn, hawl: anchorOn ? hawlFrom(anchorOn, now) : null };
  });
}

// ── one line per asset ───────────────────────────────────────────────────────────────

export interface AssetForZakat {
  id: string;
  name: string;
  kind: AssetClass;
  intention: Intention | null;
  /** what it would fetch today, in the ledger's currency */
  value: number;
  acquiredOn?: string | null;
  /** the day this intention was set — a change of mind restarts the year */
  intentionSince?: string | null;
  /** the day its value passed nisab, when that is later than the intention */
  nisabMetOn?: string | null;
  /** rent it has earned, when it is let */
  rent?: RentPot | null;
}

export interface ZakatLine {
  id: string;
  name: string;
  kind: AssetClass;
  intention: Intention | null;
  intentionLabel: string;
  /** what the line is charged on: the thing itself, what it earns, or nothing */
  basis: 'value' | 'rent' | 'none';
  value: number;
  /** what this line actually adds to the base */
  counted: number;
  included: boolean;
  /** rent earned but not yet zakatable, which must not be counted through cash either */
  heldBack: number;
  aboveNisab: boolean;
  hawl: Hawl | null;
  anchorOn: string | null;
  dates: { acquiredOn: string | null; intentionSince: string | null; nisabMetOn: string | null };
  /** one sentence saying why this line reads the way it does */
  reason: string;
}

function money(n: number): string {
  return new Intl.NumberFormat('en-GB', { maximumFractionDigits: 0 }).format(Math.round(n));
}

/**
 * One asset, judged.
 *
 * The order is the order of the rule: what it is, what it is for, whether the amount reached
 * nisab, and whether a lunar year has run since it did. A line that fails any of the four
 * counts nothing and says which one it failed on.
 */
export function assessAsset(a: AssetForZakat, opts: { now: Date; nisab: number }): ZakatLine {
  const { now, nisab } = opts;
  const intention = a.intention ?? defaultIntention(a.kind);
  const label = intentionLabel(a.kind, intention);
  const dates = {
    acquiredOn: a.acquiredOn ?? null,
    intentionSince: a.intentionSince ?? null,
    nisabMetOn: a.nisabMetOn ?? null,
  };
  const bare = {
    id: a.id, name: a.name, kind: a.kind, intention, intentionLabel: label,
    value: a.value, dates,
  };

  if (intention === 'live_in' || intention === 'personal') {
    return {
      ...bare, basis: 'none', counted: 0, included: false, heldBack: 0,
      aboveNisab: false, hawl: null, anchorOn: null,
      reason: a.kind === 'metal'
        ? 'Worn rather than held, so it is outside zakat.'
        : a.kind === 'property'
          ? 'Held to live in, so the property itself is outside zakat.'
          : 'Personal use, so it is outside zakat.',
    };
  }

  if (intention === 'rent') {
    const pot = a.rent ?? { anchorOn: null, accruing: 0, dueWindow: 0, received: 0, hawl: null };
    const aboveNisab = pot.received >= nisab && nisab > 0;
    const counted = pot.dueWindow >= nisab ? pot.dueWindow : 0;
    const heldBack = pot.accruing + (pot.dueWindow >= nisab ? 0 : pot.dueWindow);
    // the thing named as it is: a car is not a building, and reading "the building" against a
    // car is the kind of wrong wording that makes an owner distrust the figure beside it
    const itself = a.kind === 'property' ? 'The building'
      : a.kind === 'vehicle' ? 'The car itself' : 'The thing itself';
    const reason = !pot.anchorOn
      ? `${itself} is outside zakat. What it has earned, ${money(pot.received)}, has not reached nisab, so nothing is owed on it yet.`
      : !pot.hawl?.complete
        ? `${itself} is outside zakat. What it earns passed nisab on ${pot.anchorOn}; the lunar year over it closes in ${pot.hawl?.daysRemaining ?? 0} days.`
        : counted > 0
          ? `${itself} is outside zakat. ${money(counted)} of what it earned completed a full lunar year, so that is what counts.`
          : `${itself} is outside zakat. The year that closed carried ${money(pot.dueWindow)}, which is under nisab.`;
    return {
      ...bare, basis: 'rent', counted, included: counted > 0, heldBack,
      aboveNisab, hawl: pot.hawl ?? null, anchorOn: pot.anchorOn, reason,
    };
  }

  // Held to sell: trade stock, charged at what it would fetch today.
  const anchorOn = dates.nisabMetOn ?? dates.intentionSince ?? dates.acquiredOn ?? null;
  const hawl = anchorOn ? hawlFrom(anchorOn, now) : null;
  const aboveNisab = nisab > 0 && a.value >= nisab;
  const included = aboveNisab && !!hawl?.complete;
  return {
    ...bare, basis: 'value', counted: included ? a.value : 0, included, heldBack: 0,
    aboveNisab, hawl, anchorOn,
    reason: !anchorOn
      ? 'Held to sell, so its value counts — but no date is recorded for the intention, so the lunar year cannot be worked out.'
      : !aboveNisab
        ? `Held to sell, but ${money(a.value)} is under the nisab of ${money(nisab)}.`
        : hawl?.complete
          ? `Held to sell since ${anchorOn}, above nisab, and a full lunar year has run — so its whole value counts.`
          : `Held to sell since ${anchorOn}. The first lunar year closes in ${hawl?.daysRemaining ?? 0} days, and nothing is owed until it does.`,
  };
}

export function assessAssets(assets: AssetForZakat[], opts: { now: Date; nisab: number }): ZakatLine[] {
  return assets.map((a) => assessAsset(a, opts));
}
