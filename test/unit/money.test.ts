import { describe, expect, test } from 'bun:test';
import { Currency } from '../../src/domain/money/currency';
import { Money } from '../../src/domain/money/money';
import { CurrencyMismatchError, InvalidValueError } from '../../src/domain/shared/domain-error';

describe('Money', () => {
  test('always renders exactly two decimals', () => {
    expect(Money.of('80', 'BRL').amount).toBe('80.00');
    expect(Money.of('80.5', 'BRL').amount).toBe('80.50');
    expect(Money.of('0.01', 'BRL').amount).toBe('0.01');
    expect(Money.zero('BRL').amount).toBe('0.00');
    expect(Money.of('100.00', 'BRL').toJSON()).toEqual({ amount: '100.00', currency: 'BRL' });
    expect(Money.of('1.10', 'USD').toString()).toBe('1.10 USD');
  });

  test.each([
    ['', 'empty'],
    [' 1.00', 'leading space'],
    ['1.00 ', 'trailing space'],
    ['1e2', 'scientific notation'],
    ['1E2', 'scientific notation upper'],
    ['NaN', 'NaN'],
    ['Infinity', 'Infinity'],
    ['-Infinity', '-Infinity'],
    ['+1.00', 'explicit plus'],
    ['01.00', 'leading zero'],
    ['1.', 'dangling point'],
    ['.50', 'missing integer part'],
    ['1.001', 'three decimals'],
    ['1,00', 'comma decimal'],
    ['0x10', 'hex'],
    ['1_000.00', 'separator'],
    ['1234567890123456789.00', '19 integer digits (exceeds NUMERIC(20,2))'],
  ])('rejects %p (%s)', (input) => {
    expect(() => Money.of(input, 'BRL')).toThrow(InvalidValueError);
  });

  test('rejects non-string input (numbers never enter the money path)', () => {
    expect(() => Money.of(80 as unknown as string, 'BRL')).toThrow(InvalidValueError);
  });

  test('input contract rejects negatives, internal parse accepts them', () => {
    expect(() => Money.of('-1.00', 'BRL')).toThrow(InvalidValueError);
    expect(Money.parse('-1.00', 'BRL').isNegative()).toBe(true);
  });

  test('exact decimal arithmetic (no float drift)', () => {
    const a = Money.of('0.10', 'BRL');
    const b = Money.of('0.20', 'BRL');
    expect(a.add(b).amount).toBe('0.30');
    expect(Money.of('100.00', 'BRL').subtract(Money.of('80.00', 'BRL')).amount).toBe('20.00');
    expect(Money.of('20.00', 'BRL').subtract(Money.of('80.00', 'BRL')).amount).toBe('-60.00');
    expect(Money.of('999999999999999999.99', 'BRL').subtract(Money.of('0.01', 'BRL')).amount).toBe('999999999999999999.98');
  });

  test('overflow beyond NUMERIC(20,2) is an error, not a rounding', () => {
    const max = Money.of('999999999999999999.99', 'BRL');
    expect(() => max.add(Money.of('0.01', 'BRL'))).toThrow(InvalidValueError);
  });

  test('negate / predicates / comparison', () => {
    const m = Money.of('5.00', 'BRL');
    expect(m.negate().amount).toBe('-5.00');
    expect(m.negate().negate().equals(m)).toBe(true);
    expect(Money.zero('BRL').negate().amount).toBe('0.00');
    expect(m.isPositive()).toBe(true);
    expect(m.isZero()).toBe(false);
    expect(m.isNegative()).toBe(false);
    expect(Money.zero('BRL').isZero()).toBe(true);
    expect(m.isLessThan(Money.of('5.01', 'BRL'))).toBe(true);
    expect(m.isLessThan(Money.of('5.00', 'BRL'))).toBe(false);
    expect(m.isGreaterThanOrEqual(Money.of('5.00', 'BRL'))).toBe(true);
  });

  test('immutability', () => {
    const m = Money.of('10.00', 'BRL');
    const sum = m.add(Money.of('1.00', 'BRL'));
    expect(m.amount).toBe('10.00');
    expect(sum.amount).toBe('11.00');
    expect(Object.isFrozen(m)).toBe(true);
    expect(() => {
      (m as unknown as { currency: unknown }).currency = Currency.of('USD');
    }).toThrow();
  });

  test('currencies: mixing is rejected, equality is currency-aware', () => {
    const brl = Money.of('1.00', 'BRL');
    const usd = Money.of('1.00', 'USD');
    expect(() => brl.add(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl.subtract(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl.isLessThan(usd)).toThrow(CurrencyMismatchError);
    expect(brl.equals(usd)).toBe(false);
    expect(brl.equals(Money.of('1.0', 'BRL'))).toBe(true);
  });

  test('currency validation is ISO-4217 shaped and limited to 2-decimal currencies', () => {
    expect(Currency.of('EUR').code).toBe('EUR');
    expect(() => Currency.of('brl')).toThrow(InvalidValueError);
    expect(() => Currency.of('BR')).toThrow(InvalidValueError);
    expect(() => Currency.of('XXX')).toThrow(InvalidValueError);
    expect(() => Currency.of('JPY')).toThrow(InvalidValueError);
  });
});
