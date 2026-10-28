import { describe, expect, test } from 'bun:test';
import { Currency } from '../../src/domain/money/currency';
import { Money } from '../../src/domain/money/money';
import { InsufficientFundsError, InvalidValueError, InvariantViolationError } from '../../src/domain/shared/domain-error';
import { LedgerDirection } from '../../src/domain/wagering/wager-types';
import { Wallet } from '../../src/domain/wallet/wallet';
import { WalletLedgerEntry } from '../../src/domain/wallet/wallet-ledger-entry';

const now = new Date('2026-01-01T00:00:00Z');
const brl = (v: string) => Money.of(v, 'BRL');

describe('Wallet', () => {
  test('opens at version 1 with an opening CREDIT entry when balance > 0', () => {
    const { wallet, openingEntry } = Wallet.open({
      playerId: 'p1',
      currency: 'BRL',
      initialBalance: brl('100.00'),
      openingTransactionId: 'tx-open',
      now,
    });
    expect(wallet.version).toBe(1);
    expect(wallet.balance.amount).toBe('100.00');
    expect(openingEntry?.direction).toBe(LedgerDirection.CREDIT);
    expect(openingEntry?.balanceBefore.amount).toBe('0.00');
    expect(openingEntry?.balanceAfter.amount).toBe('100.00');
    expect(openingEntry?.walletVersion).toBe(1);
  });

  test('zero opening balance creates no ledger entry', () => {
    const { wallet, openingEntry } = Wallet.open({ playerId: 'p1', currency: 'BRL', initialBalance: brl('0.00'), now });
    expect(wallet.version).toBe(1);
    expect(openingEntry).toBeNull();
  });

  test('rejects invalid opening data', () => {
    expect(() =>
      Wallet.open({ playerId: '', currency: 'BRL', initialBalance: brl('1.00'), openingTransactionId: 'x', now }),
    ).toThrow(InvalidValueError);
    expect(() =>
      Wallet.open({ playerId: 'p', currency: 'USD', initialBalance: brl('1.00'), openingTransactionId: 'x', now }),
    ).toThrow(InvalidValueError);
    expect(() => Wallet.open({ playerId: 'p', currency: 'BRL', initialBalance: brl('1.00'), now })).toThrow(
      InvariantViolationError,
    );
  });

  test('debit/credit move the balance, bump version by one and return a closing entry', () => {
    const wallet = Wallet.rehydrate({
      id: 'w1',
      playerId: 'p1',
      currency: Currency.of('BRL'),
      balance: brl('100.00'),
      version: 3,
      createdAt: now,
      updatedAt: now,
    });
    const debit = wallet.debit(brl('80.00'), 'tx1', now);
    expect(wallet.balance.amount).toBe('20.00');
    expect(wallet.version).toBe(4);
    expect(wallet.expectedVersion).toBe(3);
    expect(debit.balanceBefore.amount).toBe('100.00');
    expect(debit.balanceAfter.amount).toBe('20.00');
    expect(debit.walletVersion).toBe(4);

    const credit = wallet.credit(brl('5.50'), 'tx2', now);
    expect(wallet.balance.amount).toBe('25.50');
    expect(wallet.version).toBe(5);
    expect(credit.signedAmount().amount).toBe('5.50');
    expect(debit.signedAmount().amount).toBe('-80.00');
  });

  test('never goes negative; failed debit leaves state untouched', () => {
    const { wallet } = Wallet.open({
      playerId: 'p1',
      currency: 'BRL',
      initialBalance: brl('20.00'),
      openingTransactionId: 'o',
      now,
    });
    expect(wallet.canDebit(brl('20.01'))).toBe(false);
    expect(() => wallet.debit(brl('20.01'), 'tx', now)).toThrow(InsufficientFundsError);
    expect(wallet.balance.amount).toBe('20.00');
    expect(wallet.version).toBe(1);
    wallet.debit(brl('20.00'), 'tx', now);
    expect(wallet.balance.isZero()).toBe(true);
  });

  test('rejects zero/foreign-currency movements', () => {
    const { wallet } = Wallet.open({
      playerId: 'p1',
      currency: 'BRL',
      initialBalance: brl('10.00'),
      openingTransactionId: 'o',
      now,
    });
    expect(() => wallet.credit(brl('0.00'), 'tx', now)).toThrow(InvariantViolationError);
    expect(() => wallet.credit(Money.of('1.00', 'USD'), 'tx', now)).toThrow(InvalidValueError);
    expect(wallet.version).toBe(1);
  });

  test('rehydrate refuses corrupted state', () => {
    const base = { id: 'w', playerId: 'p', currency: Currency.of('BRL'), createdAt: now, updatedAt: now };
    expect(() => Wallet.rehydrate({ ...base, balance: Money.parse('-1.00', 'BRL'), version: 1 })).toThrow(
      InvariantViolationError,
    );
    expect(() => Wallet.rehydrate({ ...base, balance: brl('1.00'), version: 0 })).toThrow(InvariantViolationError);
  });
});

describe('WalletLedgerEntry', () => {
  const base = { walletId: 'w', transactionId: 't', walletVersion: 2, createdAt: now };

  test('validates balanceBefore ± amount = balanceAfter', () => {
    expect(
      WalletLedgerEntry.record({
        ...base,
        direction: 'DEBIT',
        amount: brl('80.00'),
        balanceBefore: brl('100.00'),
        balanceAfter: brl('20.00'),
      }).amount.amount,
    ).toBe('80.00');
    expect(() =>
      WalletLedgerEntry.record({
        ...base,
        direction: 'DEBIT',
        amount: brl('80.00'),
        balanceBefore: brl('100.00'),
        balanceAfter: brl('30.00'),
      }),
    ).toThrow(InvariantViolationError);
    expect(() =>
      WalletLedgerEntry.record({
        ...base,
        direction: 'CREDIT',
        amount: brl('80.00'),
        balanceBefore: brl('100.00'),
        balanceAfter: brl('20.00'),
      }),
    ).toThrow(InvariantViolationError);
  });

  test('rejects non-positive amounts, negative results and bad versions', () => {
    expect(() =>
      WalletLedgerEntry.record({
        ...base,
        direction: 'CREDIT',
        amount: brl('0.00'),
        balanceBefore: brl('1.00'),
        balanceAfter: brl('1.00'),
      }),
    ).toThrow(InvariantViolationError);
    expect(() =>
      WalletLedgerEntry.record({
        ...base,
        direction: 'DEBIT',
        amount: brl('2.00'),
        balanceBefore: brl('1.00'),
        balanceAfter: Money.parse('-1.00', 'BRL'),
      }),
    ).toThrow(InvariantViolationError);
    expect(() =>
      WalletLedgerEntry.record({
        ...base,
        walletVersion: 0,
        direction: 'CREDIT',
        amount: brl('1.00'),
        balanceBefore: brl('0.00'),
        balanceAfter: brl('1.00'),
      }),
    ).toThrow(InvariantViolationError);
  });

  test('is frozen', () => {
    const e = WalletLedgerEntry.record({
      ...base,
      direction: 'CREDIT',
      amount: brl('1.00'),
      balanceBefore: brl('0.00'),
      balanceAfter: brl('1.00'),
    });
    expect(Object.isFrozen(e)).toBe(true);
  });
});
