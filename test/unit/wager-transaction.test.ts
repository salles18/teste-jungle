import { describe, expect, test } from 'bun:test';
import { Money } from '../../src/domain/money/money';
import { InvalidStateTransitionError, InvalidValueError } from '../../src/domain/shared/domain-error';
import { type CreateWagerTransactionInput, WagerTransaction } from '../../src/domain/wagering/wager-transaction';
import {
  FailureCode,
  LedgerDirection,
  type SubmittableKind,
  TransactionKind,
  TransactionStatus,
} from '../../src/domain/wagering/wager-types';

const now = new Date('2026-01-01T00:00:00Z');
const HASH = 'a'.repeat(64);

function make(kind: SubmittableKind, overrides: Partial<CreateWagerTransactionInput> = {}): WagerTransaction {
  return WagerTransaction.create({
    providerId: 'prov',
    externalTransactionId: `${kind}-1`,
    idempotencyKey: `key-${kind}`,
    payloadHash: HASH,
    walletId: 'w1',
    playerId: 'p1',
    roundId: 'r1',
    gameId: 'g1',
    kind,
    money: Money.of('10.00', 'BRL'),
    referenceExternalTransactionId: kind === 'REFUND' || kind === 'ROLLBACK' ? 'BET-1' : null,
    correlationId: null,
    now,
    ...overrides,
  });
}

function processed(tx: WagerTransaction): WagerTransaction {
  tx.markProcessed({
    balanceAfter: Money.of('1.00', 'BRL'),
    walletVersion: 2,
    referenceTransactionId: tx.hasReference() ? 'ref' : null,
    now,
  });
  return tx;
}

