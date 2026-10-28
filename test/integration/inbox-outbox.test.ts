import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { EntityManager } from '@mikro-orm/postgresql';
import type { Container } from '../../src/bootstrap/container';
import { OutboxMessage } from '../../src/domain/messaging/outbox-message';
import { RetryPolicy } from '../../src/domain/shared/retry-policy';
import { type EventPublisher, OutboxPublisher, type PublishResult } from '../../src/infrastructure/outbox/outbox-publisher';
import { WagerMessageHandler } from '../../src/infrastructure/sqs/wager-message-handler';
import { auditWallet, expectConsistent, resetDatabase, sql, testContainer } from '../helpers/db';
import { meta, openWallet, uniq, wager } from '../helpers/fixtures';

/**
 * These tests drive the consumer's message handler and the outbox publisher against the
 * real PostgreSQL. The broker side is an in-process recorder (the real SQS path is
 * covered by sqs-localstack.test.ts): what is under test here is the inbox/outbox
 * state machine and its atomicity with the financial writes.
 */
let c: Container;

beforeAll(async () => {
  await resetDatabase();
  c = await testContainer();
});
afterAll(async () => {
  await c?.close();
});

function handler(container = c, maxAttempts = 3): WagerMessageHandler {
  return new WagerMessageHandler(
    'test-consumer',
    container.uow,
    container.wagers,
    new RetryPolicy({ maxAttempts, baseDelayMs: 100, maxDelayMs: 1000 }),
    container.clock,
    container.metrics,
    container.logger,
  );
}

function body(cmd: object, idempotencyKey = uniq('mkey')): string {
  return JSON.stringify({ idempotencyKey, correlationId: 'corr-1', transaction: cmd });
}

