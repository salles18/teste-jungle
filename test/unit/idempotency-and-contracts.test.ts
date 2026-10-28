import { describe, expect, test } from 'bun:test';
import { canonicalJson, wagerPayloadHash } from '../../src/application/wagering/payload-hash';
import { decodeLedgerCursor, encodeLedgerCursor } from '../../src/application/wallet/ledger-cursor';
import { WagerTransactionProcessed, WalletBalanceChanged } from '../../src/domain/events/wallet-events';
import { InboxMessage, InboxStatus } from '../../src/domain/messaging/inbox-message';
import { OutboxMessage, OutboxStatus } from '../../src/domain/messaging/outbox-message';
import { Money } from '../../src/domain/money/money';
import { RetryPolicy } from '../../src/domain/shared/retry-policy';
import { WagerTransaction } from '../../src/domain/wagering/wager-transaction';
import { Wallet } from '../../src/domain/wallet/wallet';
import { validateIdempotencyKey, validateWagerContract } from '../../src/interfaces/contracts/wager-transaction.contract';

const fields = {
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

describe('canonical JSON + payload hash', () => {
  test('key order does not matter, recursively', () => {
    expect(canonicalJson({ b: 1, a: { d: [1, { z: 1, y: 2 }], c: 'x' } })).toBe('{"a":{"c":"x","d":[1,{"y":2,"z":1}]},"b":1}');
  });

  test('refuses floats and unsupported types', () => {
    expect(() => canonicalJson({ amount: 80.5 })).toThrow(TypeError);
    expect(() => canonicalJson({ f: () => 1 })).toThrow(TypeError);
    expect(canonicalJson({ a: undefined, b: null })).toBe('{"b":null}');
  });

  test('same business fields => same hash; any field change => different hash', () => {
    const h = wagerPayloadHash(fields);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(wagerPayloadHash({ ...fields })).toBe(h);
    for (const [k, v] of Object.entries({ amount: '80.01', kind: 'WIN', roundId: 'r2', referenceExternalTransactionId: 'x' })) {
      expect(wagerPayloadHash({ ...fields, [k]: v })).not.toBe(h);
    }
  });

  test('amount is normalised by Money before hashing ("80" and "80.00" are the same payload)', () => {
    expect(wagerPayloadHash({ ...fields, amount: Money.of('80', 'BRL').amount })).toBe(wagerPayloadHash(fields));
  });

  test('a replay with the same key but a divergent payload is detectable', () => {
    const tx = WagerTransaction.create({
      ...fields,
      kind: 'BET',
      idempotencyKey: 'key-12345',
      payloadHash: wagerPayloadHash(fields),
      money: Money.of('80.00', 'BRL'),
      correlationId: null,
      now: new Date(),
    });
    expect(tx.matchesPayload(wagerPayloadHash(fields))).toBe(true);
    expect(tx.matchesPayload(wagerPayloadHash({ ...fields, amount: '81.00' }))).toBe(false);
  });
});

describe('wire contract', () => {
  test('accepts a valid BET and normalises walletId', () => {
    const out = validateWagerContract({ ...fields, walletId: fields.walletId.toUpperCase() });
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.value.walletId).toBe(fields.walletId);
  });

  test.each([
    [{ amount: 80 }, 'number amount'],
    [{ amount: '80' }, 'missing decimals'],
    [{ amount: '80.001' }, 'too many decimals'],
    [{ amount: '-1.00' }, 'negative'],
    [{ amount: '1e3' }, 'scientific'],
    [{ kind: 'OPENING' }, 'internal kind'],
    [{ currency: 'brl' }, 'lowercase currency'],
    [{ walletId: 'nope' }, 'non-uuid wallet'],
    [{ extra: 'x' }, 'unknown field'],
    [{ kind: 'REFUND' }, 'refund without reference'],
    [{ referenceExternalTransactionId: 'bet-0' }, 'bet with reference'],
    [{ kind: 'WIN', referenceExternalTransactionId: 'bet-1' }, 'self reference'],
  ])('rejects %p (%s)', (patch) => {
    expect(validateWagerContract({ ...fields, ...patch }).ok).toBe(false);
  });

  test('Idempotency-Key is mandatory and bounded', () => {
    expect(validateIdempotencyKey(undefined).ok).toBe(false);
    expect(validateIdempotencyKey('short').ok).toBe(false);
    expect(validateIdempotencyKey('has space 1234').ok).toBe(false);
    expect(validateIdempotencyKey('a'.repeat(129)).ok).toBe(false);
    expect(validateIdempotencyKey('key-12345678').ok).toBe(true);
  });
});

describe('ledger cursor', () => {
  const w = fields.walletId;
  test('round-trips and is bound to its wallet', () => {
    const c = encodeLedgerCursor(w, 42);
    expect(decodeLedgerCursor(c, w)).toBe(42);
    expect(() => decodeLedgerCursor(c, '00000000-0000-4000-8000-000000000002')).toThrow();
    expect(() => decodeLedgerCursor('garbage!!', w)).toThrow();
    expect(() => decodeLedgerCursor(Buffer.from(`l1:${w}:0`).toString('base64url'), w)).toThrow();
    expect(() => decodeLedgerCursor(Buffer.from(`l1:${w}:1 OR 1=1`).toString('base64url'), w)).toThrow();
  });
});

