import { describe, expect, test } from 'bun:test';
import { Currency } from '../../src/domain/money/currency';
import { Money } from '../../src/domain/money/money';
import { RetryPolicy } from '../../src/domain/shared/retry-policy';
import { type ReferenceWaitPolicy, settleWagerTransaction } from '../../src/domain/wagering/wager-settlement';
import { type CreateWagerTransactionInput, WagerTransaction } from '../../src/domain/wagering/wager-transaction';
import {
  ALL_FAILURE_CODES,
  FailureCode,
  LedgerDirection,
  type SubmittableKind,
  TransactionStatus,
} from '../../src/domain/wagering/wager-types';
import { Wallet } from '../../src/domain/wallet/wallet';

const now = new Date('2026-01-01T00:00:00Z');
const brl = (v: string) => Money.of(v, 'BRL');
const waitPolicy: ReferenceWaitPolicy = {
  retry: new RetryPolicy({ maxAttempts: 3, baseDelayMs: 1000, maxDelayMs: 10_000, jitterRatio: 0 }),
  ttlMs: 60_000,
};

function wallet(balance: string): Wallet {
  return Wallet.rehydrate({
    id: 'w1',
    playerId: 'p1',
    currency: Currency.of('BRL'),
    balance: brl(balance),
    version: 1,
    createdAt: now,
    updatedAt: now,
  });
}

let n = 0;
function tx(
  kind: SubmittableKind,
  amount: string,
  ref: string | null = null,
  overrides: Partial<CreateWagerTransactionInput> = {},
) {
  n++;
  return WagerTransaction.create({
    providerId: 'prov',
    externalTransactionId: `${kind}-${n}`,
    idempotencyKey: `key-${n}`,
    payloadHash: 'a'.repeat(64),
    walletId: 'w1',
    playerId: 'p1',
    roundId: 'r1',
    gameId: 'g1',
    kind,
    money: brl(amount),
    referenceExternalTransactionId: ref,
    correlationId: null,
    now,
    ...overrides,
  });
}

function settle(t: WagerTransaction, w: Wallet, reference: WagerTransaction | null = null, alreadyReversed = false) {
  return settleWagerTransaction({
    transaction: t,
    wallet: w,
    reference,
    referenceAlreadyReversed: alreadyReversed,
    waitPolicy,
    now,
  });
}

/** A processed transaction of the given kind, as the reference store would return it. */
function processedRef(
  kind: SubmittableKind,
  amount: string,
  ref: string | null = null,
  overrides: Partial<CreateWagerTransactionInput> = {},
) {
  const r = tx(kind, amount, ref, overrides);
  r.markProcessed({ balanceAfter: brl('0.00'), walletVersion: 2, referenceTransactionId: ref ? 'x' : null, now });
  return r;
}

