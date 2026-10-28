import type { EntityManager } from '@mikro-orm/postgresql';
import { type Container, type ContainerOverrides, createContainer } from '../../src/bootstrap/container';
import { type AppConfig, loadConfig } from '../../src/config/app-config';
import { createOrm } from '../../src/infrastructure/database/orm';
import { createLogger } from '../../src/observability/logger';

/**
 * Integration tests run against a real PostgreSQL. Default matches docker-compose;
 * override with TEST_DATABASE_URL. The database is dropped/recreated per test file
 * (DROP SCHEMA ... CASCADE + migrations), which also exercises migrations from zero.
 */
export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgresql://jungle:jungle@localhost:5432/jungle_wallet_test';

export function testConfig(overrides: Record<string, string> = {}): AppConfig {
  return loadConfig({
    ...process.env,
    DATABASE_URL: TEST_DATABASE_URL,
    LOG_LEVEL: process.env.TEST_LOG_LEVEL ?? 'silent',
    DB_POOL_MAX: '40',
    TX_RETRY_MAX_ATTEMPTS: '8',
    PENDING_REFERENCE_BASE_DELAY_MS: '0',
    PENDING_REFERENCE_MAX_DELAY_MS: '0',
    RUN_SQS_CONSUMER: 'false',
    RUN_OUTBOX_PUBLISHER: 'false',
    RUN_PENDING_REFERENCE_WORKER: 'false',
    ...overrides,
  });
}

export async function resetDatabase(url = TEST_DATABASE_URL): Promise<void> {
  const orm = await createOrm({ url, poolMax: 2 });
  try {
    const em = orm.em.fork() as EntityManager;
    await em.execute('DROP SCHEMA IF EXISTS public CASCADE');
    await em.execute('CREATE SCHEMA public');
    await orm.getMigrator().up();
  } finally {
    await orm.close(true);
  }
}

export async function testContainer(
  overrides: Record<string, string> = {},
  containerOverrides: ContainerOverrides = {},
): Promise<Container> {
  return createContainer(testConfig(overrides), {
    logger: createLogger(process.env.TEST_LOG_LEVEL ?? 'silent'),
    ...containerOverrides,
  });
}

/** Raw SQL on a fresh EntityManager (outside any unit of work). */
export async function sql<T = Record<string, unknown>>(c: Container, query: string, params: unknown[] = []): Promise<T[]> {
  const em = c.orm.em.fork() as EntityManager;
  return em.execute<T[]>(query, params);
}

export interface WalletAudit {
  balance: string;
  ledgerBalance: string;
  entries: number;
  version: number;
  lastLedgerVersion: number | null;
  chainBroken: number;
  negative: number;
}

/**
 * The central invariant, recomputed in SQL independently of application code:
 * wallet.balance = Σ ledger, entries chain correctly, nothing negative.
 */
export async function auditWallet(c: Container, walletId: string): Promise<WalletAudit> {
  const [row] = await sql<{
    balance: string;
    ledger_balance: string;
    entries: number;
    version: number;
    last_version: number | null;
    chain_broken: number;
    negative: number;
  }>(
    c,
    `WITH e AS (
       SELECT *, lag(balance_after) OVER (ORDER BY wallet_version) AS prev_after
         FROM wallet_ledger_entries WHERE wallet_id = ?)
     SELECT w.balance::text AS balance,
            COALESCE((SELECT SUM(CASE WHEN direction='CREDIT' THEN amount ELSE -amount END) FROM e), 0)::numeric(22,2)::text AS ledger_balance,
            (SELECT count(*)::int FROM e) AS entries,
            w.version,
            (SELECT max(wallet_version) FROM e) AS last_version,
            (SELECT count(*)::int FROM e WHERE prev_after IS NOT NULL AND prev_after <> balance_before) AS chain_broken,
            (SELECT count(*)::int FROM e WHERE balance_after < 0) + (CASE WHEN w.balance < 0 THEN 1 ELSE 0 END) AS negative
       FROM wallets w WHERE w.id = ?`,
    [walletId, walletId],
  );
  if (!row) throw new Error(`wallet ${walletId} not found`);
  return {
    balance: row.balance,
    ledgerBalance: row.ledger_balance,
    entries: Number(row.entries),
    version: Number(row.version),
    lastLedgerVersion: row.last_version === null ? null : Number(row.last_version),
    chainBroken: Number(row.chain_broken),
    negative: Number(row.negative),
  };
}

export function expectConsistent(audit: WalletAudit): void {
  if (audit.balance !== audit.ledgerBalance) {
    throw new Error(`balance ${audit.balance} != ledger ${audit.ledgerBalance}`);
  }
  if (audit.chainBroken !== 0) throw new Error('ledger chain broken');
  if (audit.negative !== 0) throw new Error('negative balance found');
  if (audit.lastLedgerVersion !== null && audit.lastLedgerVersion !== audit.version) {
    throw new Error(`wallet version ${audit.version} != last ledger version ${audit.lastLedgerVersion}`);
  }
}