describe('RetryPolicy', () => {
  test('exponential, capped, jitter within bounds, exhaustion', () => {
    const p = new RetryPolicy({ maxAttempts: 4, baseDelayMs: 100, maxDelayMs: 500, jitterRatio: 0 });
    expect([1, 2, 3, 4, 5].map((a) => p.delayAfter(a))).toEqual([100, 200, 400, 500, 500]);
    expect(p.isExhausted(3)).toBe(false);
    expect(p.isExhausted(4)).toBe(true);
    const low = new RetryPolicy({ maxAttempts: 4, baseDelayMs: 100, maxDelayMs: 500, jitterRatio: 0.5 }, () => 0);
    const high = new RetryPolicy({ maxAttempts: 4, baseDelayMs: 100, maxDelayMs: 500, jitterRatio: 0.5 }, () => 0.999);
    expect(low.delayAfter(3)).toBe(200);
    expect(high.delayAfter(3)).toBe(400);
    expect(() => new RetryPolicy({ maxAttempts: 0, baseDelayMs: 1, maxDelayMs: 1 })).toThrow();
  });
});

describe('Outbox / Inbox messages', () => {
  const now = new Date('2026-01-01T00:00:00Z');
  const { wallet, openingEntry } = Wallet.open({
    playerId: 'p1',
    currency: 'BRL',
    initialBalance: Money.of('10.00', 'BRL'),
    openingTransactionId: 'tx',
    now,
  });

  test('event envelope: types, ISO dates, money as strings', () => {
    if (!openingEntry) throw new Error('expected entry');
    const event = WalletBalanceChanged.from(wallet, openingEntry, { correlationId: 'c', causationId: 'k', occurredAt: now });
    const env = event.toEnvelope();
    expect(env.eventType).toBe('WalletBalanceChanged');
    expect(env.version).toBe(1);
    expect(env.occurredAt).toBe('2026-01-01T00:00:00.000Z');
    expect(env.data.newBalance).toEqual({ amount: '10.00', currency: 'BRL' });
    expect(JSON.stringify(env)).not.toMatch(/"amount":\d/);
    expect(WagerTransactionProcessed.TYPE).toBe('WagerTransactionProcessed');
  });

  test('outbox retries with backoff, then goes DEAD; published is final', () => {
    if (!openingEntry) throw new Error('expected entry');
    const policy = new RetryPolicy({ maxAttempts: 2, baseDelayMs: 1000, maxDelayMs: 1000, jitterRatio: 0 });
    const event = WalletBalanceChanged.from(wallet, openingEntry, { correlationId: null, causationId: null, occurredAt: now });
    const msg = OutboxMessage.fromEvent(event, now);
    const claimed = OutboxMessage.rehydrate({ ...snapshot(msg), attempts: 1 });
    claimed.recordFailure('boom', policy, now);
    expect(claimed.status).toBe(OutboxStatus.PENDING);
    expect(claimed.nextAttemptAt.getTime()).toBe(now.getTime() + 1000);
    const again = OutboxMessage.rehydrate({ ...snapshot(claimed), attempts: 2 });
    again.recordFailure('boom', policy, now);
    expect(again.status).toBe(OutboxStatus.DEAD);

    const ok = OutboxMessage.fromEvent(event, now);
    ok.markPublished(now);
    expect(() => ok.markPublished(now)).toThrow();
  });

  test('inbox: processed and dead-lettered are terminal', () => {
    const inbox = InboxMessage.rehydrate({
      id: 'i',
      consumerName: 'c',
      messageId: 'm',
      status: InboxStatus.RECEIVED,
      attempts: 0,
      lastError: null,
      result: null,
      transactionId: null,
      firstReceivedAt: now,
      lastReceivedAt: now,
      processedAt: null,
    });
    inbox.beginAttempt(now);
    expect(inbox.attempts).toBe(1);
    inbox.markProcessed({ outcome: 'APPLIED', transactionId: 't', transactionStatus: 'PROCESSED' }, now);
    expect(inbox.isCompleted()).toBe(true);
    expect(() => inbox.markDeadLettered('x', now)).toThrow();
    expect(() => inbox.beginAttempt(now)).toThrow();
  });
});

function snapshot(m: OutboxMessage) {
  return {
    id: m.id,
    eventType: m.eventType,
    eventVersion: m.eventVersion,
    aggregateType: m.aggregateType,
    aggregateId: m.aggregateId,
    messageGroupId: m.messageGroupId,
    payload: m.payload,
    status: m.status,
    attempts: m.attempts,
    nextAttemptAt: m.nextAttemptAt,
    lockedBy: m.lockedBy,
    lockedUntil: m.lockedUntil,
    lastError: m.lastError,
    publishedAt: m.publishedAt,
    occurredAt: m.occurredAt,
    createdAt: m.createdAt,
  };
}
