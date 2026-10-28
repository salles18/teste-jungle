import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import type { EntityManager } from '@mikro-orm/postgresql';
import type { Container } from '../../src/bootstrap/container';
import { RetryPolicy } from '../../src/domain/shared/retry-policy';
import { OutboxPublisher } from '../../src/infrastructure/outbox/outbox-publisher';
import { createSqsClient, ensureQueues, pingSqs, type QueueUrls } from '../../src/infrastructure/sqs/sqs';
import { SqsEventPublisher } from '../../src/infrastructure/sqs/sqs-event-publisher';
import { SqsWagerConsumer } from '../../src/infrastructure/sqs/sqs-wager-consumer';
import { WagerMessageHandler } from '../../src/infrastructure/sqs/wager-message-handler';
import { auditWallet, expectConsistent, resetDatabase, sql, testContainer } from '../helpers/db';
import { openWallet, uniq, wager } from '../helpers/fixtures';
import { sqsReachable } from '../helpers/sqs';

/**
 * Real SQS protocol against LocalStack (docker compose up localstack).
 * Endpoint: SQS_ENDPOINT (default http://localhost:4566).
 * If unreachable the suite is skipped with a loud message; REQUIRE_SQS=1 turns that into a failure.
 */
const endpoint = process.env.SQS_ENDPOINT ?? 'http://localhost:4566';
const run = Date.now().toString(36);
const env = {
  SQS_ENDPOINT: endpoint,
  SQS_WAGER_QUEUE: `wager-transactions-${run}.fifo`,
  SQS_WAGER_DLQ: `wager-transactions-dlq-${run}.fifo`,
  SQS_EVENTS_QUEUE: `wallet-events-${run}.fifo`,
  SQS_VISIBILITY_TIMEOUT_SECONDS: '5',
  SQS_WAIT_TIME_SECONDS: '1',
};

const available = await sqsReachable(endpoint);
const sqsTest = available ? test : test.skip;
let c: Container;
let sqs: SQSClient;
let urls: QueueUrls;
let consumer: SqsWagerConsumer;

beforeAll(async () => {
  if (!available) return;
  c = await testContainer(env);
  sqs = createSqsClient(c.config);
  if (process.env.SQS_EMULATOR === 'moto') {
    // moto (Werkzeug) on Windows sends two Date headers; the SDK's clock-skew logic then
    // computes NaN. Keep the first value. Not needed for LocalStack or AWS.
    sqs.middlewareStack.add(
      (next) => async (args) => {
        const out = (await next(args)) as { response?: { headers?: Record<string, string> } };
        const date = out.response?.headers?.date;
        if (out.response?.headers && date?.includes('GMT,')) out.response.headers.date = `${date.split('GMT,')[0]}GMT`;
        return out as never;
      },
      { step: 'deserialize', priority: 'low' },
    );
  }
  await pingSqs(sqs, 2000);
  await resetDatabase();
  urls = await ensureQueues(sqs, c.config);
  const handler = new WagerMessageHandler(
    'localstack-test',
    c.uow,
    c.wagers,
    new RetryPolicy({ maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0 }),
    c.clock,
    c.metrics,
    c.logger,
  );
  consumer = new SqsWagerConsumer(
    sqs,
    handler,
    { queueUrl: urls.wager, dlqUrl: urls.dlq, waitTimeSeconds: 1, maxMessages: 10, shutdownGraceMs: 5000 },
    c.logger,
  );
});

afterAll(async () => {
  sqs?.destroy();
  await c?.close();
});

async function send(walletId: string, transaction: object, idempotencyKey = uniq('sqs-key')): Promise<string> {
  const out = await sqs.send(
    new SendMessageCommand({
      QueueUrl: urls.wager,
      MessageBody: JSON.stringify({ idempotencyKey, transaction }),
      MessageGroupId: walletId,
      MessageDeduplicationId: uniq('dedup'),
    }),
  );
  return out.MessageId ?? '';
}

