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
