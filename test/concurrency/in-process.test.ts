import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { EntityManager } from '@mikro-orm/postgresql';
import { IdempotencyConflictError } from '../../src/application/errors';
import type { WagerCommand } from '../../src/application/wagering/process-wager-transaction';
import type { Container } from '../../src/bootstrap/container';
import { FailureCode } from '../../src/domain/wagering/wager-types';
import { auditWallet, expectConsistent, resetDatabase, sql, testContainer } from '../helpers/db';
import { meta, openWallet, uniq, wager } from '../helpers/fixtures';

/**
 * Real parallelism: every operation runs on its own pooled PostgreSQL connection
 * (pool of 40), all fired at once with Promise.all — the database, not the test,
 * decides the interleaving.
 */
let c: Container;

beforeAll(async () => {
  await resetDatabase();
  c = await testContainer({ DB_POOL_MAX: '40' });
});
afterAll(async () => {
  await c?.close();
});

async function maxConcurrentBackends(): Promise<number> {
  const [row] = await sql<{ n: number }>(c, `SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database()`);
  return row?.n ?? 0;
}

describe('concurrency', () => {
  test('the same BET sent 50 times at once is applied exactly once', async () => {
    const w = await openWallet(c, '100.00');
    const cmd = wager(w, 'BET', '80.00');
    const m = meta();
    const results = await Promise.all(Array.from({ length: 50 }, () => c.wagers.execute(cmd, m)));
    expect(results.filter((r) => !r.idempotentReplay)).toHaveLength(1);
    expect(results.filter((r) => r.idempotentReplay)).toHaveLength(49);
    expect(new Set(results.map((r) => r.transaction.id)).size).toBe(1);
    expect(results.every((r) => r.transaction.resultBalance?.amount === '20.00')).toBe(true);
    const audit = await auditWallet(c, w.id);
    expectConsistent(audit);
    expect(audit.balance).toBe('20.00');
    expect(audit.entries).toBe(2);
    expect(await maxConcurrentBackends()).toBeGreaterThan(5); // the pool really opened many connections
  });

  test('100.00 vs two simultaneous 80.00 BETs (x25 wallets): one PROCESSED, one INSUFFICIENT_FUNDS, 20.00 left', async () => {
    const wallets = await Promise.all(Array.from({ length: 25 }, () => openWallet(c, '100.00')));
    const outcomes = await Promise.all(
      wallets.flatMap((w) => [
        c.wagers.execute(wager(w, 'BET', '80.00'), meta()),
        c.wagers.execute(wager(w, 'BET', '80.00'), meta()),
      ]),
    );
    for (let i = 0; i < wallets.length; i++) {
      const pair = [outcomes[2 * i], outcomes[2 * i + 1]].map((r) => r?.transaction);
      const statuses = pair.map((t) => t?.status).sort();
      expect(statuses).toEqual(['PROCESSED', 'REJECTED']);
      expect(pair.find((t) => t?.status === 'REJECTED')?.failureCode).toBe(FailureCode.INSUFFICIENT_FUNDS);
      const w = wallets[i];
      if (!w) throw new Error('missing wallet');
      const audit = await auditWallet(c, w.id);
      expectConsistent(audit);
      expect(audit.balance).toBe('20.00');
      const debits = await sql<{ n: number }>(
        c,
        `SELECT count(*)::int AS n FROM wallet_ledger_entries WHERE wallet_id = ? AND direction = 'DEBIT'`,
        [w.id],
      );
      expect(debits[0]?.n).toBe(1);
    }
  });

  test('wallets are independent: a locked wallet does not block the others (no global lock)', async () => {
    const blocked = await openWallet(c, '100.00');
    const others = await Promise.all(Array.from({ length: 10 }, () => openWallet(c, '100.00')));
    let release: () => void = () => undefined;
    const held = new Promise<void>((r) => {
      release = r;
    });
    let locked: () => void = () => undefined;
    const isLocked = new Promise<void>((r) => {
      locked = r;
    });
    const holder = (c.orm.em.fork() as EntityManager).transactional(async (em) => {
      await em.execute('SELECT id FROM wallets WHERE id = ? FOR UPDATE', [blocked.id]);
      locked();
      await held;
    });
    await isLocked;
    const blockedOp = c.wagers.execute(wager(blocked, 'BET', '1.00'), meta());
    let blockedDone = false;
    void blockedOp.then(() => {
      blockedDone = true;
    });
    const started = performance.now();
    const results = await Promise.all(others.map((w) => c.wagers.execute(wager(w, 'BET', '1.00'), meta())));
    const elapsed = performance.now() - started;
    expect(results.every((r) => r.transaction.status === 'PROCESSED')).toBe(true);
    expect(blockedDone).toBe(false); // still waiting on its wallet lock
    expect(elapsed).toBeLessThan(4000); // well under the 5s lock_timeout the blocked one is subject to
    release();
    await holder;
    expect((await blockedOp).transaction.status).toBe('PROCESSED');
  });

  test('20 concurrent reversals of one BET: exactly one is applied', async () => {
    const w = await openWallet(c, '100.00');
    const bet = await c.wagers.execute(wager(w, 'BET', '50.00'), meta());
    const ref = { referenceExternalTransactionId: bet.transaction.externalTransactionId };
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => c.wagers.execute(wager(w, i % 2 ? 'REFUND' : 'ROLLBACK', '50.00', ref), meta())),
    );
    expect(results.filter((r) => r.transaction.status === 'PROCESSED')).toHaveLength(1);
    expect(results.filter((r) => r.transaction.failureCode === FailureCode.REFERENCE_ALREADY_REVERSED)).toHaveLength(19);
    const audit = await auditWallet(c, w.id);
    expectConsistent(audit);
    expect(audit.balance).toBe('100.00');
  });

  test('REFUNDs racing with their BETs (both orders): every refund ends PROCESSED once', async () => {
    const w = await openWallet(c, '1000.00');
    const pairs = Array.from({ length: 15 }, () => uniq('race-bet'));
    await Promise.all(
      pairs.flatMap((betExt) => [
        c.wagers.execute(wager(w, 'REFUND', '10.00', { referenceExternalTransactionId: betExt }), meta()),
        c.wagers.execute(wager(w, 'BET', '10.00', { externalTransactionId: betExt }), meta()),
      ]),
    );
    for (let i = 0; i < 5; i++) await c.pendingReferences.runOnce(100);
    const [row] = await sql<{ processed: number; other: number }>(
      c,
      `SELECT count(*) FILTER (WHERE status = 'PROCESSED')::int AS processed,
              count(*) FILTER (WHERE status <> 'PROCESSED')::int AS other
         FROM wager_transactions WHERE wallet_id = ? AND kind = 'REFUND'`,
      [w.id],
    );
    expect(row).toEqual({ processed: 15, other: 0 });
    const audit = await auditWallet(c, w.id);
    expectConsistent(audit);
    expect(audit.balance).toBe('1000.00');
  });

  test('same Idempotency-Key used concurrently for different wallets: one wins, others conflict', async () => {
    const wallets = await Promise.all(Array.from({ length: 6 }, () => openWallet(c, '10.00')));
    const key = uniq('contested');
    const ext = uniq('contested-ext');
    const results = await Promise.allSettled(
      wallets.map((w) => c.wagers.execute(wager(w, 'BET', '1.00', { externalTransactionId: ext }), meta(key))),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    for (const r of results) {
      if (r.status === 'rejected') expect(r.reason).toBeInstanceOf(IdempotencyConflictError);
    }
    const total = await sql<{ n: number }>(c, `SELECT count(*)::int AS n FROM wager_transactions WHERE idempotency_key = ?`, [
      key,
    ]);
    expect(total[0]?.n).toBe(1);
  });

  test('randomised mixed load with duplicates on 5 hot wallets keeps every invariant', async () => {
    const wallets = await Promise.all(Array.from({ length: 5 }, () => openWallet(c, '500.00')));
    const commands: { cmd: WagerCommand; key: string }[] = [];
    let rnd = 42;
    const rand = () => {
      rnd = (rnd * 1103515245 + 12345) % 2 ** 31;
      return rnd / 2 ** 31;
    };
    for (const w of wallets) {
      for (let i = 0; i < 40; i++) {
        const amount = `${1 + Math.floor(rand() * 60)}.${String(Math.floor(rand() * 100)).padStart(2, '0')}`;
        const betCmd = wager(w, 'BET', amount, { roundId: `round-${i}` });
        commands.push({ cmd: betCmd, key: uniq('k') });
        const roll = rand();
        const ref = { roundId: `round-${i}`, referenceExternalTransactionId: betCmd.externalTransactionId };
        if (roll < 0.3) commands.push({ cmd: wager(w, 'WIN', amount, ref), key: uniq('k') });
        else if (roll < 0.5) commands.push({ cmd: wager(w, 'LOSS', '0.00', ref), key: uniq('k') });
        else if (roll < 0.7) commands.push({ cmd: wager(w, 'REFUND', amount, ref), key: uniq('k') });
        else if (roll < 0.85) commands.push({ cmd: wager(w, 'ROLLBACK', amount, ref), key: uniq('k') });
      }
    }
    // shuffle and duplicate ~25% of the submissions (provider retries)
    const submissions = [...commands, ...commands.filter(() => rand() < 0.25)].sort(() => rand() - 0.5);
    const settled = await Promise.allSettled(submissions.map(({ cmd, key }) => c.wagers.execute(cmd, meta(key))));
    expect(settled.filter((s) => s.status === 'rejected')).toHaveLength(0);
    for (let i = 0; i < 5; i++) await c.pendingReferences.runOnce(1000);

    for (const w of wallets) expectConsistent(await auditWallet(c, w.id));
    const [stats] = await sql<{
      dup_ledger: number;
      processed_moving: number;
      ledger: number;
      reversal_dupes: number;
      pending: number;
    }>(
      c,
      `SELECT
         (SELECT count(*)::int FROM (SELECT transaction_id FROM wallet_ledger_entries GROUP BY transaction_id HAVING count(*) > 1) d) AS dup_ledger,
         (SELECT count(*)::int FROM wager_transactions WHERE status = 'PROCESSED' AND kind <> 'LOSS') AS processed_moving,
         (SELECT count(*)::int FROM wallet_ledger_entries) AS ledger,
         (SELECT count(*)::int FROM (SELECT reference_transaction_id FROM wager_transactions
             WHERE status = 'PROCESSED' AND kind IN ('REFUND','ROLLBACK') GROUP BY 1 HAVING count(*) > 1) r) AS reversal_dupes,
         (SELECT count(*)::int FROM wager_transactions WHERE status IN ('PENDING','PENDING_REFERENCE')) AS pending`,
    );
    expect(stats).toEqual({
      dup_ledger: 0,
      processed_moving: stats?.ledger ?? -1,
      ledger: stats?.ledger ?? -1,
      reversal_dupes: 0,
      pending: 0,
    });
    const conflicts = await c.metrics.valueOf('wallet_duplicates_detected_total', { type: 'idempotent_replay' });
    expect(conflicts).toBeGreaterThan(0);
  });
});
