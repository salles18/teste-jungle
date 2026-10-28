/**
 * End-to-end delivery validation. Exits non-zero as soon as a mandatory dependency or
 * check fails; prints a summary table either way.
 *
 *   bun run validate                 # starts PostgreSQL + LocalStack with docker compose
 *   SKIP_DOCKER=1 bun run validate   # uses infrastructure that is already running
 *
 * The SQS endpoint MUST be LocalStack (checked through /_localstack/health): other
 * emulators are refused, so a green run really means "validated against LocalStack".
 */
import { ReceiveMessageCommand, SendMessageCommand } from '@aws-sdk/client-sqs';
import type { EntityManager } from '@mikro-orm/postgresql';
import { loadConfig } from '../src/config/app-config';
import { createOrm } from '../src/infrastructure/database/orm';
import { createSqsClient, resolveQueueUrls } from '../src/infrastructure/sqs/sqs';

const env = {
  ...process.env,
  NODE_ENV: process.env.NODE_ENV ?? 'development',
  DATABASE_URL: process.env.DATABASE_URL ?? 'postgresql://jungle:jungle@localhost:5432/jungle_wallet',
  TEST_DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgresql://jungle:jungle@localhost:5432/jungle_wallet_test',
  SQS_ENDPOINT: process.env.SQS_ENDPOINT ?? 'http://localhost:4566',
  REQUIRE_SQS: '1',
};
const APP_PORT = Number(process.env.VALIDATE_APP_PORT ?? 3999);
const results: { step: string; ok: boolean; detail: string }[] = [];

class StepFailed extends Error {}

async function step(name: string, fn: () => Promise<string | undefined>): Promise<void> {
  console.log(`\n▶ ${name}`);
  const started = performance.now();
  try {
    const detail = (await fn()) ?? 'ok';
    results.push({ step: name, ok: true, detail: `${detail} (${((performance.now() - started) / 1000).toFixed(1)}s)` });
  } catch (error) {
    results.push({ step: name, ok: false, detail: error instanceof Error ? error.message : String(error) });
    throw new StepFailed(name);
  }
}

async function sh(cmd: string[], extraEnv: Record<string, string> = {}): Promise<string> {
  const proc = Bun.spawn(cmd, { env: { ...env, ...extraEnv }, stdout: 'inherit', stderr: 'inherit' });
  const code = await proc.exited;
  if (code !== 0) throw new Error(`\`${cmd.join(' ')}\` exited with ${code}`);
  return `\`${cmd.join(' ')}\` exit 0`;
}

async function capture(cmd: string[]): Promise<{ code: number; out: string }> {
  try {
    const proc = Bun.spawn(cmd, { env, stdout: 'pipe', stderr: 'pipe' });
    const out = await new Response(proc.stdout).text();
    return { code: await proc.exited, out: out.trim() };
  } catch (error) {
    return { code: 127, out: error instanceof Error ? error.message : String(error) };
  }
}

const bun = process.execPath;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor<T>(what: string, timeoutMs: number, probe: () => Promise<T | null>): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown = null;
  while (Date.now() < deadline) {
    try {
      const value = await probe();
      if (value !== null) return value;
    } catch (error) {
      last = error;
    }
    await sleep(500);
  }
  throw new Error(`timed out waiting for ${what}${last instanceof Error ? `: ${last.message}` : ''}`);
}

