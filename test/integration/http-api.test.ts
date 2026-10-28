import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { INestApplication } from '@nestjs/common';
import type { Container } from '../../src/bootstrap/container';
import { createHttpApp } from '../../src/bootstrap/http-app';
import { resetDatabase, testContainer } from '../helpers/db';
import { uniq } from '../helpers/fixtures';

let c: Container;
let app: INestApplication;
let base: string;

beforeAll(async () => {
  await resetDatabase();
  c = await testContainer();
  app = await createHttpApp(c, null);
  await app.listen(0);
  base = await app.getUrl();
  base = base.replace('[::1]', '127.0.0.1');
});
afterAll(async () => {
  await app?.close();
  await c?.close();
});

async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, headers: res.headers, json: text ? (JSON.parse(text) as Record<string, any>) : null };
}

async function createWallet(initialBalance = '100.00') {
  const r = await call('POST', '/wallets', { playerId: uniq('p'), currency: 'BRL', initialBalance });
  expect(r.status).toBe(201);
  return r.json as { walletId: string; playerId: string };
}

function bet(w: { walletId: string; playerId: string }, patch: Record<string, unknown> = {}) {
  return {
    providerId: 'prov-http',
    externalTransactionId: uniq('ext'),
    walletId: w.walletId,
    playerId: w.playerId,
    roundId: 'r1',
    gameId: 'g1',
    kind: 'BET',
    amount: '80.00',
    currency: 'BRL',
    ...patch,
  };
}

const key = () => ({ 'Idempotency-Key': uniq('http-key') });

