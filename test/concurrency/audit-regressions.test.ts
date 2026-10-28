import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { EntityManager } from '@mikro-orm/postgresql';
import type { INestApplication } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { IdempotencyConflictError } from '../../src/application/errors';
import type { Container } from '../../src/bootstrap/container';
import { createHttpApp } from '../../src/bootstrap/http-app';
import { RetryPolicy } from '../../src/domain/shared/retry-policy';
import { FailureCode } from '../../src/domain/wagering/wager-types';
import { WagerMessageHandler } from '../../src/infrastructure/sqs/wager-message-handler';
import { auditWallet, expectConsistent, resetDatabase, sql, testContainer } from '../helpers/db';
import { meta, openWallet, uniq, wager } from '../helpers/fixtures';

/**
 * Adversarial scenarios from the technical audit. Every operation is fired at once
 * against the real PostgreSQL (pool of 60 connections); assertions read persisted state.
 */
let c: Container;
let app: INestApplication;
let base: string;

beforeAll(async () => {
  await resetDatabase();
  c = await testContainer({ DB_POOL_MAX: '60' });
  app = await createHttpApp(c, null);
  // Fault injection: with this header the request runs (and commits) normally,
  // but the socket is destroyed instead of sending the response.
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (req.headers['x-test-drop-response']) {
      const drop = () => {
        req.socket.destroy();
        return res;
      };
      res.json = drop as unknown as Response['json'];
      res.send = drop as unknown as Response['send'];
    }
    next();
  });
  await app.listen(0);
  base = (await app.getUrl()).replace('[::1]', '127.0.0.1');
});

afterAll(async () => {
  await app?.close();
  await c?.close();
});

