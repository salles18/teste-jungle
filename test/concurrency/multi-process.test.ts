import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { SendMessageCommand, type SQSClient } from '@aws-sdk/client-sqs';
import type { Subprocess } from 'bun';
import type { Container } from '../../src/bootstrap/container';
import { createSqsClient, ensureQueues, pingSqs } from '../../src/infrastructure/sqs/sqs';
import { auditWallet, expectConsistent, resetDatabase, sql, TEST_DATABASE_URL, testContainer } from '../helpers/db';
import { uniq } from '../helpers/fixtures';
import { sqsReachable } from '../helpers/sqs';

/**
 * Three independent OS processes running src/main.ts against the same PostgreSQL.
 * Nothing is shared between them except the database (and the queue when available).
 */
const BASE_PORT = 3300 + Math.floor(Math.random() * 500);
const sqsEndpoint = process.env.SQS_ENDPOINT ?? 'http://localhost:4566';
const run = Date.now().toString(36);
const queueEnv = {
  SQS_ENDPOINT: sqsEndpoint,
  SQS_WAGER_QUEUE: `mp-wager-${run}.fifo`,
  SQS_WAGER_DLQ: `mp-dlq-${run}.fifo`,
  SQS_EVENTS_QUEUE: `mp-events-${run}.fifo`,
  SQS_WAIT_TIME_SECONDS: '1',
};

let c: Container;
let sqs: SQSClient | null = null;
const procs = new Map<number, Subprocess>();