describe('settlement rules', () => {
  test('BET debits; insufficient funds is a REJECTED with stable code and no movement', () => {
    const w = wallet('100.00');
    const ok = settle(tx('BET', '80.00'), w);
    expect(ok.status).toBe(TransactionStatus.PROCESSED);
    expect(ok.status === 'PROCESSED' && ok.ledgerEntry?.direction).toBe(LedgerDirection.DEBIT);
    expect(w.balance.amount).toBe('20.00');

    const second = tx('BET', '80.00');
    const rejected = settle(second, w);
    expect(rejected).toEqual({ status: 'REJECTED', failureCode: FailureCode.INSUFFICIENT_FUNDS });
    expect(second.resultBalance?.amount).toBe('20.00');
    expect(w.balance.amount).toBe('20.00');
    expect(w.version).toBe(2);
  });

  test('WIN credits, with or without reference to a BET of the same round', () => {
    const w = wallet('0.00');
    expect(settle(tx('WIN', '50.00'), w).status).toBe('PROCESSED');
    const bet = processedRef('BET', '10.00');
    expect(settle(tx('WIN', '5.00', bet.externalTransactionId), w, bet).status).toBe('PROCESSED');
    expect(w.balance.amount).toBe('55.00');
  });

  test('LOSS is processed without ledger entry or balance change', () => {
    const w = wallet('10.00');
    const loss = tx('LOSS', '10.00');
    const out = settle(loss, w);
    expect(out).toEqual({ status: 'PROCESSED', ledgerEntry: null });
    expect(w.balance.amount).toBe('10.00');
    expect(w.version).toBe(1);
    expect(w.hasChanges).toBe(false);
    expect(loss.resultBalance?.amount).toBe('10.00');
  });

  test('REFUND credits exactly the referenced BET', () => {
    const w = wallet('20.00');
    const bet = processedRef('BET', '80.00');
    const refund = tx('REFUND', '80.00', bet.externalTransactionId);
    expect(settle(refund, w, bet).status).toBe('PROCESSED');
    expect(w.balance.amount).toBe('100.00');
    expect(refund.referenceTransactionId).toBe(bet.id);
  });

  test('REFUND rejections: wrong amount, wrong kind, not processed, already reversed', () => {
    const bet = processedRef('BET', '80.00');
    expect(settle(tx('REFUND', '79.99', bet.externalTransactionId), wallet('0.00'), bet)).toEqual({
      status: 'REJECTED',
      failureCode: FailureCode.REFERENCE_AMOUNT_MISMATCH,
    });
    const win = processedRef('WIN', '80.00');
    expect(settle(tx('REFUND', '80.00', win.externalTransactionId), wallet('0.00'), win)).toEqual({
      status: 'REJECTED',
      failureCode: FailureCode.REFERENCE_INVALID_KIND,
    });
    const rejectedBet = tx('BET', '80.00');
    rejectedBet.markRejected({ failureCode: FailureCode.INSUFFICIENT_FUNDS, balance: brl('0.00'), walletVersion: 1, now });
    expect(settle(tx('REFUND', '80.00', rejectedBet.externalTransactionId), wallet('0.00'), rejectedBet)).toEqual({
      status: 'REJECTED',
      failureCode: FailureCode.REFERENCE_NOT_PROCESSED,
    });
    expect(settle(tx('REFUND', '80.00', bet.externalTransactionId), wallet('0.00'), bet, true)).toEqual({
      status: 'REJECTED',
      failureCode: FailureCode.REFERENCE_ALREADY_REVERSED,
    });
  });

  test('references must match provider, player, wallet, currency and round', () => {
    for (const override of [{ providerId: 'other' }, { playerId: 'p2' }, { walletId: 'w2' }, { roundId: 'r2' }]) {
      const bet = processedRef('BET', '10.00', null, override);
      expect(settle(tx('REFUND', '10.00', bet.externalTransactionId), wallet('0.00'), bet)).toEqual({
        status: 'REJECTED',
        failureCode: FailureCode.REFERENCE_MISMATCH,
      });
    }
  });

  test('ROLLBACK inverts BET (credit), WIN (debit), REFUND (debit)', () => {
    const w = wallet('50.00');
    const bet = processedRef('BET', '10.00');
    expect(settle(tx('ROLLBACK', '10.00', bet.externalTransactionId), w, bet).status).toBe('PROCESSED');
    expect(w.balance.amount).toBe('60.00');
    const win = processedRef('WIN', '15.00');
    expect(settle(tx('ROLLBACK', '15.00', win.externalTransactionId), w, win).status).toBe('PROCESSED');
    expect(w.balance.amount).toBe('45.00');
    const refund = processedRef('REFUND', '5.00', 'BET-x');
    expect(settle(tx('ROLLBACK', '5.00', refund.externalTransactionId), w, refund).status).toBe('PROCESSED');
    expect(w.balance.amount).toBe('40.00');
  });

  test('ROLLBACK that would make the balance negative is rejected with its own code', () => {
    const w = wallet('10.00');
    const win = processedRef('WIN', '15.00');
    expect(settle(tx('ROLLBACK', '15.00', win.externalTransactionId), w, win)).toEqual({
      status: 'REJECTED',
      failureCode: FailureCode.ROLLBACK_INSUFFICIENT_FUNDS,
    });
    expect(w.balance.amount).toBe('10.00');
  });

  test('ROLLBACK cannot target LOSS or another ROLLBACK', () => {
    const loss = processedRef('LOSS', '0.00');
    expect(settle(tx('ROLLBACK', '1.00', loss.externalTransactionId), wallet('5.00'), loss)).toEqual({
      status: 'REJECTED',
      failureCode: FailureCode.REFERENCE_INVALID_KIND,
    });
  });

  test('missing reference parks the transaction, then rejects when attempts run out', () => {
    const w = wallet('0.00');
    const refund = tx('REFUND', '10.00', 'BET-missing');
    const first = settle(refund, w);
    expect(first.status).toBe('PENDING_REFERENCE');
    expect(refund.referenceAttempts).toBe(1);
    expect(refund.nextReferenceCheckAt?.getTime()).toBe(now.getTime() + 1000);
    expect(settle(refund, w).status).toBe('PENDING_REFERENCE');
    expect(refund.referenceAttempts).toBe(2);
    expect(settle(refund, w)).toEqual({ status: 'REJECTED', failureCode: FailureCode.REFERENCE_NOT_FOUND });
    expect(refund.isTerminal()).toBe(true);
  });

  test('TTL expiry rejects even with attempts left', () => {
    const refund = tx('REFUND', '10.00', 'BET-missing');
    settleWagerTransaction({
      transaction: refund,
      wallet: wallet('0'),
      reference: null,
      referenceAlreadyReversed: false,
      waitPolicy,
      now,
    });
    const later = new Date(now.getTime() + 61_000);
    expect(
      settleWagerTransaction({
        transaction: refund,
        wallet: wallet('0'),
        reference: null,
        referenceAlreadyReversed: false,
        waitPolicy,
        now: later,
      }),
    ).toEqual({ status: 'REJECTED', failureCode: FailureCode.REFERENCE_NOT_FOUND });
  });

  test('reference that exists but is itself pending makes the dependent wait', () => {
    const pendingRefund = tx('REFUND', '5.00', 'BET-missing');
    pendingRefund.markPendingReference({ nextCheckAt: now, deadlineAt: now, now });
    const rollback = tx('ROLLBACK', '5.00', pendingRefund.externalTransactionId);
    expect(settle(rollback, wallet('5.00'), pendingRefund).status).toBe('PENDING_REFERENCE');
  });

  test('settling a terminal transaction is an invariant violation', () => {
    const bet = processedRef('BET', '1.00');
    expect(() => settle(bet, wallet('5.00'))).toThrow();
  });

  test('failure codes are stable strings', () => {
    expect(ALL_FAILURE_CODES).toEqual([
      'INSUFFICIENT_FUNDS',
      'ROLLBACK_INSUFFICIENT_FUNDS',
      'REFERENCE_NOT_FOUND',
      'REFERENCE_INVALID_KIND',
      'REFERENCE_NOT_PROCESSED',
      'REFERENCE_MISMATCH',
      'REFERENCE_AMOUNT_MISMATCH',
      'REFERENCE_ALREADY_REVERSED',
      'REFERENCE_SELF',
      'INTERNAL_INVARIANT_VIOLATION',
    ]);
  });
});
