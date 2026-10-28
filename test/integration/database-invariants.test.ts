import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { EntityManager } from '@mikro-orm/postgresql';
import type { Container } from '../../src/bootstrap/container';
import { MIGRATIONS } from '../../src/infrastructure/database/orm';
import { resetDatabase, sql, testContainer } from '../helpers/db';
import { meta, openWallet, uniq, wager } from '../helpers/fixtures';

let c: Container;

async function inTx(work: (em: EntityManager) => Promise<unknown>): Promise<void> {
  await (c.orm.em.fork() as EntityManager).transactional(async (em) => {
    await work(em);
  });
}

/** Expects the statement (or its COMMIT, for deferred triggers) to fail with a message matching `pattern`. */
async function expectDbError(work: (em: EntityManager) => Promise<unknown>, pattern: RegExp): Promise<void> {
  let error: unknown = null;
  try {
    await inTx(work);
  } catch (e) {
    error = e;
  }
  expect(error).not.toBeNull();
  expect(String((error as Error).message)).toMatch(pattern);
}

beforeAll(async () => {
  await resetDatabase();
  c = await testContainer();
});

afterAll(async () => {
  await c?.close();
});

describe('migrations', () => {
  test('apply from an empty schema, revert fully, and re-apply', async () => {
    const migrator = c.orm.getMigrator();
    expect((await migrator.getExecutedMigrations()).map((m) => m.name)).toEqual(MIGRATIONS.map((m) => m.name));
    await migrator.down({ to: 0 });
    const tables = await sql<{ n: number }>(
      c,
      `SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public' AND table_name <> 'mikro_orm_migrations'`,
    );
    expect(tables[0]?.n).toBe(0);
    await migrator.up();
    expect(await migrator.getPendingMigrations()).toHaveLength(0);
  });

  test('money columns are NUMERIC(20,2)', async () => {
    const cols = await sql<{ table_name: string; column_name: string; numeric_precision: number; numeric_scale: number }>(
      c,
      `SELECT table_name, column_name, numeric_precision, numeric_scale FROM information_schema.columns
        WHERE table_schema = 'public' AND data_type = 'numeric' ORDER BY table_name, column_name`,
    );
    expect(cols.length).toBeGreaterThanOrEqual(6);
    for (const col of cols) {
      expect([col.numeric_precision, col.numeric_scale]).toEqual([20, 2]);
    }
  });
});