describe('HTTP contract', () => {
  test('wallet: create 201, duplicate 409, invalid 400, unknown 404, bad uuid 400', async () => {
    const w = await createWallet();
    expect((await call('GET', `/wallets/${w.walletId}`)).json).toMatchObject({ balance: '100.00', version: 1 });
    const dup = await call('POST', '/wallets', { playerId: w.playerId, currency: 'BRL', initialBalance: '1.00' });
    expect(dup.status).toBe(409);
    expect(dup.json?.error.code).toBe('WALLET_ALREADY_EXISTS');
    for (const bad of [
      { initialBalance: '-1.00' },
      { initialBalance: 100 },
      { initialBalance: '1e2' },
      { currency: 'brl' },
      { extra: 1 },
    ]) {
      const r = await call('POST', '/wallets', { playerId: uniq('p'), currency: 'BRL', initialBalance: '1.00', ...bad });
      expect(r.status).toBe(400);
      expect(r.json?.error.code).toBe('VALIDATION_FAILED');
    }
    expect((await call('GET', `/wallets/${crypto.randomUUID()}`)).status).toBe(404);
    expect((await call('GET', '/wallets/not-a-uuid')).status).toBe(400);
  });

  test('wager: 201 new, 200 replay with header, 409 key reuse, 409 external conflict', async () => {
    const w = await createWallet();
    const k = key();
    const body = bet(w);
    const first = await call('POST', '/wagering/transactions', body, k);
    expect(first.status).toBe(201);
    expect(first.json).toMatchObject({ status: 'PROCESSED', balanceAfter: '20.00', idempotentReplay: false });
    const replay = await call('POST', '/wagering/transactions', body, k);
    expect(replay.status).toBe(200);
    expect(replay.headers.get('idempotent-replay')).toBe('true');
    expect(replay.json).toMatchObject({
      transactionId: first.json?.transactionId,
      idempotentReplay: true,
      balanceAfter: '20.00',
    });
    const reuse = await call('POST', '/wagering/transactions', { ...body, amount: '1.00' }, k);
    expect(reuse.status).toBe(409);
    expect(reuse.json?.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    const ext = await call('POST', '/wagering/transactions', body, key());
    expect(ext.status).toBe(409);
    expect(ext.json?.error.code).toBe('EXTERNAL_TRANSACTION_CONFLICT');
  });

  test('wager: 422 business rejection carries the REJECTED transaction', async () => {
    const w = await createWallet('10.00');
    const r = await call('POST', '/wagering/transactions', bet(w), key());
    expect(r.status).toBe(422);
    expect(r.json).toMatchObject({ status: 'REJECTED', failureCode: 'INSUFFICIENT_FUNDS', balanceAfter: '10.00' });
    const mismatch = await call('POST', '/wagering/transactions', bet(w, { playerId: 'intruder' }), key());
    expect(mismatch.status).toBe(422);
    expect(mismatch.json?.error.code).toBe('PLAYER_WALLET_MISMATCH');
  });

  test('wager: 202 PENDING_REFERENCE for an early REFUND', async () => {
    const w = await createWallet();
    const r = await call(
      'POST',
      '/wagering/transactions',
      bet(w, { kind: 'REFUND', referenceExternalTransactionId: uniq('later') }),
      key(),
    );
    expect(r.status).toBe(202);
    expect(r.json?.status).toBe('PENDING_REFERENCE');
  });

  test('wager: 400 for missing key, bad JSON, OPENING, float amount; 404 unknown wallet', async () => {
    const w = await createWallet();
    expect((await call('POST', '/wagering/transactions', bet(w))).status).toBe(400);
    expect((await call('POST', '/wagering/transactions', '{"broken"', key())).status).toBe(400);
    expect((await call('POST', '/wagering/transactions', bet(w, { kind: 'OPENING' }), key())).status).toBe(400);
    expect((await call('POST', '/wagering/transactions', bet(w, { amount: 80 }), key())).status).toBe(400);
    const nf = await call('POST', '/wagering/transactions', bet({ walletId: crypto.randomUUID(), playerId: 'x' }), key());
    expect(nf.status).toBe(404);
    expect(nf.json?.error.code).toBe('WALLET_NOT_FOUND');
  });

  test('lookup by id and by provider + external id', async () => {
    const w = await createWallet();
    const body = bet(w, { amount: '1.00' });
    const created = await call('POST', '/wagering/transactions', body, key());
    const id = created.json?.transactionId as string;
    expect((await call('GET', `/wagering/transactions/${id}`)).json?.externalTransactionId).toBe(body.externalTransactionId);
    const byExt = await call('GET', `/providers/${body.providerId}/wagering/transactions/${body.externalTransactionId}`);
    expect(byExt.json?.transactionId).toBe(id);
    expect((await call('GET', `/providers/${body.providerId}/wagering/transactions/nope`)).status).toBe(404);
  });

  test('ledger pagination with opaque cursor, limit bounds, reconciliation', async () => {
    const w = await createWallet();
    for (let i = 0; i < 4; i++) await call('POST', '/wagering/transactions', bet(w, { amount: '1.00' }), key());
    const p1 = await call('GET', `/wallets/${w.walletId}/ledger?limit=3`);
    expect(p1.json?.entries).toHaveLength(3);
    expect(p1.json?.entries[0]).toMatchObject({ direction: 'DEBIT', amount: '1.00', balanceAfter: '96.00', walletVersion: 5 });
    const p2 = await call('GET', `/wallets/${w.walletId}/ledger?limit=3&cursor=${p1.json?.nextCursor}`);
    expect(p2.json?.entries.map((e: { walletVersion: number }) => e.walletVersion)).toEqual([2, 1]);
    expect(p2.json?.nextCursor).toBeNull();
    expect((await call('GET', `/wallets/${w.walletId}/ledger?limit=0`)).status).toBe(400);
    expect((await call('GET', `/wallets/${w.walletId}/ledger?cursor=bogus`)).status).toBe(400);
    const rec = await call('POST', `/wallets/${w.walletId}/reconciliation`);
    expect(rec.status).toBe(200);
    expect(rec.json).toMatchObject({ consistent: true, difference: '0.00', checkedEntries: 5, ledgerBalance: '96.00' });
  });

  test('health, metrics, correlation id', async () => {
    expect((await call('GET', '/health/live')).json).toEqual({ status: 'ok' });
    const ready = await call('GET', '/health/ready');
    expect(ready.status).toBe(200);
    expect(ready.json?.checks.postgres).toBe('up');
    const r = await call('GET', '/health/live', undefined, { 'X-Correlation-Id': 'abc-123' });
    expect(r.headers.get('x-correlation-id')).toBe('abc-123');
    const metrics = await fetch(`${base}/metrics`).then((x) => x.text());
    expect(metrics).toContain('wallet_wager_transactions_total');
    expect(metrics).toContain('wallet_duplicates_detected_total');
  });
});
