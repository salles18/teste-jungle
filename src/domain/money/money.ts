import Decimal from 'decimal.js';
import { CurrencyMismatchError, InvalidValueError } from '../shared/domain-error';
import { Currency } from './currency';

/**
 * Isolated decimal.js constructor. Precision is far above what NUMERIC(20,2) can hold,
 * so add/subtract of two-decimal values are always exact. We never divide or multiply,
 * so no rounding mode is ever exercised.
 */
const Dec = Decimal.clone({ precision: 50, rounding: Decimal.ROUND_HALF_EVEN, toExpNeg: -50, toExpPos: 50 });

/** NUMERIC(20,2): at most 18 integer digits. */
const MAX_INTEGER_DIGITS = 18;
const MAX_ABS = new Dec('9'.repeat(MAX_INTEGER_DIGITS)).plus('0.99');

/**
 * Strict decimal grammar: optional '-', no leading zeros, no exponent, no '+',
 * no whitespace, at most two fractional digits.
 */
const STRICT_AMOUNT = /^(-)?(0|[1-9]\d*)(?:\.(\d{1,2}))?$/;

export interface MoneyJSON {
  amount: string;
  currency: string;
}

/**
 * Immutable monetary value. Amounts are exact decimals (never JS numbers) and are
 * always rendered with exactly two decimal places.
 */
export class Money {
  private constructor(
    private readonly value: Decimal,
    readonly currency: Currency,
  ) {
    Object.freeze(this);
  }

  /**
   * Parses an *input* amount (API / queue contract). Negative values are rejected.
   * Accepts 0-2 fractional digits; contracts that demand exactly two decimals
   * enforce it before calling this.
   */
  static of(amount: string, currency: string | Currency): Money {
    const money = Money.parse(amount, currency);
    if (money.isNegative()) {
      throw new InvalidValueError(`Amount must not be negative, got "${amount}"`);
    }
    return money;
  }

  /** Parses a signed amount. Used for values coming from trusted storage or internal math. */
  static parse(amount: string, currency: string | Currency): Money {
    const cur = typeof currency === 'string' ? Currency.of(currency) : currency;
    if (typeof amount !== 'string') {
      throw new InvalidValueError(`Amount must be a decimal string, got ${typeof amount}`);
    }
    const match = STRICT_AMOUNT.exec(amount);
    if (!match) {
      throw new InvalidValueError(`Invalid amount "${amount}": expected a plain decimal with at most 2 decimals`);
    }
    const integerPart = match[2] ?? '';
    if (integerPart.length > MAX_INTEGER_DIGITS) {
      throw new InvalidValueError(`Amount "${amount}" exceeds ${MAX_INTEGER_DIGITS} integer digits`);
    }
    return new Money(new Dec(amount), cur);
  }

  static zero(currency: string | Currency): Money {
    const cur = typeof currency === 'string' ? Currency.of(currency) : currency;
    return new Money(new Dec(0), cur);
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.checked(this.value.plus(other.value), this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.checked(this.value.minus(other.value), this.currency);
  }

  negate(): Money {
    return new Money(this.value.negated(), this.currency);
  }

  isZero(): boolean {
    return this.value.isZero();
  }

  isPositive(): boolean {
    return this.value.greaterThan(0);
  }

  isNegative(): boolean {
    return this.value.lessThan(0);
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.lessThan(other.value);
  }

  isGreaterThanOrEqual(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.greaterThanOrEqualTo(other.value);
  }

  /** Same currency and same numeric amount. Different currencies are simply not equal. */
  equals(other: Money): boolean {
    return this.currency.equals(other.currency) && this.value.equals(other.value);
  }

  hasCurrency(currency: Currency | string): boolean {
    const code = typeof currency === 'string' ? currency : currency.code;
    return this.currency.code === code;
  }

  /** Amount with exactly two decimals, e.g. "20.00" or "-5.10". Never "-0.00". */
  get amount(): string {
    if (this.value.isZero()) return '0.00';
    return this.value.toFixed(Currency.MINOR_UNITS);
  }

  toString(): string {
    return `${this.amount} ${this.currency.code}`;
  }

  toJSON(): MoneyJSON {
    return { amount: this.amount, currency: this.currency.code };
  }

  private assertSameCurrency(other: Money): void {
    if (!this.currency.equals(other.currency)) {
      throw new CurrencyMismatchError(this.currency.code, other.currency.code);
    }
  }

  private static checked(value: Decimal, currency: Currency): Money {
    if (value.abs().greaterThan(MAX_ABS)) {
      throw new InvalidValueError('Monetary overflow: result exceeds NUMERIC(20,2)');
    }
    return new Money(value, currency);
  }
}
