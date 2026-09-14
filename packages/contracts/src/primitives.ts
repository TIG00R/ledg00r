import { z } from 'zod';

/** A calendar day. The ledger never stores a timestamp where a day is what happened. */
export const DateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected yyyy-mm-dd');
export type DateOnly = z.infer<typeof DateOnly>;

export const Currency = z.string().regex(/^[A-Z]{3}$/, 'expected a three-letter code');
export type Currency = z.infer<typeof Currency>;

/**
 * How many decimal places a currency actually has. Money in this ledger is a JavaScript
 * number by decision, so this table is where the rounding rule lives: arithmetic runs at
 * full precision and rounds exactly once, at an edge.
 */
export const MINOR_UNITS: Record<string, number> = {
  EGP: 2, USD: 2, GBP: 2, EUR: 2, SAR: 2, AED: 2, KWD: 3, JPY: 0,
};

export const minorUnits = (currency: string): number => MINOR_UNITS[currency] ?? 2;

/**
 * Round to a currency's minor unit.
 *
 * Called when a figure is written to the database and when it is formatted for a person.
 * Never called in the middle of a calculation — that is what produces a total which
 * disagrees with the sum of its own rows.
 */
export function roundMoney(amount: number, currency: string): number {
  if (!Number.isFinite(amount)) return amount;
  const places = minorUnits(currency);

  /*
   * Shifting the point in the decimal string, rather than multiplying.
   *
   * `1.005 * 100` is 100.49999999999999 in binary, so multiplying first and rounding after
   * gives 1.00 for a figure a person typed as 1.005. Moving the exponent on the number's own
   * decimal text — `1.005e2` — is exact, and is the whole reason this is not one line of
   * arithmetic. Half goes away from zero, which is how money is rounded.
   *
   * A number JavaScript already prints in exponent notation has no decimal text to shift, so
   * those take the arithmetic path. Nothing is lost: the half-cent ambiguity this exists for
   * only arises at magnitudes a person types by hand.
   */
  const round = (n: number) => (n < 0 ? -Math.round(-n) : Math.round(n));
  const text = String(amount);
  if (text.includes('e') || text.includes('E')) {
    const p = 10 ** places;
    return round(amount * p) / p;
  }

  const shifted = Number(`${text}e${places}`);
  if (!Number.isFinite(shifted)) {
    const p = 10 ** places;
    return round(amount * p) / p;
  }
  const back = Number(`${round(shifted)}e${-places}`);
  return Number.isFinite(back) ? back : round(shifted) / 10 ** places;
}

/** A quantity of something that is not money: grams of gold, shares of a company. */
export const Quantity = z.object({ value: z.number().finite(), unit: z.string().max(12) });
export type Quantity = z.infer<typeof Quantity>;

export const MoneyInput = z.object({
  amount: z.number().finite(),
  currency: Currency,
});
export type MoneyInput = z.infer<typeof MoneyInput>;

/** A rate that actually applied, frozen at the moment it did. Never today's rate. */
export const AppliedRate = z.object({
  from: Currency,
  to: Currency,
  value: z.number().positive(),
});
export type AppliedRate = z.infer<typeof AppliedRate>;

export const Cadence = z.enum(['weekly', 'monthly', 'quarterly', 'annually', 'one_off', 'irregular']);
export type Cadence = z.infer<typeof Cadence>;

export const DayOfMonth = z.union([z.number().int().min(1).max(31), z.literal('last')]);
export type DayOfMonth = z.infer<typeof DayOfMonth>;

export const MovementKind = z.enum([
  'income', 'expense', 'transfer', 'exchange', 'installment', 'purchase', 'sale', 'giving', 'correction',
]);
export type MovementKind = z.infer<typeof MovementKind>;

export const NodeKind = z.enum(['cash', 'asset', 'liability', 'external']);
export type NodeKind = z.infer<typeof NodeKind>;
