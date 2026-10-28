import { describe, expect, test } from 'bun:test';
import { IdempotencyConflictError } from '../../src/application/errors';
import type { TransactionContext, UnitOfWork } from '../../src/application/ports/persistence';
import { wagerPayloadHash } from '../../src/application/wagering/payload-hash';
import { ProcessWagerTransactionUseCase, type WagerCommand } from '../../src/application/wagering/process-wager-transaction';
import { Money } from '../../src/domain/money/money';
import { RetryPolicy } from '../../src/domain/shared/retry-policy';
import { WagerTransaction } from '../../src/domain/wagering/wager-transaction';
import { createLogger } from '../../src/observability/logger';
import { Metrics } from '../../src/observability/metrics';

/**
 * Regression for an audit finding: on the lock-free fast path the original request can
 * commit between the "by idempotency key" lookup and the "by external id" lookup.
 * The second lookup then returns the row created with *this* key; that must be a
 * replay, not EXTERNAL_TRANSACTION_CONFLICT. This test pins that interleaving.
 */
const command: WagerCommand = {
  providerId: 'prov',
  externalTransactionId: 'bet-1',
  walletId: '00000000-0000-4000-8000-000000000001',
  playerId: 'p1',
  roundId: 'r1',
  gameId: 'g1',
  kind: 'BET',
  amount: '80.00',
  currency: 'BRL',
  referenceExternalTransactionId: null,
};

function committedRow(idempotencyKey: string, amount = '80.00'): WagerTransaction {
  const tx = WagerTransaction.create({
    ...command,
    kind: 'BET',
    idempotencyKey,
    payloadHash: wagerPayloadHash({ ...command, amount }),
    money: Money.of(amount, 'BRL'),
    correlationId: null,
    now: new Date(),
  });
  tx.markProcessed({ balanceAfter: Money.of('20.00', 'BRL'), walletVersion: 2, referenceTransactionId: null, now: new Date() });
  return tx;
}

/** The key lookup misses (row not committed yet); the external-id lookup sees it (committed meanwhile). */
function racingUseCase(row: WagerTransaction) {
  let transactionsOpened = 0;
  const ctx = {
    transactions: {
      findByIdempotencyKey: async () => null,
      findByExternalId: async () => row,
    },
  } as unknown as TransactionContext;
  const uow: UnitOfWork = {
    read: (work) => work(ctx),
    run: async () => {
      transactionsOpened++;
      throw new Error('must not open a write transaction for a replay');
    },
  };
  const useCase = new ProcessWagerTransactionUseCase(uow, { now: () => new Date() }, new Metrics(), createLogger('silent'), {
    supportedCurrencies: ['BRL'],
    waitPolicy: { retry: new RetryPolicy({ maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0 }), ttlMs: 1000 },
  });
  return { useCase, opened: () => transactionsOpened };
}

const meta = (idempotencyKey: string) => ({ idempotencyKey, correlationId: null, causationId: null, channel: 'http' as const });

describe('idempotency lookup race (fast path)', () => {
  test('row found by external id carrying the same key => replay', async () => {
    const { useCase, opened } = racingUseCase(committedRow('key-same-0001'));
    const result = await useCase.execute(command, meta('key-same-0001'));
    expect(result.idempotentReplay).toBe(true);
    expect(result.transaction.resultBalance?.amount).toBe('20.00');
    expect(opened()).toBe(0);
  });

  test('same key, but the committed payload differs => IDEMPOTENCY_KEY_REUSED (hash still enforced)', async () => {
    const { useCase } = racingUseCase(committedRow('key-same-0001', '79.00'));
    const error = await useCase.execute(command, meta('key-same-0001')).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(IdempotencyConflictError);
    expect((error as IdempotencyConflictError).code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  test('row found by external id under another key => EXTERNAL_TRANSACTION_CONFLICT', async () => {
    const { useCase } = racingUseCase(committedRow('key-other-0001'));
    const error = await useCase.execute(command, meta('key-mine-00001')).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(IdempotencyConflictError);
    expect((error as IdempotencyConflictError).code).toBe('EXTERNAL_TRANSACTION_CONFLICT');
  });
});