describe('inbox (consumer side)', () => {
  test('message is processed once; redelivery after a crash before ack does not re-apply', async () => {
    const w = await openWallet(c, '100.00');
    const msg = { messageId: uniq('msg'), body: body(wager(w, 'BET', '80.00')), receiveCount: 1 };
    const first = await handler().handle(msg);
    expect(first).toMatchObject({ action: 'ack', outcome: 'processed', transactionStatus: 'PROCESSED' });
    // "process died after COMMIT, before DeleteMessage": the broker redelivers
    const again = await handler().handle({ ...msg, receiveCount: 2 });
    expect(again).toMatchObject({ action: 'ack', outcome: 'duplicate' });
    const audit = await auditWallet(c, w.id);
    expect(audit.balance).toBe('20.00');
    expect(audit.entries).toBe(2);
    const inbox = await sql<{ status: string; attempts: number }>(
      c,
      `SELECT status, attempts FROM inbox_messages WHERE message_id = ?`,
      [msg.messageId],
    );
    expect(inbox).toEqual([{ status: 'PROCESSED', attempts: 1 }]);
  });

  test('inbox, wallet, ledger, transaction and outbox commit together', async () => {
    const w = await openWallet(c, '10.00');
    const messageId = uniq('msg');
    await handler().handle({ messageId, body: body(wager(w, 'WIN', '5.00')), receiveCount: 1 });
    const [row] = await sql<{ inbox: number; tx: number; ledger: number; outbox: number }>(
      c,
      `SELECT (SELECT count(*)::int FROM inbox_messages i JOIN wager_transactions t ON t.id = i.transaction_id
                WHERE i.message_id = ? AND t.status = 'PROCESSED') AS inbox,
              (SELECT count(*)::int FROM wager_transactions WHERE wallet_id = ? AND kind = 'WIN') AS tx,
              (SELECT count(*)::int FROM wallet_ledger_entries WHERE wallet_id = ?) AS ledger,
              (SELECT count(*)::int FROM outbox_messages WHERE message_group_id = ?) AS outbox`,
      [messageId, w.id, w.id, w.id],
    );
    expect(row).toEqual({ inbox: 1, tx: 1, ledger: 2, outbox: 3 });
  });

  test('two concurrent deliveries of the same message serialise on the inbox row', async () => {
    const w = await openWallet(c, '100.00');
    const msg = { messageId: uniq('msg'), body: body(wager(w, 'BET', '10.00')), receiveCount: 1 };
    const results = await Promise.all(Array.from({ length: 8 }, () => handler().handle(msg)));
    expect(results.filter((r) => r.action === 'ack' && r.outcome === 'processed')).toHaveLength(1);
    expect(results.filter((r) => r.action === 'ack' && r.outcome === 'duplicate')).toHaveLength(7);
    expect((await auditWallet(c, w.id)).balance).toBe('90.00');
  });

  test('the same operation sent as two different messages is applied once (financial idempotency)', async () => {
    const w = await openWallet(c, '100.00');
    const b = body(wager(w, 'BET', '10.00'));
    await handler().handle({ messageId: uniq('msg'), body: b, receiveCount: 1 });
    const second = await handler().handle({ messageId: uniq('msg'), body: b, receiveCount: 1 });
    expect(second).toMatchObject({ action: 'ack', outcome: 'processed' });
    expect((await auditWallet(c, w.id)).balance).toBe('90.00');
  });

  test('business rejection is terminal: acked, never retried', async () => {
    const w = await openWallet(c, '1.00');
    const out = await handler().handle({ messageId: uniq('msg'), body: body(wager(w, 'BET', '5.00')), receiveCount: 1 });
    expect(out).toMatchObject({ action: 'ack', transactionStatus: 'REJECTED' });
  });

  test('invalid messages and permanent failures go to the DLQ and stay there on redelivery', async () => {
    const h = handler();
    const invalid = await h.handle({ messageId: uniq('msg'), body: '{not json', receiveCount: 1 });
    expect(invalid).toMatchObject({ action: 'dead_letter' });
    const w = await openWallet(c, '10.00');
    const noWallet = {
      messageId: uniq('msg'),
      body: body(wager({ id: crypto.randomUUID(), playerId: w.playerId }, 'BET', '1.00')),
      receiveCount: 1,
    };
    const permanent = await h.handle(noWallet);
    expect(permanent.action).toBe('dead_letter');
    expect((permanent as { reason: string }).reason).toMatch(/WALLET_NOT_FOUND/);
    expect((await h.handle(noWallet)).action).toBe('dead_letter');
    const opening = { messageId: uniq('msg'), body: body({ ...wager(w, 'BET', '1.00'), kind: 'OPENING' }), receiveCount: 1 };
    expect((await h.handle(opening)).action).toBe('dead_letter');
    const rows = await sql<{ status: string }>(c, `SELECT status FROM inbox_messages WHERE message_id = ?`, [noWallet.messageId]);
    expect(rows).toEqual([{ status: 'DEAD_LETTERED' }]);
  });

  test('transient failures (lock timeout) retry with backoff, then dead-letter after the attempt limit', async () => {
    const w = await openWallet(c, '100.00');
    // a second instance with a tiny lock_timeout and no in-transaction retries
    const impatient = await testContainer({ DB_LOCK_TIMEOUT_MS: '150', TX_RETRY_MAX_ATTEMPTS: '1' });
    let release: () => void = () => undefined;
    const held = new Promise<void>((r) => {
      release = r;
    });
    let locked: () => void = () => undefined;
    const isLocked = new Promise<void>((r) => {
      locked = r;
    });
    // another transaction holds the wallet row lock for the whole test
    const holder = (c.orm.em.fork() as EntityManager).transactional(async (em) => {
      await em.execute('SELECT id FROM wallets WHERE id = ? FOR UPDATE', [w.id]);
      locked();
      await held;
    });
    try {
      await isLocked;
      const h = handler(impatient, 3);
      const msg = { messageId: uniq('msg'), body: body(wager(w, 'BET', '1.00')) };
      const r1 = await h.handle({ ...msg, receiveCount: 1 });
      const r2 = await h.handle({ ...msg, receiveCount: 2 });
      const r3 = await h.handle({ ...msg, receiveCount: 3 });
      expect(r1.action).toBe('retry');
      expect(r2.action).toBe('retry');
      expect(r3).toMatchObject({ action: 'dead_letter' });
      expect(await impatient.metrics.valueOf('wallet_lock_conflicts_total', { type: 'lock_timeout' })).toBe(3);
      expect(await impatient.metrics.valueOf('wallet_dlq_messages_total', { reason: 'retries_exhausted' })).toBe(1);
      const inbox = await sql<{ status: string; attempts: number }>(
        c,
        `SELECT status, attempts FROM inbox_messages WHERE message_id = ?`,
        [msg.messageId],
      );
      expect(inbox).toEqual([{ status: 'DEAD_LETTERED', attempts: 3 }]);
    } finally {
      release();
      await holder;
      await impatient.close();
    }
    expect((await auditWallet(c, w.id)).balance).toBe('100.00');
  });
});

