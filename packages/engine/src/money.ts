import type { Currency, MarketState } from './types.js';

/** fxRates are EGP per one unit of the currency; EGP itself is 1. */
export function toEgp(amount: number, currency: Currency, m: MarketState): number {
  if (currency === 'EGP') return amount;
  const rate = m.fxRates[currency];
  // An unknown currency converts at 1 rather than silently vanishing — F-139's behaviour,
  // kept, but the caller can see it because `rateKnown` says so.
  return amount * (rate ?? 1);
}

export function rateKnown(currency: Currency, m: MarketState): boolean {
  return currency === 'EGP' || m.fxRates[currency] != null;
}

export function fromEgp(egp: number, currency: Currency, m: MarketState): number {
  if (currency === 'EGP') return egp;
  return egp / (m.fxRates[currency] ?? 1);
}

export const SYMBOLS: Record<string, string> = {
  USD: '$', EGP: 'E£', GBP: '£', EUR: '€', SAR: '﷼', AED: 'د.إ',
};

export function money(amount: number, currency: Currency, dp = 0): string {
  const sym = SYMBOLS[currency] ?? '';
  const n = amount.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
  // a thin gap keeps the mark from colliding with the first digit at tabular widths
  return sym ? `${sym}\u2009${n}` : `${n} ${currency}`;
}

/**
 * The other half of what a holding is worth: not what it is worth, but what the money that
 * bought it would be worth now, had it simply stayed in the currency it started in.
 *
 * Income mostly arrives in dollars here, and buying gold or a share means turning some of it
 * into pounds first. The gold can be up in pounds while the dollar that bought it went up
 * more — a loss wearing a gain's clothes, because a holding compared only against its own
 * currency cannot see the currency it was bought out of. `rate` is frozen the day the money
 * left the account, in the one convention this ledger keeps everywhere else: EGP per unit of
 * the currency — the same freezing a debt already does, for the same reason.
 *
 * Null in, null out: a holding with nothing recorded — bought before this was tracked, or
 * with no named account at all — gets no comparison rather than an invented one.
 */
export interface SourceMoney { currency: string; amount: number; rate: number }
export interface SourceComparison {
  sourceCurrency: string;
  sourceAmount: number;
  /** EGP per unit of the currency, the day the money left the account */
  sourceRateThen: number;
  /** the same, read today */
  sourceRateNow: number;
  /** what the source money would be worth now, had it simply stayed put */
  sourceValueNowEgp: number;
  /** the holding's own value now, less what the source money would be worth now */
  sourceDiffEgp: number;
  /** the same difference, as a share of what the source money would be worth now */
  sourceDiffPct: number;
}

export function compareToSource(
  source: SourceMoney | null | undefined,
  holdingValueEgp: number,
  m: Pick<MarketState, 'fxRates'>,
): SourceComparison | null {
  if (!source || !source.currency || !(source.amount > 0) || !(source.rate > 0)) return null;
  const { currency, amount, rate } = source;
  const rateNow = currency === 'EGP' ? 1 : (m.fxRates[currency] ?? rate);
  const sourceValueNowEgp = amount * rateNow;
  return {
    sourceCurrency: currency, sourceAmount: amount, sourceRateThen: rate, sourceRateNow: rateNow,
    sourceValueNowEgp,
    sourceDiffEgp: holdingValueEgp - sourceValueNowEgp,
    sourceDiffPct: sourceValueNowEgp !== 0 ? (holdingValueEgp - sourceValueNowEgp) / sourceValueNowEgp : 0,
  };
}

export interface CurrencySplit { currency: Currency; amount: number; egp: number }

/**
 * Groups records by the currency they were actually recorded in.
 * A total alone hides that half of it was paid in dollars; the split does not.
 */
export function splitByCurrency<T>(
  rows: T[],
  pick: (r: T) => { amount: number; currency: Currency } | null,
  m: MarketState,
): { splits: CurrencySplit[]; totalEgp: number } {
  const by = new Map<Currency, number>();
  for (const r of rows) {
    const v = pick(r);
    if (!v || !v.amount) continue;
    by.set(v.currency, (by.get(v.currency) ?? 0) + v.amount);
  }
  const splits = [...by.entries()]
    .map(([currency, amount]) => ({ currency, amount, egp: toEgp(amount, currency, m) }))
    .sort((a, b) => b.egp - a.egp);
  return { splits, totalEgp: splits.reduce((s, x) => s + x.egp, 0) };
}
