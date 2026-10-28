import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { EntityManager } from '@mikro-orm/postgresql';
import {
  CommandRejectedError,
  IdempotencyConflictError,
  WalletAlreadyExistsError,
  WalletNotFoundError,
} from '../../src/application/errors';
import type { Container } from '../../src/bootstrap/container';
import { InvariantViolationError } from '../../src/domain/shared/domain-error';
import { FailureCode, TransactionStatus } from '../../src/domain/wagering/wager-types';
import { auditWallet, expectConsistent, resetDatabase, sql, testContainer } from '../helpers/db';
import { meta, openWallet, rejectionOf, uniq, wager } from '../helpers/fixtures';

let c: Container;

beforeAll(async () => {
  await resetDatabase();
  c = await testContainer();
});
afterAll(async () => {
  await c?.close();
});

async function outboxTypes(walletId: string): Promise<string[]> {
  const rows = await sql<{ event_type: string }>(
    c,
    `SELECT event_type FROM outbox_messages WHERE message_group_id = ? ORDER BY seq`,
    [walletId],
  );
  return rows.map((r) => r.event_type);
}

describe('wallet creation', () => {
  test('positive opening balance: OPENING tx + CREDIT entry + event, atomically', async () => {
    const w = await openWallet(c, '100.00');
    expect(w.balance.amount).toBe('100.00');
    const [opening] = await sql<{ kind: string; status: string; amount: string }>(
      c,
      `SELECT kind, status, amount FROM wager_transactions WHERE wallet_id = ?`,
      [w.id],
    );
    expect(opening).toEqual({ kind: 'OPENING', status: 'PROCESSED', amount: '100.00' });
    expect(await outboxTypes(w.id)).toEqual(['WalletBalanceChanged']);
    const audit = await auditWallet(c, w.id);
    expectConsistent(audit);
    expect(audit.entries).toBe(1);
  });

  test('zero opening balance: no transaction, no entry', async () => {
    const w = await openWallet(c, '0.00');
    const audit = await auditWallet(c, w.id);
    expect(audit.entries).toBe(0);
    expect(audit.version).toBe(1);
    expect(await outboxTypes(w.id)).toEqual([]);
  });

  test('duplicate player+currency is a conflict', async () => {
    const w = await openWallet(c, '1.00');
    expect(
      await rejectionOf(c.wallets.create({ playerId: w.playerId, currency: 'BRL', initialBalance: '5.00' }, null)),
    ).toBeInstanceOf(WalletAlreadyExistsError);
  });

  test('concurrent duplicate creation: exactly one wallet', async () => {
    const playerId = uniq('racer');
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () => c.wallets.create({ playerId, currency: 'BRL', initialBalance: '10.00' }, null)),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    for (const r of results) if (r.status === 'rejected') expect(r.reason).toBeInstanceOf(WalletAlreadyExistsError);
    const rows = await sql<{ n: number }>(c, `SELECT count(*)::int AS n FROM wallets WHERE player_id = ?`, [playerId]);
    expect(rows[0]?.n).toBe(1);
  });

  test('unsupported currency is rejected before touching the database', async () => {
    expect(
      await rejectionOf(c.wallets.create({ playerId: uniq('p'), currency: 'USD', initialBalance: '1.00' }, null)),
    ).toBeInstanceOf(CommandRejectedError);
  });
});