async function start(index: number, withSqs: boolean): Promise<string> {
  const port = BASE_PORT + index;
  const proc = Bun.spawn([process.execPath, 'run', 'src/main.ts'], {
    env: {
      ...process.env,
      ...queueEnv,
      DATABASE_URL: TEST_DATABASE_URL,
      PORT: String(port),
      INSTANCE_ID: `instance-${index}`,
      LOG_LEVEL: 'warn',
      DB_POOL_MAX: '10',
      RUN_SQS_CONSUMER: String(withSqs),
      RUN_OUTBOX_PUBLISHER: String(withSqs),
      RUN_PENDING_REFERENCE_WORKER: 'true',
      PENDING_REFERENCE_BASE_DELAY_MS: '50',
      PENDING_REFERENCE_MAX_DELAY_MS: '200',
      PENDING_REFERENCE_POLL_INTERVAL_MS: '100',
    },
    stdout: 'ignore',
    stderr: 'inherit',
  });
  procs.set(index, proc);
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${url}/health/live`)).ok) return url;
    } catch {
      /* not up yet */
    }
    await Bun.sleep(100);
  }
  throw new Error(`instance ${index} did not start`);
}

async function killHard(index: number): Promise<void> {
  const proc = procs.get(index);
  if (!proc) return;
  proc.kill('SIGKILL');
  await proc.exited;
  procs.delete(index);
}

async function post(url: string, path: string, body: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, any> };
}

function wagerBody(w: { walletId: string; playerId: string }, patch: Record<string, unknown> = {}) {
  return {
    providerId: 'prov-mp',
    externalTransactionId: uniq('mp'),
    walletId: w.walletId,
    playerId: w.playerId,
    roundId: 'r1',
    gameId: 'g1',
    kind: 'BET',
    amount: '10.00',
    currency: 'BRL',
    ...patch,
  };
}

let urls: string[] = [];
let sqsAvailable = false;
const sqsTest = (await sqsReachable(sqsEndpoint)) && process.env.SQS_EMULATOR !== 'moto' ? test : test.skip;

beforeAll(async () => {
  await resetDatabase();
  c = await testContainer(queueEnv);
  try {
    sqs = createSqsClient(c.config);
    await pingSqs(sqs, 1500);
    if (process.env.SQS_EMULATOR === 'moto') throw new Error('moto Date-header quirk: SQS roles not started in child processes');
    await ensureQueues(sqs, c.config);
    sqsAvailable = true;
  } catch {
    sqsAvailable = false;
  }
  urls = await Promise.all([0, 1, 2].map((i) => start(i, sqsAvailable)));
});

afterAll(async () => {
  for (const index of [...procs.keys()]) await killHard(index);
  sqs?.destroy();
  await c?.close();
});

describe('three independent instances', () => {
  test('100.00 vs 2x80.00 sent to two different instances', async () => {
    const w = (await post(urls[0] as string, '/wallets', { playerId: uniq('mp'), currency: 'BRL', initialBalance: '100.00' }))
      .json as {
      walletId: string;
      playerId: string;
    };
    const [a, b] = await Promise.all([
      post(urls[1] as string, '/wagering/transactions', wagerBody(w, { amount: '80.00' }), { 'Idempotency-Key': uniq('mpk') }),
      post(urls[2] as string, '/wagering/transactions', wagerBody(w, { amount: '80.00' }), { 'Idempotency-Key': uniq('mpk') }),
    ]);
    expect([a.status, b.status].sort()).toEqual([201, 422]);
    const audit = await auditWallet(c, w.walletId);
    expectConsistent(audit);
    expect(audit.balance).toBe('20.00');
  });

  test('30 BETs of 10.00 (each also retried on another instance) over 100.00: exactly 10 debits', async () => {
    const w = (await post(urls[0] as string, '/wallets', { playerId: uniq('mp'), currency: 'BRL', initialBalance: '100.00' }))
      .json as {
      walletId: string;
      playerId: string;
    };
    const requests = Array.from({ length: 30 }, () => ({ body: wagerBody(w), key: uniq('mpk') }));
    const responses = await Promise.all(
      requests.flatMap((r, i) => [
        post(urls[i % 3] as string, '/wagering/transactions', r.body, { 'Idempotency-Key': r.key }),
        post(urls[(i + 1) % 3] as string, '/wagering/transactions', r.body, { 'Idempotency-Key': r.key }),
      ]),
    );
    expect(responses.every((r) => [200, 201, 422].includes(r.status))).toBe(true);
    const audit = await auditWallet(c, w.walletId);
    expectConsistent(audit);
    expect(audit.balance).toBe('0.00');
    const [row] = await sql<{ processed: number; rejected: number }>(
      c,
      `SELECT count(*) FILTER (WHERE status = 'PROCESSED')::int AS processed, count(*) FILTER (WHERE status = 'REJECTED')::int AS rejected
         FROM wager_transactions WHERE wallet_id = ? AND kind = 'BET'`,
      [w.walletId],
    );
    expect(row).toEqual({ processed: 10, rejected: 20 });
    // each duplicate pair maps to a single transaction id
    for (let i = 0; i < 30; i++) {
      expect(responses[2 * i]?.json.transactionId).toBe(responses[2 * i + 1]?.json.transactionId);
    }
  });

  test('crash (SIGKILL) and restart: pending reference resolved by a fresh instance, state consistent', async () => {
    const w = (await post(urls[0] as string, '/wallets', { playerId: uniq('mp'), currency: 'BRL', initialBalance: '100.00' }))
      .json as {
      walletId: string;
      playerId: string;
    };
    const betExt = uniq('late');
    const refund = await post(
      urls[0] as string,
      '/wagering/transactions',
      wagerBody(w, { kind: 'REFUND', amount: '25.00', referenceExternalTransactionId: betExt }),
      {
        'Idempotency-Key': uniq('mpk'),
      },
    );
    expect(refund.status).toBe(202);
    // kill every instance abruptly
    for (const i of [0, 1, 2]) await killHard(i);
    // the BET arrives while nothing runs (written by another writer: this test process)
    const { wagers } = c;
    await wagers.execute(
      { ...wagerBody(w, { externalTransactionId: betExt, amount: '25.00' }), kind: 'BET', referenceExternalTransactionId: null },
      { idempotencyKey: uniq('mpk'), correlationId: null, causationId: null, channel: 'http' },
    );
    // restart a single instance: its worker picks the pending refund up from the database
    urls[0] = await start(0, sqsAvailable);
    let status = '';
    for (let i = 0; i < 50 && status !== 'PROCESSED'; i++) {
      await Bun.sleep(100);
      status = (await c.wagers.getById(refund.json.transactionId as string)).status;
    }
    expect(status).toBe('PROCESSED');
    const audit = await auditWallet(c, w.walletId);
    expectConsistent(audit);
    expect(audit.balance).toBe('100.00');
    urls[1] = await start(1, sqsAvailable);
    urls[2] = await start(2, sqsAvailable);
  });

  sqsTest('three SQS consumers on one queue: duplicates applied once (needs LocalStack)', async () => {
    if (!sqsAvailable || !sqs) throw new Error('SQS reachable at load time but queue setup failed');
    const wallets = [];
    for (let i = 0; i < 4; i++) {
      wallets.push(
        (await post(urls[0] as string, '/wallets', { playerId: uniq('mpq'), currency: 'BRL', initialBalance: '50.00' })).json as {
          walletId: string;
          playerId: string;
        },
      );
    }
    const queueUrl = (await ensureQueues(sqs, c.config)).wager;
    for (const w of wallets) {
      for (let i = 0; i < 6; i++) {
        const body = JSON.stringify({ idempotencyKey: uniq('q'), transaction: wagerBody(w) });
        // each operation published twice with different dedup ids (producer retry)
        for (let copy = 0; copy < 2; copy++) {
          await sqs.send(
            new SendMessageCommand({
              QueueUrl: queueUrl,
              MessageBody: body,
              MessageGroupId: w.walletId,
              MessageDeduplicationId: uniq('d'),
            }),
          );
        }
      }
    }
    for (let i = 0; i < 100; i++) {
      const [row] = await sql<{ n: number }>(c, `SELECT count(*)::int AS n FROM inbox_messages WHERE status <> 'RECEIVED'`);
      if ((row?.n ?? 0) >= 48) break;
      await Bun.sleep(200);
    }
    for (const w of wallets) {
      const audit = await auditWallet(c, w.walletId);
      expectConsistent(audit);
      expect(audit.balance).toBe('0.00'); // 5 x 10.00 debited, 6th rejected, duplicates ignored
    }
  });
});
