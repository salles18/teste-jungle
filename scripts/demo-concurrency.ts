/**
 * Mandatory scenario against a RUNNING API (bun run start):
 *   balance 100.00, two simultaneous BETs of 80.00 -> one PROCESSED, one REJECTED, 20.00 left.
 * API_URL defaults to http://localhost:3000. Pass API_URL_2 to send the second bet to another instance.
 */
const api = process.env.API_URL ?? 'http://localhost:3000';
const api2 = process.env.API_URL_2 ?? api;
const tag = Date.now().toString(36);

async function json(res: Response) {
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

const wallet = await json(
  await fetch(`${api}/wallets`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ playerId: `demo-${tag}`, currency: 'BRL', initialBalance: '100.00' }),
  }),
);
const walletId = wallet.body.walletId as string;
console.log('wallet', wallet.status, wallet.body);

const bet = (n: number, base: string) =>
  fetch(`${base}/wagering/transactions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'Idempotency-Key': `demo-${tag}-bet-${n}` },
    body: JSON.stringify({
      providerId: 'demo-provider',
      externalTransactionId: `demo-${tag}-bet-${n}`,
      walletId,
      playerId: `demo-${tag}`,
      roundId: 'round-1',
      gameId: 'demo-game',
      kind: 'BET',
      amount: '80.00',
      currency: 'BRL',
    }),
  }).then(json);

const results = await Promise.all([bet(1, api), bet(2, api2)]);
for (const r of results)
  console.log('bet', r.status, r.body.status, r.body.failureCode ?? '', 'balanceAfter', r.body.balanceAfter);

console.log('wallet', (await json(await fetch(`${api}/wallets/${walletId}`))).body);
const ledger = (await json(await fetch(`${api}/wallets/${walletId}/ledger`))).body as { entries: unknown[] };
console.log('ledger entries', ledger.entries);
console.log('reconciliation', (await json(await fetch(`${api}/wallets/${walletId}/reconciliation`, { method: 'POST' }))).body);

export {};