describe('BET / WIN / LOSS', () => {
  test('BET debits, WIN credits, LOSS records without moving money', async () => {
    const w = await openWallet(c, '100.00');
    const bet = await c.wagers.execute(wager(w, 'BET', '30.00'), meta());
    expect(bet.transaction.status).toBe('PROCESSED');
    expect(bet.transaction.resultBalance?.amount).toBe('70.00');
    const win = await c.wagers.execute(
      wager(w, 'WIN', '45.50', { referenceExternalTransactionId: bet.transaction.externalTransactionId }),
      meta(),
    );
    expect(win.transaction.resultBalance?.amount).toBe('115.50');
    const loss = await c.wagers.execute(wager(w, 'LOSS', '30.00'), meta());
    expect(loss.transaction.status).toBe('PROCESSED');
    expect(loss.transaction.resultBalance?.amount).toBe('115.50');

    const audit = await auditWallet(c, w.id);
    expectConsistent(audit);
    expect(audit.entries).toBe(3); // opening + bet + win; LOSS has none
    expect(await outboxTypes(w.id)).toEqual([
      'WalletBalanceChanged',
      'WalletBalanceChanged',
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
      'WagerTransactionProcessed',
      'WagerTransactionProcessed', // LOSS: processed event, no balance event
    ]);
  });

  test('insufficient funds: REJECTED persisted, balance and version untouched, rejection event', async () => {
    const w = await openWallet(c, '10.00');
    const r = await c.wagers.execute(wager(w, 'BET', '10.01'), meta());
    expect(r.transaction.status).toBe('REJECTED');
    expect(r.transaction.failureCode).toBe(FailureCode.INSUFFICIENT_FUNDS);
    const audit = await auditWallet(c, w.id);
    expect(audit.balance).toBe('10.00');
    expect(audit.version).toBe(1);
    expect((await outboxTypes(w.id)).at(-1)).toBe('WagerTransactionRejected');
  });

  test('incoherent commands are refused without persisting', async () => {
    const w = await openWallet(c, '10.00');
    expect(await rejectionOf(c.wagers.execute(wager(w, 'BET', '1.00', { playerId: 'intruder' }), meta()))).toMatchObject({
      code: 'PLAYER_WALLET_MISMATCH',
    });
    expect(
      await rejectionOf(c.wagers.execute(wager({ id: crypto.randomUUID(), playerId: w.playerId }, 'BET', '1.00'), meta())),
    ).toBeInstanceOf(WalletNotFoundError);
    const rows = await sql<{ n: number }>(c, `SELECT count(*)::int AS n FROM wager_transactions WHERE wallet_id = ?`, [w.id]);
    expect(rows[0]?.n).toBe(1); // only OPENING
  });
});

