import { minorUnits, roundMoney, type Currency } from '@ledger/contracts';

/**
 * An amount and the currency it is in, together.
 *
 * Money in this ledger is a JavaScript number by decision, so the type system will not stop
 * a figure in dollars being added to one in pounds. This class does: the two arithmetic
 * operations refuse a mismatch, and the only way to change currency is to name the rate that
 * applied.
 *
 * Rounding happens once, at an edge — `round()` before persisting, `format()` before showing.
 * Nothing here rounds in the middle, because a total that has been rounded twice no longer
 * equals the sum of its rows.
 */
export class Money {
  private constructor(readonly amount: number, readonly currency: Currency) {}

  static of(amount: number, currency: Currency): Money {
    if (!Number.isFinite(amount)) throw new TypeError(`${amount} is not an amount`);
    return new Money(amount, currency);
  }

  static zero(currency: Currency): Money {
    return new Money(0, currency);
  }

  plus(other: Money): Money {
    this.assertSame(other);
    return new Money(this.amount + other.amount, this.currency);
  }

  minus(other: Money): Money {
    this.assertSame(other);
    return new Money(this.amount - other.amount, this.currency);
  }

  times(factor: number): Money {
    return new Money(this.amount * factor, this.currency);
  }

  /** Converting says which rate did it, so the record can be read back years later. */
  convert(to: Currency, rate: number): Money {
    if (!(rate > 0)) throw new TypeError('a rate has to be positive');
    if (to === this.currency) return this;
    return new Money(this.amount * rate, to);
  }

  /** The rounding boundary. Call before writing to storage, and nowhere else. */
  round(): Money {
    return new Money(roundMoney(this.amount, this.currency), this.currency);
  }

  isZero(): boolean { return Math.abs(this.amount) < 10 ** -(minorUnits(this.currency) + 2); }
  isNegative(): boolean { return this.amount < 0 && !this.isZero(); }
  gt(other: Money): boolean { this.assertSame(other); return this.amount > other.amount; }
  gte(other: Money): boolean { this.assertSame(other); return this.amount >= other.amount; }

  toJSON() { return { amount: this.round().amount, currency: this.currency }; }

  private assertSame(other: Money): void {
    if (other.currency !== this.currency) {
      throw new TypeError(`${this.currency} and ${other.currency} do not add up — convert one first`);
    }
  }
}