/** In-process broker double: records what was "sent"; can be told to fail or to crash after sending. */
class RecordingBroker implements EventPublisher {
  readonly sent: string[] = [];
  failNext = 0;
  crashAfterSend = false;

  async publishBatch(messages: readonly OutboxMessage[]): Promise<PublishResult> {
    await new Promise((r) => setTimeout(r, 5)); // network latency: no SQL transaction is open here
    if (this.failNext > 0) {
      this.failNext--;
      return { succeeded: [], failed: messages.map((m) => ({ id: m.id, error: 'broker unavailable' })) };
    }
    for (const m of messages) this.sent.push(m.id);
    if (this.crashAfterSend) throw new Error('process killed after send, before markPublished');
    return { succeeded: messages.map((m) => m.id), failed: [] };
  }
}

function publisher(broker: EventPublisher, owner: string, leaseMs = 30_000, container = c) {
  return new OutboxPublisher(
    container.outboxStore,
    broker,
    new RetryPolicy({ maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0 }),
    container.metrics,
    container.logger,
    { owner, batchSize: 25, leaseMs },
  );
}

async function pendingCount(): Promise<number> {
  const [row] = await sql<{ n: number }>(c, `SELECT count(*)::int AS n FROM outbox_messages WHERE status = 'PENDING'`);
  return row?.n ?? 0;
}

async function drain(p: OutboxPublisher): Promise<void> {
  for (let i = 0; i < 100; i++) if ((await p.publishOnce()).claimed === 0) return;
}