describe('idempotency', () => {
  test('same key + same payload => original result with idempotentReplay, no second effect', async () => {
    const w = await openWallet(c, '100.00');
    const cmd = wager(w, 'BET', '80.00');
    const m = meta();
    const first = await c.wagers.execute(cmd, m);
    // the balance moves afterwards; the replay must still report the original snapshot
    await c.wagers.execute(wager(w, 'WIN', '5.00'), meta());
    const replay = await c.wagers.execute(cmd, m);
    expect(first.idempotentReplay).toBe(false);
    expect(replay.idempotentReplay).toBe(true);
    expect(replay.transaction.id).toBe(first.transaction.id);
    expect(replay.transaction.resultBalance?.amount).toBe('20.00');
    const audit = await auditWallet(c, w.id);
    expect(audit.balance).toBe('25.00');
    expect(audit.entries).toBe(3);
  });

  test('same key + different payload => IDEMPOTENCY_KEY_REUSED, nothing executed', async () => {
    const w = await openWallet(c, '100.00');
    const m = meta();
    const cmd = wager(w, 'BET', '10.00');
    await c.wagers.execute(cmd, m);
    expect(await rejectionOf(c.wagers.execute({ ...cmd, amount: '11.00' }, m))).toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
    expect((await auditWallet(c, w.id)).balance).toBe('90.00');
  });

  test('same external id under another key => EXTERNAL_TRANSACTION_CONFLICT', async () => {
    const w = await openWallet(c, '100.00');
    const cmd = wager(w, 'BET', '10.00');
    await c.wagers.execute(cmd, meta());
    const error = await c.wagers.execute(cmd, meta()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(IdempotencyConflictError);
    expect((error as IdempotencyConflictError).code).toBe('EXTERNAL_TRANSACTION_CONFLICT');
    expect((await auditWallet(c, w.id)).balance).toBe('90.00');
  });

  test('key scope is the provider: same key under another provider is independent', async () => {
    const w = await openWallet(c, '100.00');
    const key = uniq('shared-key');
    await c.wagers.execute(wager(w, 'BET', '1.00', { providerId: 'prov-a' }), meta(key));
    const other = await c.wagers.execute(wager(w, 'BET', '1.00', { providerId: 'prov-b' }), meta(key));
    expect(other.idempotentReplay).toBe(false);
    expect((await auditWallet(c, w.id)).balance).toBe('98.00');
  });

  test('crash after COMMIT, before the response: retry returns the persisted result', async () => {
    const w = await openWallet(c, '100.00');
    const cmd = wager(w, 'BET', '40.00');
    const m = meta();
    // simulate: the work commits but the caller never sees the result
    await c.uow.run((ctx) => c.wagers.executeInTransaction(ctx, cmd, m), { label: 'test' });
    const retry = await c.wagers.execute(cmd, m);
    expect(retry.idempotentReplay).toBe(true);
    expect(retry.transaction.status).toBe('PROCESSED');
    expect((await auditWallet(c, w.id)).entries).toBe(2);
  });

  test('exception mid-transaction rolls back everything (no partial ledger/outbox)', async () => {
    const w = await openWallet(c, '100.00');
    const before = await sql<{ n: number }>(c, `SELECT count(*)::int AS n FROM outbox_messages`);
    expect(
      await rejectionOf(
        c.uow.run(
          async (ctx) => {
            await c.wagers.executeInTransaction(ctx, wager(w, 'BET', '50.00'), meta());
            throw new Error('boom after writes');
          },
          { label: 'test', retry: false },
        ),
      ),
    ).toHaveProperty('message', 'boom after writes');
    const audit = await auditWallet(c, w.id);
    expect(audit.balance).toBe('100.00');
    expect(audit.entries).toBe(1);
    const after = await sql<{ n: number }>(c, `SELECT count(*)::int AS n FROM outbox_messages`);
    expect(after[0]?.n).toBe(before[0]?.n);
  });
});

describe('REFUND / ROLLBACK', () => {
  test('REFUND credits the BET amount exactly once', async () => {
    const w = await openWallet(c, '100.00');
    const bet = await c.wagers.execute(wager(w, 'BET', '80.00'), meta());
    const ref = { referenceExternalTransactionId: bet.transaction.externalTransactionId };
    const refund = await c.wagers.execute(wager(w, 'REFUND', '80.00', ref), meta());
    expect(refund.transaction.status).toBe('PROCESSED');
    expect(refund.transaction.resultBalance?.amount).toBe('100.00');
    const second = await c.wagers.execute(wager(w, 'REFUND', '80.00', ref), meta());
    expect(second.transaction.failureCode).toBe(FailureCode.REFERENCE_ALREADY_REVERSED);
    const rollback = await c.wagers.execute(wager(w, 'ROLLBACK', '80.00', ref), meta());
    expect(rollback.transaction.failureCode).toBe(FailureCode.REFERENCE_ALREADY_REVERSED);
    expectConsistent(await auditWallet(c, w.id));
    expect((await auditWallet(c, w.id)).balance).toBe('100.00');
  });

  test('ROLLBACK of WIN debits; ROLLBACK of REFUND re-debits; negative result is refused', async () => {
    const w = await openWallet(c, '10.00');
    const win = await c.wagers.execute(wager(w, 'WIN', '50.00'), meta());
    const rbWin = await c.wagers.execute(
      wager(w, 'ROLLBACK', '50.00', { referenceExternalTransactionId: win.transaction.externalTransactionId }),
      meta(),
    );
    expect(rbWin.transaction.resultBalance?.amount).toBe('10.00');

    const bet = await c.wagers.execute(wager(w, 'BET', '10.00'), meta());
    const refund = await c.wagers.execute(
      wager(w, 'REFUND', '10.00', { referenceExternalTransactionId: bet.transaction.externalTransactionId }),
      meta(),
    );
    expect(refund.transaction.resultBalance?.amount).toBe('10.00');
    const rbRefund = await c.wagers.execute(
      wager(w, 'ROLLBACK', '10.00', { referenceExternalTransactionId: refund.transaction.externalTransactionId }),
      meta(),
    );
    expect(rbRefund.transaction.resultBalance?.amount).toBe('0.00');

    const win2 = await c.wagers.execute(wager(w, 'WIN', '5.00'), meta());
    await c.wagers.execute(wager(w, 'BET', '5.00'), meta());
    const negative = await c.wagers.execute(
      wager(w, 'ROLLBACK', '5.00', { referenceExternalTransactionId: win2.transaction.externalTransactionId }),
      meta(),
    );
    expect(negative.transaction.failureCode).toBe(FailureCode.ROLLBACK_INSUFFICIENT_FUNDS);
    const audit = await auditWallet(c, w.id);
    expectConsistent(audit);
    expect(audit.balance).toBe('0.00');
  });

  test('references in another round / wallet are rejected as REFERENCE_MISMATCH', async () => {
    const w = await openWallet(c, '100.00');
    const other = await openWallet(c, '100.00');
    const bet = await c.wagers.execute(wager(w, 'BET', '10.00'), meta());
    const ref = { referenceExternalTransactionId: bet.transaction.externalTransactionId };
    const wrongRound = await c.wagers.execute(wager(w, 'REFUND', '10.00', { ...ref, roundId: 'round-2' }), meta());
    expect(wrongRound.transaction.failureCode).toBe(FailureCode.REFERENCE_MISMATCH);
    const wrongWallet = await c.wagers.execute(wager(other, 'REFUND', '10.00', ref), meta());
    expect(wrongWallet.transaction.failureCode).toBe(FailureCode.REFERENCE_MISMATCH);
  });
});

describe('out-of-order references (PENDING_REFERENCE + worker)', () => {
  test('REFUND before its BET waits, then is processed by the worker after the BET arrives', async () => {
    const w = await openWallet(c, '100.00');
    const betExt = uniq('late-bet');
    const refund = await c.wagers.execute(wager(w, 'REFUND', '30.00', { referenceExternalTransactionId: betExt }), meta());
    expect(refund.transaction.status).toBe(TransactionStatus.PENDING_REFERENCE);
    expect(await outboxTypes(w.id)).toContain('WagerTransactionPendingReference');

    await c.wagers.execute(wager(w, 'BET', '30.00', { externalTransactionId: betExt }), meta());
    const run = await c.pendingReferences.runOnce(100);
    expect(run.processed).toBeGreaterThanOrEqual(1);
    const after = await c.wagers.getById(refund.transaction.id);
    expect(after.status).toBe('PROCESSED');
    expect(after.resultBalance?.amount).toBe('100.00');
    expectConsistent(await auditWallet(c, w.id));
  });

  test('chain: ROLLBACK -> REFUND -> BET all out of order', async () => {
    const w = await openWallet(c, '100.00');
    const betExt = uniq('bet');
    const refundExt = uniq('refund');
    const rb = await c.wagers.execute(wager(w, 'ROLLBACK', '20.00', { referenceExternalTransactionId: refundExt }), meta());
    const refund = await c.wagers.execute(
      wager(w, 'REFUND', '20.00', { externalTransactionId: refundExt, referenceExternalTransactionId: betExt }),
      meta(),
    );
    expect(rb.transaction.status).toBe('PENDING_REFERENCE');
    expect(refund.transaction.status).toBe('PENDING_REFERENCE');
    await c.wagers.execute(wager(w, 'BET', '20.00', { externalTransactionId: betExt }), meta());
    for (let i = 0; i < 3; i++) await c.pendingReferences.runOnce(100);
    expect((await c.wagers.getById(refund.transaction.id)).status).toBe('PROCESSED');
    expect((await c.wagers.getById(rb.transaction.id)).status).toBe('PROCESSED');
    const audit = await auditWallet(c, w.id);
    expectConsistent(audit);
    expect(audit.balance).toBe('80.00'); // 100 - 20 (bet) + 20 (refund) - 20 (rollback of refund)
  });

  test('reference that never arrives is REJECTED with REFERENCE_NOT_FOUND after the budget', async () => {
    const limited = await testContainer({ PENDING_REFERENCE_MAX_ATTEMPTS: '3' });
    try {
      const w = await openWallet(limited, '100.00');
      const refund = await limited.wagers.execute(
        wager(w, 'REFUND', '10.00', { referenceExternalTransactionId: uniq('ghost') }),
        meta(),
      );
      for (let i = 0; i < 5; i++) await limited.pendingReferences.runOnce(1000);
      const final = await limited.wagers.getById(refund.transaction.id);
      expect(final.status).toBe('REJECTED');
      expect(final.failureCode).toBe(FailureCode.REFERENCE_NOT_FOUND);
      expect(final.referenceAttempts).toBe(2);
      const types = await sql<{ event_type: string }>(
        limited,
        `SELECT event_type FROM outbox_messages WHERE aggregate_id = ? ORDER BY seq`,
        [refund.transaction.id],
      );
      expect(types.map((t) => t.event_type)).toEqual(['WagerTransactionPendingReference', 'WagerTransactionRejected']);
    } finally {
      await limited.close();
    }
  });

  test('two workers on the same backlog: each pending transaction is settled once', async () => {
    const w = await openWallet(c, '100.00');
    const bets: string[] = [];
    const refunds: string[] = [];
    for (let i = 0; i < 10; i++) {
      const ext = uniq('bet');
      bets.push(ext);
      const r = await c.wagers.execute(wager(w, 'REFUND', '1.00', { referenceExternalTransactionId: ext }), meta());
      refunds.push(r.transaction.id);
    }
    for (const ext of bets) await c.wagers.execute(wager(w, 'BET', '1.00', { externalTransactionId: ext }), meta());
    const second = await testContainer();
    try {
      const [a, b] = await Promise.all([c.pendingReferences.runOnce(100), second.pendingReferences.runOnce(100)]);
      expect(a.processed + b.processed).toBe(10);
    } finally {
      await second.close();
    }
    const audit = await auditWallet(c, w.id);
    expectConsistent(audit);
    expect(audit.balance).toBe('100.00');
    expect(audit.entries).toBe(21);
  });
});

describe('pending references use the PostgreSQL clock (app servers with skewed clocks)', () => {
  const ahead = { now: () => new Date(Date.now() + 3_600_000) };
  const behind = { now: () => new Date(Date.now() - 3_600_000) };

  test('schedule and deadline are relative to the database clock, not the app clock', async () => {
    const node = await testContainer(
      { PENDING_REFERENCE_BASE_DELAY_MS: '60000', PENDING_REFERENCE_MAX_DELAY_MS: '60000', PENDING_REFERENCE_TTL_MS: '600000' },
      { clock: ahead },
    );
    try {
      const w = await openWallet(node, '100.00');
      const refund = await node.wagers.execute(
        wager(w, 'REFUND', '1.00', { referenceExternalTransactionId: uniq('later') }),
        meta(),
      );
      const [row] = await sql<{ next_in: number; deadline_in: number }>(
        node,
        `SELECT EXTRACT(EPOCH FROM next_reference_check_at - now())::float8 AS next_in,
                EXTRACT(EPOCH FROM reference_deadline_at - now())::float8 AS deadline_in
           FROM wager_transactions WHERE id = ?`,
        [refund.transaction.id],
      );
      // 60s base delay with 50% jitter => 30..60s; TTL 600s. An app clock 1h ahead would add 3600s.
      expect(row?.next_in).toBeGreaterThan(25);
      expect(row?.next_in).toBeLessThan(61);
      expect(row?.deadline_in).toBeGreaterThan(590);
      expect(row?.deadline_in).toBeLessThan(601);
    } finally {
      await node.close();
    }
  });

  test('a worker whose clock is 1h ahead does not treat a not-yet-due row as due (no budget burnt early)', async () => {
    const scheduler = await testContainer({ PENDING_REFERENCE_BASE_DELAY_MS: '60000', PENDING_REFERENCE_MAX_DELAY_MS: '60000' });
    const fastNode = await testContainer({}, { clock: ahead });
    try {
      const w = await openWallet(scheduler, '100.00');
      const refund = await scheduler.wagers.execute(
        wager(w, 'REFUND', '1.00', { referenceExternalTransactionId: uniq('later') }),
        meta(),
      );
      const run = await fastNode.pendingReferences.runOnce(1000);
      expect(run.examined).toBe(0);
      const after = await scheduler.wagers.getById(refund.transaction.id);
      expect(after.referenceAttempts).toBe(1);
      expect(after.status).toBe('PENDING_REFERENCE');
    } finally {
      await fastNode.close();
      await scheduler.close();
    }
  });

  test('a worker whose clock is 1h behind still resolves rows that another node scheduled', async () => {
    const scheduler = await testContainer();
    const slowNode = await testContainer({}, { clock: behind });
    try {
      const w = await openWallet(scheduler, '100.00');
      const betExt = uniq('bet-slow');
      const refund = await scheduler.wagers.execute(
        wager(w, 'REFUND', '5.00', { referenceExternalTransactionId: betExt }),
        meta(),
      );
      await scheduler.wagers.execute(wager(w, 'BET', '5.00', { externalTransactionId: betExt }), meta());
      const run = await slowNode.pendingReferences.runOnce(1000);
      expect(run.processed).toBeGreaterThanOrEqual(1);
      expect((await scheduler.wagers.getById(refund.transaction.id)).status).toBe('PROCESSED');
      expectConsistent(await auditWallet(scheduler, w.id));
    } finally {
      await slowNode.close();
      await scheduler.close();
    }
  });
});

describe('pending worker: permanent errors', () => {
  test('a non-transient error while re-evaluating ends the transaction FAILED instead of looping forever', async () => {
    const isolated = await testContainer();
    try {
      const w = await openWallet(isolated, '100.00');
      const refund = await isolated.wagers.execute(
        wager(w, 'REFUND', '10.00', { referenceExternalTransactionId: uniq('never') }),
        meta(),
      );
      // simulate a broken invariant discovered during re-evaluation
      isolated.wagers.settle = async () => {
        throw new InvariantViolationError('corrupted reference chain');
      };
      const run = await isolated.pendingReferences.runOnce(1000);
      expect(run.failed).toBeGreaterThanOrEqual(1);
      const final = await isolated.wagers.getById(refund.transaction.id);
      expect(final.status).toBe('FAILED');
      expect(final.failureCode).toBe(FailureCode.INTERNAL_INVARIANT_VIOLATION);
      // terminal: nothing left for the worker
      const again = await isolated.pendingReferences.runOnce(1000);
      expect(again.examined).toBe(0);
      expectConsistent(await auditWallet(isolated, w.id));
    } finally {
      await isolated.close();
    }
  });
});

describe('reconciliation', () => {
  test('consistent wallet reports zero difference', async () => {
    const w = await openWallet(c, '50.00');
    await c.wagers.execute(wager(w, 'BET', '20.00'), meta());
    const report = await c.wallets.reconcile(w.id);
    expect(report).toMatchObject({ consistent: true, difference: '0.00', checkedEntries: 2, materializedBalance: '30.00' });
  });

  test('divergence is detected, logged and counted — never corrected', async () => {
    const w = await openWallet(c, '50.00');
    // corrupt the materialised balance behind the application's back (superuser test only)
    await (c.orm.em.fork() as EntityManager).transactional(async (em) => {
      await em.execute('ALTER TABLE wallets DISABLE TRIGGER USER');
      await em.execute(`UPDATE wallets SET balance = balance + 7 WHERE id = ?`, [w.id]);
      await em.execute('ALTER TABLE wallets ENABLE TRIGGER USER');
    });
    const before = await c.metrics.valueOf('wallet_reconciliation_mismatch_total');
    const report = await c.wallets.reconcile(w.id);
    expect(report).toMatchObject({ consistent: false, difference: '7.00', materializedBalance: '57.00', ledgerBalance: '50.00' });
    expect(await c.metrics.valueOf('wallet_reconciliation_mismatch_total')).toBe(before + 1);
    expect((await c.wallets.get(w.id)).balance.amount).toBe('57.00');
  });
});

describe('ledger pagination', () => {
  test('keyset cursor stays stable while new entries are inserted', async () => {
    const w = await openWallet(c, '100.00');
    for (let i = 0; i < 6; i++) await c.wagers.execute(wager(w, 'BET', '1.00'), meta());
    const page1 = await c.wallets.ledger(w.id, undefined, 3);
    expect(page1.entries.map((e) => e.walletVersion)).toEqual([7, 6, 5]);
    // new activity between pages must not shift or duplicate the next page
    await c.wagers.execute(wager(w, 'WIN', '9.00'), meta());
    const page2 = await c.wallets.ledger(w.id, page1.nextCursor ?? undefined, 3);
    expect(page2.entries.map((e) => e.walletVersion)).toEqual([4, 3, 2]);
    const page3 = await c.wallets.ledger(w.id, page2.nextCursor ?? undefined, 3);
    expect(page3.entries.map((e) => e.walletVersion)).toEqual([1]);
    expect(page3.nextCursor).toBeNull();
  });
});