describe('constraints and triggers (last line of defence)', () => {
  test('wallet: unique player+currency, non-negative balance', async () => {
    const w = await openWallet(c, '10.00');
    await expectDbError(
      (em) =>
        em.execute(`INSERT INTO wallets (id, player_id, currency, balance, version) VALUES (gen_random_uuid(), ?, 'BRL', 0, 1)`, [
          w.playerId,
        ]),
      /uq_wallets_player_currency/,
    );
    await expectDbError(
      (em) =>
        em.execute(
          `INSERT INTO wallets (id, player_id, currency, balance, version) VALUES (gen_random_uuid(), 'neg', 'BRL', -1, 1)`,
        ),
      /check constraint/i,
    );
  });

  test('wallet balance cannot change without its ledger entry (deferred check at COMMIT)', async () => {
    const w = await openWallet(c, '10.00');
    await expectDbError(
      (em) => em.execute(`UPDATE wallets SET balance = 999, version = version + 1 WHERE id = ?`, [w.id]),
      /without matching ledger entry/,
    );
    await expectDbError(
      (em) => em.execute(`UPDATE wallets SET balance = 5, version = version + 2 WHERE id = ?`, [w.id]),
      /increment version by exactly 1/,
    );
    await expectDbError(
      (em) => em.execute(`UPDATE wallets SET version = version + 1 WHERE id = ?`, [w.id]),
      /only change together/,
    );
    await expectDbError(
      (em) =>
        em.execute(
          `INSERT INTO wallets (id, player_id, currency, balance, version) VALUES (gen_random_uuid(), 'ghost', 'BRL', 50, 1)`,
        ),
      /without a ledger entry/,
    );
    await expectDbError((em) => em.execute(`DELETE FROM wallets WHERE id = ?`, [w.id]), /forbidden/);
  });

  test('ledger is append-only: UPDATE, DELETE and TRUNCATE are refused', async () => {
    const w = await openWallet(c, '10.00');
    await expectDbError(
      (em) => em.execute(`UPDATE wallet_ledger_entries SET amount = 1 WHERE wallet_id = ?`, [w.id]),
      /append-only/,
    );
    await expectDbError((em) => em.execute(`DELETE FROM wallet_ledger_entries WHERE wallet_id = ?`, [w.id]), /append-only/);
    await expectDbError((em) => em.execute(`TRUNCATE wallet_ledger_entries CASCADE`), /append-only/);
  });

  test('ledger arithmetic, chain and transaction coherence are enforced', async () => {
    const w = await openWallet(c, '10.00');
    const bet = await c.wagers.execute(wager(w, 'BET', '1.00'), meta());
    const entry = { wallet: w.id, tx: bet.transaction.id };
    // arithmetic CHECK
    await expectDbError(
      (em) =>
        em.execute(
          `INSERT INTO wallet_ledger_entries (id, wallet_id, transaction_id, currency, direction, amount, balance_before, balance_after, wallet_version)
           VALUES (gen_random_uuid(), ?, ?, 'BRL', 'DEBIT', 1, 9, 9, 3)`,
          [entry.wallet, entry.tx],
        ),
      /ck_ledger_arithmetic|check constraint/,
    );
    // one entry per transaction
    await expectDbError(
      (em) =>
        em.execute(
          `INSERT INTO wallet_ledger_entries (id, wallet_id, transaction_id, currency, direction, amount, balance_before, balance_after, wallet_version)
           VALUES (gen_random_uuid(), ?, ?, 'BRL', 'DEBIT', 1, 9, 8, 3)`,
          [entry.wallet, entry.tx],
        ),
      /uq_ledger_transaction/,
    );
    // LOSS never has an entry
    const loss = await c.wagers.execute(wager(w, 'LOSS', '1.00'), meta());
    await expectDbError(
      (em) =>
        em.execute(
          `INSERT INTO wallet_ledger_entries (id, wallet_id, transaction_id, currency, direction, amount, balance_before, balance_after, wallet_version)
           VALUES (gen_random_uuid(), ?, ?, 'BRL', 'DEBIT', 1, 9, 8, 3)`,
          [entry.wallet, loss.transaction.id],
        ),
      /LOSS/,
    );
  });

  test('a PROCESSED money-moving transaction must have its ledger entry (deferred)', async () => {
    const w = await openWallet(c, '10.00');
    await expectDbError(
      (em) =>
        em.execute(
          `INSERT INTO wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id,
             currency, round_id, game_id, kind, amount, status, result_balance, result_wallet_version, processed_at)
           VALUES (gen_random_uuid(), 'prov-x', ?, ?, repeat('a', 64), ?, ?, 'BRL', 'r', 'g', 'WIN', 5, 'PROCESSED', 15, 2, now())`,
          [uniq('ext'), uniq('key'), w.id, w.playerId],
        ),
      /exactly one ledger entry/,
    );
  });

  test('terminal wager transactions are immutable and never deleted', async () => {
    const w = await openWallet(c, '10.00');
    const bet = await c.wagers.execute(wager(w, 'BET', '1.00'), meta());
    await expectDbError(
      (em) =>
        em.execute(`UPDATE wager_transactions SET status = 'REJECTED', failure_code = 'X' WHERE id = ?`, [bet.transaction.id]),
      /terminal/,
    );
    await expectDbError(
      (em) => em.execute(`UPDATE wager_transactions SET updated_at = now() WHERE id = ?`, [bet.transaction.id]),
      /terminal/,
    );
    await expectDbError((em) => em.execute(`DELETE FROM wager_transactions WHERE id = ?`, [bet.transaction.id]), /forbidden/);
  });

  test('identity uniqueness: (provider, idempotency key) and (provider, external id)', async () => {
    const w = await openWallet(c, '10.00');
    const bet = await c.wagers.execute(wager(w, 'LOSS', '0.00'), meta('dup-key-0001'));
    const insert = (ext: string, key: string) => (em: EntityManager) =>
      em.execute(
        `INSERT INTO wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id,
           currency, round_id, game_id, kind, amount, status, result_balance, result_wallet_version, processed_at)
         VALUES (gen_random_uuid(), 'prov-a', ?, ?, repeat('a', 64), ?, ?, 'BRL', 'r', 'g', 'LOSS', 0, 'PROCESSED', 10, 1, now())`,
        [ext, key, w.id, w.playerId],
      );
    await expectDbError(insert(uniq('ext'), 'dup-key-0001'), /uq_wager_provider_idempotency/);
    await expectDbError(insert(bet.transaction.externalTransactionId, uniq('key')), /uq_wager_provider_external/);
  });

  test('a reference can have at most one PROCESSED reversal (partial unique index)', async () => {
    const indexes = await sql<{ indexdef: string }>(
      c,
      `SELECT indexdef FROM pg_indexes WHERE indexname = 'ux_wager_single_reversal'`,
    );
    expect(indexes[0]?.indexdef).toMatch(/UNIQUE INDEX .* \(reference_transaction_id\) WHERE/);
  });

  test('composite FKs force player/currency coherence with the wallet', async () => {
    const w = await openWallet(c, '10.00');
    await expectDbError(
      (em) =>
        em.execute(
          `INSERT INTO wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id,
             currency, round_id, game_id, kind, amount, status)
           VALUES (gen_random_uuid(), 'prov-a', ?, ?, repeat('a', 64), ?, 'someone-else', 'BRL', 'r', 'g', 'BET', 1, 'PENDING')`,
          [uniq('ext'), uniq('key'), w.id],
        ),
      /fk_wager_wallet/,
    );
  });

  test('outbox rows cannot disappear before publication', async () => {
    await openWallet(c, '10.00');
    await expectDbError((em) => em.execute(`DELETE FROM outbox_messages WHERE status = 'PENDING'`), /cannot be deleted/);
    await expectDbError((em) => em.execute(`UPDATE outbox_messages SET payload = '{}'::jsonb`), /immutable/);
  });
});