async function drainConsumer(): Promise<void> {
  for (let i = 0; i < 10; i++) if ((await consumer.pollOnce()) === 0) return;
}

async function queueDepth(url: string): Promise<number> {
  const out = await sqs.send(
    new GetQueueAttributesCommand({
      QueueUrl: url,
      AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
    }),
  );
  return (
    Number(out.Attributes?.ApproximateNumberOfMessages ?? 0) + Number(out.Attributes?.ApproximateNumberOfMessagesNotVisible ?? 0)
  );
}

describe('SQS (LocalStack)', () => {
  sqsTest('queues are FIFO with redrive to the DLQ', async () => {
    const attrs = await sqs.send(new GetQueueAttributesCommand({ QueueUrl: urls.wager, AttributeNames: ['All'] }));
    expect(attrs.Attributes?.FifoQueue).toBe('true');
    expect(JSON.parse(attrs.Attributes?.RedrivePolicy ?? '{}').deadLetterTargetArn).toContain(env.SQS_WAGER_DLQ);
  });

  sqsTest('message -> inbox + financial effect -> ack only after commit', async () => {
    const w = await openWallet(c, '100.00');
    const messageId = await send(w.id, wager(w, 'BET', '80.00'));
    await drainConsumer();
    expect((await auditWallet(c, w.id)).balance).toBe('20.00');
    const inbox = await sql<{ status: string }>(c, `SELECT status FROM inbox_messages WHERE message_id = ?`, [messageId]);
    expect(inbox).toEqual([{ status: 'PROCESSED' }]);
    expect(await queueDepth(urls.wager)).toBe(0);
  });

  sqsTest('crash after commit, before ack: real redelivery is a no-op', async () => {
    const w = await openWallet(c, '100.00');
    await send(w.id, wager(w, 'BET', '30.00'));
    // receive + handle, but "die" before DeleteMessage, then make it visible again
    const received = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: urls.wager,
        MaxNumberOfMessages: 1,
        WaitTimeSeconds: 2,
        MessageSystemAttributeNames: ['All'],
        AttributeNames: ['All'] as never,
      }),
    );
    const m = received.Messages?.[0];
    if (!m?.MessageId || !m.Body) throw new Error('no message received');
    const handler = new WagerMessageHandler(
      'localstack-test',
      c.uow,
      c.wagers,
      new RetryPolicy({ maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0 }),
      c.clock,
      c.metrics,
      c.logger,
    );
    expect((await handler.handle({ messageId: m.MessageId, body: m.Body, receiveCount: 1 })).action).toBe('ack');
    await sqs.send(
      new ChangeMessageVisibilityCommand({ QueueUrl: urls.wager, ReceiptHandle: m.ReceiptHandle, VisibilityTimeout: 0 }),
    );
    await drainConsumer();
    const audit = await auditWallet(c, w.id);
    expect(audit.balance).toBe('70.00');
    expect(audit.entries).toBe(2);
    expect(await queueDepth(urls.wager)).toBe(0);
  });

  sqsTest('same operation published twice (producer retry) is applied once', async () => {
    const w = await openWallet(c, '100.00');
    const cmd = wager(w, 'BET', '10.00');
    const k = uniq('sqs-key');
    await send(w.id, cmd, k);
    await send(w.id, cmd, k);
    await drainConsumer();
    expect((await auditWallet(c, w.id)).balance).toBe('90.00');
  });

  sqsTest('invalid message is moved to the DLQ', async () => {
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: urls.wager,
        MessageBody: '{"nope":true}',
        MessageGroupId: 'bad',
        MessageDeduplicationId: uniq('d'),
      }),
    );
    await drainConsumer();
    const dlq = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: urls.dlq,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 2,
        MessageAttributeNames: ['All'],
      }),
    );
    expect(dlq.Messages?.some((m) => m.Body === '{"nope":true}')).toBe(true);
    expect(await queueDepth(urls.wager)).toBe(0);
  });

  sqsTest('outbox events reach wallet-events.fifo with envelope and per-wallet group', async () => {
    const w = await openWallet(c, '15.00');
    const publisher = new OutboxPublisher(
      c.outboxStore,
      new SqsEventPublisher(sqs, urls.events),
      new RetryPolicy({ maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0 }),
      c.metrics,
      c.logger,
      { owner: 'localstack', batchSize: 50, leaseMs: 10_000 },
    );
    while ((await publisher.publishOnce()).claimed > 0) {
      /* drain */
    }
    // other wallets' events are in the queue too; read until this wallet's group shows up
    const mine: { group: string | undefined; env: Record<string, any> }[] = [];
    for (let i = 0; i < 20 && mine.length === 0; i++) {
      const out = await sqs.send(
        new ReceiveMessageCommand({
          QueueUrl: urls.events,
          MaxNumberOfMessages: 10,
          WaitTimeSeconds: 1,
          MessageSystemAttributeNames: ['All'],
          AttributeNames: ['All'] as never,
        }),
      );
      for (const m of out.Messages ?? []) {
        if (m.Attributes?.MessageGroupId === w.id)
          mine.push({ group: m.Attributes.MessageGroupId, env: JSON.parse(m.Body ?? '{}') });
        await sqs.send(new DeleteMessageCommand({ QueueUrl: urls.events, ReceiptHandle: m.ReceiptHandle }));
      }
    }
    expect(mine.length).toBeGreaterThan(0);
    expect(mine[0]?.env).toMatchObject({ eventType: 'WalletBalanceChanged', version: 1, aggregateId: w.id });
    expect(mine[0]?.env.data.newBalance).toEqual({ amount: '15.00', currency: 'BRL' });
  });

  sqsTest('graceful stop (the SIGTERM path): the in-flight message completes and is acked', async () => {
    const w = await openWallet(c, '100.00');
    let release: () => void = () => undefined;
    const held = new Promise<void>((r) => {
      release = r;
    });
    let locked: () => void = () => undefined;
    const isLocked = new Promise<void>((r) => {
      locked = r;
    });
    // keep the message "in flight": its transaction will wait on this wallet lock
    const holder = (c.orm.em.fork() as EntityManager).transactional(async (em) => {
      await em.execute('SELECT id FROM wallets WHERE id = ? FOR UPDATE', [w.id]);
      locked();
      await held;
    });
    await isLocked;
    await send(w.id, wager(w, 'BET', '10.00'));
    const local = new SqsWagerConsumer(
      sqs,
      new WagerMessageHandler(
        'localstack-test',
        c.uow,
        c.wagers,
        new RetryPolicy({ maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0 }),
        c.clock,
        c.metrics,
        c.logger,
      ),
      { queueUrl: urls.wager, dlqUrl: urls.dlq, waitTimeSeconds: 1, maxMessages: 10, shutdownGraceMs: 10_000 },
      c.logger,
    );
    local.start();
    let waiting = false;
    for (let i = 0; i < 100 && !waiting; i++) {
      await Bun.sleep(50);
      const [row] = await sql<{ n: number }>(
        c,
        `SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`,
      );
      waiting = (row?.n ?? 0) > 0;
    }
    expect(waiting).toBe(true);
    const stopping = local.stop(); // what main.ts does on SIGTERM
    await Bun.sleep(300);
    release();
    await holder;
    await stopping;
    expect((await auditWallet(c, w.id)).balance).toBe('90.00');
    expect(await queueDepth(urls.wager)).toBe(0); // acked before stop() resolved
  });

  sqsTest('final consistency', async () => {
    for (const { id } of await sql<{ id: string }>(c, 'SELECT id FROM wallets')) expectConsistent(await auditWallet(c, id));
  });
});