describe('WagerTransaction', () => {
  test('starts PENDING and exposes classification helpers', () => {
    const bet = make('BET');
    expect(bet.status).toBe(TransactionStatus.PENDING);
    expect(bet.isTerminal()).toBe(false);
    expect(bet.affectsBalance()).toBe(true);
    expect(bet.requiresReference()).toBe(false);
    expect(make('LOSS', { money: Money.of('0.00', 'BRL') }).affectsBalance()).toBe(false);
    expect(make('REFUND').requiresReference()).toBe(true);
    expect(make('ROLLBACK').requiresReference()).toBe(true);
    expect(bet.matchesPayload(HASH)).toBe(true);
    expect(bet.matchesPayload('b'.repeat(64))).toBe(false);
  });

  test('OPENING cannot be submitted; system provider is reserved', () => {
    expect(() => make('OPENING' as SubmittableKind)).toThrow(InvalidValueError);
    expect(() => make('BET', { providerId: 'system' })).toThrow(InvalidValueError);
  });

  test('creation rules', () => {
    expect(() => make('BET', { money: Money.of('0.00', 'BRL') })).toThrow(InvalidValueError);
    expect(() => make('REFUND', { referenceExternalTransactionId: null })).toThrow(InvalidValueError);
    expect(() => make('BET', { referenceExternalTransactionId: 'x' })).toThrow(InvalidValueError);
    expect(() => make('WIN', { referenceExternalTransactionId: 'WIN-1' })).toThrow(InvalidValueError);
    expect(() => make('BET', { payloadHash: 'nothex' })).toThrow(InvalidValueError);
    expect(make('LOSS', { money: Money.of('0.00', 'BRL') }).money.isZero()).toBe(true);
  });

  test('ledger direction per kind; ROLLBACK inverts its reference', () => {
    const bet = make('BET');
    const win = make('WIN');
    const refund = make('REFUND');
    expect(bet.ledgerDirectionFor(null)).toBe(LedgerDirection.DEBIT);
    expect(win.ledgerDirectionFor(null)).toBe(LedgerDirection.CREDIT);
    expect(refund.ledgerDirectionFor(null)).toBe(LedgerDirection.CREDIT);
    expect(make('LOSS').ledgerDirectionFor(null)).toBeNull();
    const rollback = make('ROLLBACK');
    expect(rollback.ledgerDirectionFor(bet)).toBe(LedgerDirection.CREDIT);
    expect(rollback.ledgerDirectionFor(win)).toBe(LedgerDirection.DEBIT);
    expect(rollback.ledgerDirectionFor(refund)).toBe(LedgerDirection.DEBIT);
  });

  test('terminal states are final', () => {
    for (const finish of [
      (t: WagerTransaction) => processed(t),
      (t: WagerTransaction) =>
        t.markRejected({ failureCode: FailureCode.INSUFFICIENT_FUNDS, balance: Money.of('0.00', 'BRL'), walletVersion: 1, now }),
      (t: WagerTransaction) => t.markFailed({ failureCode: FailureCode.INTERNAL_INVARIANT_VIOLATION, now }),
    ]) {
      const tx = make('BET');
      finish(tx);
      expect(tx.isTerminal()).toBe(true);
      expect(() => processed(tx)).toThrow(InvalidStateTransitionError);
      expect(() =>
        tx.markRejected({ failureCode: FailureCode.INSUFFICIENT_FUNDS, balance: Money.of('0.00', 'BRL'), walletVersion: 1, now }),
      ).toThrow(InvalidStateTransitionError);
      expect(() => tx.markFailed({ failureCode: FailureCode.INTERNAL_INVARIANT_VIOLATION, now })).toThrow(
        InvalidStateTransitionError,
      );
    }
  });

  test('PENDING_REFERENCE counts attempts, keeps the first deadline, then can finish', () => {
    const tx = make('REFUND');
    const deadline = new Date(now.getTime() + 60_000);
    tx.markPendingReference({ nextCheckAt: new Date(now.getTime() + 1000), deadlineAt: deadline, now });
    expect(tx.status).toBe(TransactionStatus.PENDING_REFERENCE);
    expect(tx.referenceAttempts).toBe(1);
    tx.markPendingReference({ nextCheckAt: new Date(now.getTime() + 2000), deadlineAt: new Date(now.getTime() + 999_999), now });
    expect(tx.referenceAttempts).toBe(2);
    expect(tx.referenceDeadlineAt?.getTime()).toBe(deadline.getTime());
    processed(tx);
    expect(tx.status).toBe(TransactionStatus.PROCESSED);
    expect(tx.nextReferenceCheckAt).toBeNull();
  });

  test('a transaction without reference cannot wait for one', () => {
    expect(() => make('BET').markPendingReference({ nextCheckAt: now, deadlineAt: now, now })).toThrow();
  });

  test('processed snapshot carries the observed balance', () => {
    const tx = processed(make('BET'));
    expect(tx.resultBalance?.amount).toBe('1.00');
    expect(tx.resultWalletVersion).toBe(2);
    expect(tx.processedAt).toEqual(now);
  });

  test('rehydrate restores a terminal row without re-running transitions', () => {
    const tx = processed(make('BET'));
    const copy = WagerTransaction.rehydrate({
      id: tx.id,
      providerId: tx.providerId,
      externalTransactionId: tx.externalTransactionId,
      idempotencyKey: tx.idempotencyKey,
      payloadHash: tx.payloadHash,
      walletId: tx.walletId,
      playerId: tx.playerId,
      roundId: tx.roundId,
      gameId: tx.gameId,
      kind: TransactionKind.BET,
      money: tx.money,
      referenceExternalTransactionId: null,
      referenceTransactionId: null,
      status: TransactionStatus.PROCESSED,
      failureCode: null,
      resultBalance: tx.resultBalance,
      resultWalletVersion: 2,
      referenceAttempts: 0,
      nextReferenceCheckAt: null,
      referenceDeadlineAt: null,
      correlationId: null,
      processedAt: now,
      createdAt: now,
      updatedAt: now,
    });
    expect(copy.status).toBe(TransactionStatus.PROCESSED);
    expect(copy.isTerminal()).toBe(true);
  });
});