async function postWager(body: unknown, key: string, extra: Record<string, string> = {}) {
  const res = await fetch(`${base}/wagering/transactions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'Idempotency-Key': key, ...extra },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

async function countRows(query: string, params: unknown[]): Promise<number> {
  const [row] = await sql<{ n: number }>(c, query, params);
  return row?.n ?? -1;
}

function handler(): WagerMessageHandler {
  return new WagerMessageHandler(
    'audit-consumer',
    c.uow,
    c.wagers,
    new RetryPolicy({ maxAttempts: 5, baseDelayMs: 0, maxDelayMs: 0 }),
    c.clock,
    c.metrics,
    c.logger,
  );
}

describe('audit: eliminatory scenarios', () => {
  test('1. 50 simultaneous HTTP requests, same key and payload: one 201, 49 replays, one debit', async () => {
    const w = await openWallet(c, '100.00');
    const body = { ...wager(w, 'BET', '80.00'), walletId: w.id };
    const key = uniq('audit-k1');
    const responses = await Promise.all(Array.from({ length: 50 }, () => postWager(body, key)));
    const statuses = responses.map((r) => r.status);
    expect(statuses.filter((s) => s === 201)).toHaveLength(1);
    expect(statuses.filter((s) => s === 200)).toHaveLength(49);
    expect(new Set(responses.map((r) => r.json.transactionId)).size).toBe(1);
    expect(responses.every((r) => r.json.balanceAfter === '20.00')).toBe(true);
    expect(responses.filter((r) => r.json.idempotentReplay === true)).toHaveLength(49);
    expect(await countRows('SELECT count(*)::int AS n FROM wager_transactions WHERE idempotency_key = ?', [key])).toBe(1);
    expect(
      await countRows(`SELECT count(*)::int AS n FROM wallet_ledger_entries WHERE wallet_id = ? AND direction = 'DEBIT'`, [w.id]),
    ).toBe(1);
    expectConsistent(await auditWallet(c, w.id));
  });

  test('1b. stress (regression for the fast-path lookup race): 20 rounds x 50 same-key requests, never a false conflict', async () => {
    for (let round = 0; round < 20; round++) {
      const w = await openWallet(c, '100.00');
      const cmd = wager(w, 'BET', '80.00');
      const m = meta();
      const results = await Promise.allSettled(Array.from({ length: 50 }, () => c.wagers.execute(cmd, m)));
      const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
      expect(rejected.map((r) => String((r.reason as { code?: string }).code ?? r.reason))).toEqual([]);
      const fulfilled = results.filter((r) => r.status === 'fulfilled').map((r) => r.value);
      expect(fulfilled.filter((r) => !r.idempotentReplay)).toHaveLength(1);
      const audit = await auditWallet(c, w.id);
      expect(audit.balance).toBe('20.00');
      expect(audit.entries).toBe(2);
    }
  });

  test('2. same key, 20 different payloads at once: exactly one executes, the rest IDEMPOTENCY_KEY_REUSED', async () => {
    const w = await openWallet(c, '100.00');
    const key = uniq('audit-k2');
    const ext = uniq('audit-ext2');
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, (_, i) =>
        c.wagers.execute(wager(w, 'BET', `${i + 1}.00`, { externalTransactionId: ext }), meta(key)),
      ),
    );
    const ok = results.filter((r) => r.status === 'fulfilled');
    const failed = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    // a request whose payload equals the winner's is a legitimate replay; all others conflict
    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(19);
    for (const f of failed) {
      expect(f.reason).toBeInstanceOf(IdempotencyConflictError);
      expect((f.reason as IdempotencyConflictError).code).toBe('IDEMPOTENCY_KEY_REUSED');
    }
    expect(await countRows('SELECT count(*)::int AS n FROM wager_transactions WHERE idempotency_key = ?', [key])).toBe(1);
    const audit = await auditWallet(c, w.id);
    expectConsistent(audit);
    expect(audit.entries).toBe(2); // OPENING + one BET
  });

  test('3. same externalTransactionId under 20 different keys at once: one executes, the rest EXTERNAL_TRANSACTION_CONFLICT', async () => {
    const w = await openWallet(c, '100.00');
    const cmd = wager(w, 'BET', '10.00');
    const results = await Promise.allSettled(Array.from({ length: 20 }, () => c.wagers.execute(cmd, meta())));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    for (const r of results) {
      if (r.status === 'rejected') expect((r.reason as IdempotencyConflictError).code).toBe('EXTERNAL_TRANSACTION_CONFLICT');
    }
    const audit = await auditWallet(c, w.id);
    expect(audit.balance).toBe('90.00');
    expect(audit.entries).toBe(2);
  });

  test('5a. 50 simultaneous redeliveries of the same broker message: applied once', async () => {
    const w = await openWallet(c, '100.00');
    const message = {
      messageId: uniq('audit-msg'),
      body: JSON.stringify({ idempotencyKey: uniq('audit-k5'), transaction: wager(w, 'BET', '80.00') }),
      receiveCount: 1,
    };
    const decisions = await Promise.all(
      Array.from({ length: 50 }, (_, i) => handler().handle({ ...message, receiveCount: i + 1 })),
    );
    expect(decisions.filter((d) => d.action === 'ack' && d.outcome === 'processed')).toHaveLength(1);
    expect(decisions.filter((d) => d.action === 'ack' && d.outcome === 'duplicate')).toHaveLength(49);
    const audit = await auditWallet(c, w.id);
    expectConsistent(audit);
    expect(audit.balance).toBe('20.00');
    expect(audit.entries).toBe(2);
    expect(await countRows('SELECT count(*)::int AS n FROM inbox_messages WHERE message_id = ?', [message.messageId])).toBe(1);
  });

  test('5b. the same operation as 50 distinct broker messages at once: applied once', async () => {
    const w = await openWallet(c, '100.00');
    const body = JSON.stringify({ idempotencyKey: uniq('audit-k5b'), transaction: wager(w, 'BET', '80.00') });
    const decisions = await Promise.all(
      Array.from({ length: 50 }, () => handler().handle({ messageId: uniq('audit-msg'), body, receiveCount: 1 })),
    );
    expect(decisions.every((d) => d.action === 'ack')).toBe(true);
    const audit = await auditWallet(c, w.id);
    expectConsistent(audit);
    expect(audit.balance).toBe('20.00');
    expect(audit.entries).toBe(2);
  });

  test('6. duplicated REFUNDs and ROLLBACKs arrive before their BET; two workers race: one reversal applied', async () => {
    const w = await openWallet(c, '100.00');
    const betExt = uniq('audit-bet6');
    const ref = { referenceExternalTransactionId: betExt };
    const refundKey = uniq('audit-refund-key');
    const refundCmd = wager(w, 'REFUND', '40.00', ref);
    const submissions = [
      // same REFUND retried 5x with the same key (provider retry)
      ...Array.from({ length: 5 }, () => c.wagers.execute(refundCmd, meta(refundKey))),
      // 5 distinct REFUNDs and 5 distinct ROLLBACKs of the same BET
      ...Array.from({ length: 5 }, () => c.wagers.execute(wager(w, 'REFUND', '40.00', ref), meta())),
      ...Array.from({ length: 5 }, () => c.wagers.execute(wager(w, 'ROLLBACK', '40.00', ref), meta())),
    ];
    const early = await Promise.all(submissions);
    expect(early.every((r) => r.transaction.status === 'PENDING_REFERENCE')).toBe(true);
    expect(new Set(early.slice(0, 5).map((r) => r.transaction.id)).size).toBe(1);

    await c.wagers.execute(wager(w, 'BET', '40.00', { externalTransactionId: betExt }), meta());
    const second = await testContainer();
    try {
      for (let i = 0; i < 3; i++) await Promise.all([c.pendingReferences.runOnce(100), second.pendingReferences.runOnce(100)]);
    } finally {
      await second.close();
    }
    const rows = await sql<{ status: string; failure_code: string | null; n: number }>(
      c,
      `SELECT status, failure_code, count(*)::int AS n FROM wager_transactions
        WHERE wallet_id = ? AND kind IN ('REFUND','ROLLBACK') GROUP BY 1, 2 ORDER BY 1`,
      [w.id],
    );
    expect(rows).toEqual([
      { status: 'PROCESSED', failure_code: null, n: 1 },
      { status: 'REJECTED', failure_code: FailureCode.REFERENCE_ALREADY_REVERSED, n: 10 },
    ]);
    const audit = await auditWallet(c, w.id);
    expectConsistent(audit);
    expect(audit.balance).toBe('100.00'); // 100 - 40 (bet) + 40 (one reversal)
  });

  test('7. response lost after COMMIT (socket destroyed): the retry replays the persisted result', async () => {
    const w = await openWallet(c, '100.00');
    const body = { ...wager(w, 'BET', '30.00'), walletId: w.id };
    const key = uniq('audit-k7');
    let networkError: unknown = null;
    try {
      await postWager(body, key, { 'x-test-drop-response': '1' });
    } catch (error) {
      networkError = error;
    }
    expect(networkError).not.toBeNull(); // the client never saw a response
    expect((await auditWallet(c, w.id)).balance).toBe('70.00'); // but the debit is committed
    const retry = await postWager(body, key);
    expect(retry.status).toBe(200);
    expect(retry.json).toMatchObject({ idempotentReplay: true, status: 'PROCESSED', balanceAfter: '70.00' });
    expect(
      await countRows(`SELECT count(*)::int AS n FROM wallet_ledger_entries WHERE wallet_id = ? AND direction = 'DEBIT'`, [w.id]),
    ).toBe(1);
  });

  test('11. database connection killed in the middle of the financial transaction: retried, applied once', async () => {
    const w = await openWallet(c, '100.00');
    let release: () => void = () => undefined;
    const held = new Promise<void>((r) => {
      release = r;
    });
    let locked: () => void = () => undefined;
    const isLocked = new Promise<void>((r) => {
      locked = r;
    });
    const holder = (c.orm.em.fork() as EntityManager).transactional(async (em) => {
      await em.execute('SELECT id FROM wallets WHERE id = ? FOR UPDATE', [w.id]);
      locked();
      await held;
    });
    await isLocked;
    // the operation opens its transaction and blocks on the wallet lock...
    const op = c.wagers.execute(wager(w, 'BET', '25.00'), meta());
    let victim: number | null = null;
    for (let i = 0; i < 50 && victim === null; i++) {
      await Bun.sleep(20);
      const [row] = await sql<{ pid: number }>(
        c,
        `SELECT pid FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE '%from "wallets"%for update%'`,
      );
      victim = row?.pid ?? null;
    }
    expect(victim).not.toBeNull();
    // ...and its backend is killed mid-transaction
    await sql(c, 'SELECT pg_terminate_backend(?)', [victim]);
    await Bun.sleep(50);
    release();
    await holder;
    const result = await op;
    expect(result.transaction.status).toBe('PROCESSED');
    expect(
      await c.metrics.valueOf('wallet_retries_total', { component: 'db_transaction', reason: 'connection' }),
    ).toBeGreaterThan(0);
    const audit = await auditWallet(c, w.id);
    expectConsistent(audit);
    expect(audit.balance).toBe('75.00');
    expect(audit.entries).toBe(2);
  });

  test('12. reconciliation: every wallet in the database is consistent after all scenarios', async () => {
    const wallets = await sql<{ id: string }>(c, 'SELECT id FROM wallets');
    expect(wallets.length).toBeGreaterThanOrEqual(8);
    for (const { id } of wallets) {
      const report = await c.wallets.reconcile(id);
      expect(report).toMatchObject({ consistent: true, difference: '0.00' });
      expectConsistent(await auditWallet(c, id));
    }
    const [dup] = await sql<{ ledger: number; reversals: number; outbox_orphans: number }>(
      c,
      `SELECT
         (SELECT count(*)::int FROM (SELECT transaction_id FROM wallet_ledger_entries GROUP BY 1 HAVING count(*) > 1) d) AS ledger,
         (SELECT count(*)::int FROM (SELECT reference_transaction_id FROM wager_transactions
             WHERE status = 'PROCESSED' AND kind IN ('REFUND','ROLLBACK') GROUP BY 1 HAVING count(*) > 1) r) AS reversals,
         (SELECT count(*)::int FROM wallet_ledger_entries e
             WHERE NOT EXISTS (SELECT 1 FROM outbox_messages o
                                WHERE o.event_type = 'WalletBalanceChanged' AND o.payload->'data'->>'ledgerEntryId' = e.id::text)) AS outbox_orphans`,
    );
    // no duplicated movement, no duplicated reversal, and every ledger entry has its WalletBalanceChanged event
    expect(dup).toEqual({ ledger: 0, reversals: 0, outbox_orphans: 0 });
  });
});