describe('outbox publisher', () => {
  test('publishes every committed event and marks it PUBLISHED', async () => {
    const w = await openWallet(c, '100.00');
    await c.wagers.execute(wager(w, 'BET', '1.00'), meta());
    const broker = new RecordingBroker();
    await drain(publisher(broker, 'pub-1'));
    expect(await pendingCount()).toBe(0);
    const published = await sql<{ n: number }>(c, `SELECT count(*)::int AS n FROM outbox_messages WHERE status = 'PUBLISHED'`);
    expect(broker.sent.length).toBe(published[0]?.n ?? -1);
    expect(new Set(broker.sent).size).toBe(broker.sent.length);
  });

  test('two concurrent publishers never claim the same message (SKIP LOCKED + lease)', async () => {
    const w = await openWallet(c, '1000.00');
    await Promise.all(Array.from({ length: 40 }, () => c.wagers.execute(wager(w, 'WIN', '1.00'), meta())));
    const before = await pendingCount();
    expect(before).toBeGreaterThanOrEqual(80);
    const brokerA = new RecordingBroker();
    const brokerB = new RecordingBroker();
    const pa = publisher(brokerA, 'pub-A');
    const pb = publisher(brokerB, 'pub-B');
    await Promise.all([drain(pa), drain(pb)]);
    const all = [...brokerA.sent, ...brokerB.sent];
    expect(new Set(all).size).toBe(all.length); // no duplicates without a crash
    expect(all.length).toBe(before);
    expect(brokerA.sent.length).toBeGreaterThan(0);
    expect(brokerB.sent.length).toBeGreaterThan(0);
    expect(await pendingCount()).toBe(0);
  });

  test('broker failure: attempts and next_attempt_at persisted, retried later', async () => {
    const w = await openWallet(c, '5.00');
    const broker = new RecordingBroker();
    broker.failNext = 1;
    const p = publisher(broker, 'pub-retry');
    const cycle = await p.publishOnce();
    expect(cycle.failed).toBeGreaterThan(0);
    const [row] = await sql<{ attempts: number; last_error: string; locked_by: string | null }>(
      c,
      `SELECT attempts, last_error, locked_by FROM outbox_messages WHERE message_group_id = ?`,
      [w.id],
    );
    expect(row).toEqual({ attempts: 1, last_error: 'broker unavailable', locked_by: null });
    await drain(p);
    expect(await pendingCount()).toBe(0);
  });

  test('crash after send, before markPublished: lease expires, another publisher re-sends (at-least-once)', async () => {
    await openWallet(c, '5.00');
    // the "dead" publisher claims a batch and sends it, then the process dies: no settle step
    const claimed = await c.outboxStore.claimBatch('pub-dead', 25, 200);
    const sentByDead = claimed.map((m) => m.id);
    expect(sentByDead.length).toBeGreaterThan(0);
    // while the lease is valid nobody else takes them
    const other = new RecordingBroker();
    expect((await publisher(other, 'pub-alive').publishOnce()).claimed).toBe(0);
    await new Promise((r) => setTimeout(r, 300));
    await drain(publisher(other, 'pub-alive'));
    expect(await pendingCount()).toBe(0);
    // the same events went out twice: consumers dedupe by eventId
    expect(sentByDead.every((id) => other.sent.includes(id))).toBe(true);
    const [row] = await sql<{ attempts: number }>(c, `SELECT attempts FROM outbox_messages WHERE id = ?`, [sentByDead[0]]);
    expect(row?.attempts).toBe(2);
  });

  test('retry time uses the database clock: an app server 1h ahead does not stall the backoff', async () => {
    const skewed = await testContainer({}, { clock: { now: () => new Date(Date.now() + 3_600_000) } });
    try {
      await drain(publisher(new RecordingBroker(), 'pub-clean'));
      await openWallet(c, '5.00');
      const broker = new RecordingBroker();
      broker.failNext = 1;
      // zero-backoff policy: the failed message must be claimable again right away
      const p = publisher(broker, 'pub-skewed', 30_000, skewed);
      expect((await p.publishOnce()).failed).toBe(1);
      const [row] = await sql<{ due: boolean }>(
        c,
        `SELECT bool_and(next_attempt_at <= now() + interval '1 second') AS due FROM outbox_messages WHERE status = 'PENDING'`,
      );
      expect(row?.due).toBe(true);
      expect((await p.publishOnce()).published).toBe(1);
    } finally {
      await skewed.close();
    }
  });

  test('a message failing beyond the budget becomes DEAD, is kept, and counted', async () => {
    await openWallet(c, '5.00');
    const broker = new RecordingBroker();
    broker.failNext = 10;
    const p = publisher(broker, 'pub-dead-letter');
    for (let i = 0; i < 3; i++) await p.publishOnce();
    const dead = await sql<{ n: number }>(c, `SELECT count(*)::int AS n FROM outbox_messages WHERE status = 'DEAD'`);
    expect(dead[0]?.n).toBeGreaterThan(0);
    expect(await c.metrics.valueOf('wallet_outbox_failures_total', { outcome: 'dead' })).toBeGreaterThan(0);
  });

  test('wallet state stays consistent across everything above', async () => {
    const wallets = await sql<{ id: string }>(c, `SELECT id FROM wallets`);
    for (const { id } of wallets) expectConsistent(await auditWallet(c, id));
  });
});