async function json(res: Response): Promise<{ status: number; body: Record<string, unknown> }> {
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function main(): Promise<void> {
  if (process.env.SKIP_DOCKER !== '1') {
    await step('Docker disponível', async () => {
      const docker = await capture(['docker', 'version', '--format', '{{.Server.Version}}']);
      if (docker.code !== 0) throw new Error(`Docker indisponível (docker version: ${docker.out || `exit ${docker.code}`})`);
      const compose = await capture(['docker', 'compose', 'version', '--short']);
      if (compose.code !== 0) throw new Error('docker compose v2 indisponível');
      return `engine ${docker.out}, compose ${compose.out}`;
    });
    await step('Subir PostgreSQL + LocalStack (healthchecks)', () =>
      sh(['docker', 'compose', 'up', '-d', '--wait', '--wait-timeout', '180', 'postgres', 'localstack']),
    );
  }

  await step('Endpoint SQS é LocalStack e o serviço SQS está ativo', async () => {
    const res = await fetch(`${env.SQS_ENDPOINT}/_localstack/health`, { signal: AbortSignal.timeout(5000) }).catch(() => null);
    if (!res?.ok)
      throw new Error(`${env.SQS_ENDPOINT}/_localstack/health não respondeu: o endpoint não é LocalStack ou está fora do ar`);
    const health = (await res.json()) as { services?: Record<string, string>; version?: string };
    const sqs = health.services?.sqs;
    if (sqs !== 'available' && sqs !== 'running') throw new Error(`LocalStack sem SQS ativo (sqs=${String(sqs)})`);
    return `LocalStack ${health.version ?? '?'}, sqs=${sqs}`;
  });

  await step('PostgreSQL acessível (app e testes)', async () => {
    for (const url of [env.DATABASE_URL, env.TEST_DATABASE_URL]) {
      const orm = await createOrm({ url, poolMax: 1 });
      try {
        await (orm.em.fork() as EntityManager).execute('SELECT 1');
      } finally {
        await orm.close(true);
      }
    }
    return 'jungle_wallet e jungle_wallet_test';
  });

  await step('Migrations em banco vazio: up, rollback total, up', async () => {
    const admin = new URL(env.DATABASE_URL);
    admin.pathname = '/postgres';
    const scratch = `jw_validate_${Date.now().toString(36)}`;
    const adminOrm = await createOrm({ url: admin.toString(), poolMax: 1 });
    try {
      await (adminOrm.em.fork() as EntityManager).execute(`CREATE DATABASE ${scratch}`);
      const url = new URL(env.DATABASE_URL);
      url.pathname = `/${scratch}`;
      const target = { DATABASE_URL: url.toString() };
      await sh([bun, 'run', 'db:migrate'], target);
      await sh([bun, 'run', 'db:rollback'], target);
      await sh([bun, 'run', 'db:rollback'], target);
      await sh([bun, 'run', 'db:migrate'], target);
      return `banco temporário ${scratch}`;
    } finally {
      await (adminOrm.em.fork() as EntityManager)
        .execute(`DROP DATABASE IF EXISTS ${scratch} WITH (FORCE)`)
        .catch(() => undefined);
      await adminOrm.close(true);
    }
  });

  await step('Migrations do banco da aplicação', () => sh([bun, 'run', 'db:migrate']));
  await step('Filas FIFO (queues:setup)', () => sh([bun, 'run', 'queues:setup']));
  await step('Typecheck', () => sh([bun, 'run', 'typecheck']));
  await step('Lint', () => sh([bun, 'run', 'lint']));
  await step('Testes unitários', () => sh([bun, 'run', 'test:unit']));
  await step('Testes de integração (REQUIRE_SQS=1, LocalStack)', () => sh([bun, 'run', 'test:integration']));
  await step('Testes de concorrência (REQUIRE_SQS=1, 3 processos)', () => sh([bun, 'run', 'test:concurrency']));

  await step('E2E contra o app real (HTTP + SQS + outbox + reconciliação)', e2eAgainstRunningApp);
}

/** Starts the app with every role, then exercises HTTP, SQS ingestion, outbox relay and reconciliation. */
export async function e2eAgainstRunningApp(): Promise<string> {
  const app = Bun.spawn([bun, 'run', 'src/main.ts'], {
    env: { ...env, PORT: String(APP_PORT), LOG_LEVEL: 'warn', INSTANCE_ID: 'validate' },
    stdout: 'inherit',
    stderr: 'inherit',
  });
  const api = `http://127.0.0.1:${APP_PORT}`;
  try {
    await waitFor('/health/ready = 200 (postgres + sqs up)', 60_000, async () => {
      const r = await fetch(`${api}/health/ready`);
      return r.status === 200 ? true : null;
    });
    const tag = Date.now().toString(36);
    const playerId = `validate-${tag}`;
    const wallet = await json(
      await fetch(`${api}/wallets`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ playerId, currency: 'BRL', initialBalance: '100.00' }),
      }),
    );
    if (wallet.status !== 201) throw new Error(`POST /wallets -> ${wallet.status}`);
    const walletId = wallet.body.walletId as string;
    const bet = (ext: string, key: string, amount = '80.00') =>
      fetch(`${api}/wagering/transactions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'Idempotency-Key': key },
        body: JSON.stringify({
          providerId: 'validate',
          externalTransactionId: ext,
          walletId,
          playerId,
          roundId: 'r1',
          gameId: 'g1',
          kind: 'BET',
          amount,
          currency: 'BRL',
        }),
      }).then(json);

    // 100.00 vs two simultaneous 80.00
    const pair = await Promise.all([bet(`${tag}-a`, `${tag}-key-a`), bet(`${tag}-b`, `${tag}-key-b`)]);
    const statuses = pair.map((p) => p.status).sort();
    if (statuses.join() !== '201,422') throw new Error(`2x80: esperado 201+422, obtido ${statuses.join('+')}`);
    const rejected = pair.find((p) => p.status === 422);
    if (rejected?.body.failureCode !== 'INSUFFICIENT_FUNDS') throw new Error('2x80: rejeição sem INSUFFICIENT_FUNDS');
    const after = await json(await fetch(`${api}/wallets/${walletId}`));
    if (after.body.balance !== '20.00') throw new Error(`2x80: saldo ${String(after.body.balance)} != 20.00`);

    // same operation 50 times at once
    const wallet2 = await json(
      await fetch(`${api}/wallets`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ playerId: `${playerId}-2`, currency: 'BRL', initialBalance: '100.00' }),
      }),
    );
    const walletId2 = wallet2.body.walletId as string;
    const same = await Promise.all(
      Array.from({ length: 50 }, () =>
        fetch(`${api}/wagering/transactions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'Idempotency-Key': `${tag}-key-50` },
          body: JSON.stringify({
            providerId: 'validate',
            externalTransactionId: `${tag}-50`,
            walletId: walletId2,
            playerId: `${playerId}-2`,
            roundId: 'r1',
            gameId: 'g1',
            kind: 'BET',
            amount: '80.00',
            currency: 'BRL',
          }),
        }).then(json),
      ),
    );
    const created = same.filter((r) => r.status === 201).length;
    const replays = same.filter((r) => r.status === 200 && r.body.idempotentReplay === true).length;
    const ids = new Set(same.map((r) => r.body.transactionId)).size;
    if (created !== 1 || replays !== 49 || ids !== 1) throw new Error(`50x: 201=${created} replays=${replays} ids=${ids}`);

    // ingestion through the real wager-transactions.fifo queue
    const config = loadConfig(env);
    const sqs = createSqsClient(config);
    try {
      const urls = await resolveQueueUrls(sqs, config);
      await sqs.send(
        new SendMessageCommand({
          QueueUrl: urls.wager,
          MessageGroupId: walletId,
          MessageDeduplicationId: `${tag}-sqs`,
          MessageBody: JSON.stringify({
            idempotencyKey: `${tag}-key-sqs`,
            transaction: {
              providerId: 'validate',
              externalTransactionId: `${tag}-sqs`,
              walletId,
              playerId,
              roundId: 'r1',
              gameId: 'g1',
              kind: 'BET',
              amount: '10.00',
              currency: 'BRL',
            },
          }),
        }),
      );
      await waitFor('BET via SQS processado', 60_000, async () => {
        const r = await fetch(`${api}/providers/validate/wagering/transactions/${tag}-sqs`);
        if (r.status !== 200) return null;
        const body = (await r.json()) as Record<string, unknown>;
        return body.status === 'PROCESSED' ? true : null;
      });

      // outbox relayed to wallet-events.fifo
      await waitFor('evento da outbox em wallet-events.fifo', 60_000, async () => {
        const out = await sqs.send(
          new ReceiveMessageCommand({ QueueUrl: urls.events, MaxNumberOfMessages: 10, WaitTimeSeconds: 1 }),
        );
        return (out.Messages ?? []).length > 0 ? true : null;
      });
    } finally {
      sqs.destroy();
    }

    for (const id of [walletId, walletId2]) {
      const rec = await json(await fetch(`${api}/wallets/${id}/reconciliation`, { method: 'POST' }));
      if (rec.body.consistent !== true) throw new Error(`reconciliação inconsistente para ${id}: ${JSON.stringify(rec.body)}`);
    }
    return '2x80 = 201+422 e saldo 20.00; 50x = 1 criada + 49 replays; SQS processado; outbox publicada; reconciliação consistente';
  } finally {
    app.kill();
    await app.exited;
  }
}

function summary(): void {
  console.log('\n================ RESUMO DA VALIDAÇÃO ================');
  for (const r of results) console.log(`${r.ok ? '✅' : '❌'} ${r.step} — ${r.detail}`);
  const failed = results.filter((r) => !r.ok);
  console.log(failed.length === 0 ? '\nRESULTADO: VALIDADO' : `\nRESULTADO: FALHOU em "${failed[0]?.step}"`);
}

if (import.meta.main) {
  main()
    .then(() => {
      summary();
      process.exit(0);
    })
    .catch((error: unknown) => {
      if (!(error instanceof StepFailed)) results.push({ step: 'erro inesperado', ok: false, detail: String(error) });
      summary();
      process.exit(1);
    });
}
