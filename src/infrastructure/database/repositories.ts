import { LockMode } from '@mikro-orm/core';
import type { EntityManager } from '@mikro-orm/postgresql';
import type {
  DuePendingReference,
  InboxRepository,
  LedgerRepository,
  LedgerSummary,
  OutboxRepository,
  TransactionContext,
  WagerTransactionRepository,
  WalletRepository,
} from '../../application/ports/persistence';
import { DuplicateWalletSignal } from '../../application/wallet/wallet-use-cases';
import type { InboxMessage } from '../../domain/messaging/inbox-message';
import type { OutboxMessage } from '../../domain/messaging/outbox-message';
import { Money } from '../../domain/money/money';
import { InvariantViolationError } from '../../domain/shared/domain-error';
import { newId } from '../../domain/shared/ids';
import type { WagerTransaction } from '../../domain/wagering/wager-transaction';
import { TransactionKind, TransactionStatus } from '../../domain/wagering/wager-types';
import type { Wallet } from '../../domain/wallet/wallet';
import type { WalletLedgerEntry } from '../../domain/wallet/wallet-ledger-entry';
import { InboxMessageRecord, LedgerEntryRecord, OutboxMessageRecord, WagerTransactionRecord, WalletRecord } from './entities';
import {
  inboxFromRecord,
  ledgerFromRecord,
  ledgerToRecord,
  outboxToInsert,
  wagerFromRecord,
  wagerToRecord,
  walletFromRecord,
  walletToRecord,
} from './mappers';
import { classifyDbError } from './pg-errors';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (value: string): boolean => UUID.test(value);

/**
 * Reads never use the identity map: within a unit of work every read must reflect the
 * database (rows written by the previous lock holder), never a cached object.
 */
const FRESH = { disableIdentityMap: true } as const;

export class MikroOrmWalletRepository implements WalletRepository {
  constructor(private readonly em: EntityManager) {}

  async insert(wallet: Wallet): Promise<void> {
    try {
      await this.em.insert(WalletRecord, walletToRecord(wallet));
    } catch (error) {
      const info = classifyDbError(error);
      if (info.kind === 'unique_violation' && info.constraint === 'uq_wallets_player_currency') {
        throw new DuplicateWalletSignal();
      }
      throw error;
    }
  }

  async findById(id: string): Promise<Wallet | null> {
    if (!isUuid(id)) return null;
    const record = await this.em.findOne(WalletRecord, { id }, FRESH);
    return record ? walletFromRecord(record) : null;
  }

  async findByIdForUpdate(id: string): Promise<Wallet | null> {
    if (!isUuid(id)) return null;
    const record = await this.em.findOne(WalletRecord, { id }, { ...FRESH, lockMode: LockMode.PESSIMISTIC_WRITE });
    return record ? walletFromRecord(record) : null;
  }

  async findByPlayerAndCurrency(playerId: string, currency: string): Promise<Wallet | null> {
    const record = await this.em.findOne(WalletRecord, { playerId, currency }, FRESH);
    return record ? walletFromRecord(record) : null;
  }

  async save(wallet: Wallet): Promise<void> {
    if (!wallet.hasChanges) return;
    // Optimistic guard on top of the pessimistic lock: if anything ever bypassed the
    // lock, the version check turns a lost update into an error instead of silent loss.
    const affected = await this.em.nativeUpdate(
      WalletRecord,
      { id: wallet.id, version: wallet.expectedVersion },
      { balance: wallet.balance.amount, version: wallet.version, updatedAt: wallet.updatedAt },
    );
    if (affected !== 1) {
      throw new InvariantViolationError(`Wallet ${wallet.id} changed concurrently (expected v${wallet.expectedVersion})`);
    }
  }
}

export class MikroOrmWagerTransactionRepository implements WagerTransactionRepository {
  constructor(private readonly em: EntityManager) {}

  async insert(tx: WagerTransaction): Promise<void> {
    await this.em.insert(WagerTransactionRecord, wagerToRecord(tx));
  }

  async save(tx: WagerTransaction): Promise<void> {
    const r = wagerToRecord(tx);
    const affected = await this.em.nativeUpdate(
      WagerTransactionRecord,
      { id: tx.id },
      {
        referenceTransactionId: r.referenceTransactionId,
        status: r.status,
        failureCode: r.failureCode,
        resultBalance: r.resultBalance,
        resultWalletVersion: r.resultWalletVersion,
        referenceAttempts: r.referenceAttempts,
        nextReferenceCheckAt: r.nextReferenceCheckAt,
        referenceDeadlineAt: r.referenceDeadlineAt,
        processedAt: r.processedAt,
        updatedAt: r.updatedAt,
      },
    );
    if (affected !== 1) throw new InvariantViolationError(`Wager transaction ${tx.id} not found on save`);
  }

  async findById(id: string): Promise<WagerTransaction | null> {
    if (!isUuid(id)) return null;
    const record = await this.em.findOne(WagerTransactionRecord, { id }, FRESH);
    return record ? wagerFromRecord(record) : null;
  }

  async findByIdempotencyKey(providerId: string, idempotencyKey: string): Promise<WagerTransaction | null> {
    const record = await this.em.findOne(WagerTransactionRecord, { providerId, idempotencyKey }, FRESH);
    return record ? wagerFromRecord(record) : null;
  }

  async findByExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | null> {
    const record = await this.em.findOne(WagerTransactionRecord, { providerId, externalTransactionId }, FRESH);
    return record ? wagerFromRecord(record) : null;
  }

  async hasProcessedReversal(referenceTransactionId: string): Promise<boolean> {
    const count = await this.em.count(WagerTransactionRecord, {
      referenceTransactionId,
      status: TransactionStatus.PROCESSED,
      kind: { $in: [TransactionKind.REFUND, TransactionKind.ROLLBACK] },
    });
    return count > 0;
  }

  async findDuePendingReferences(limit: number): Promise<DuePendingReference[]> {
    const now = await databaseNow(this.em);
    const rows = await this.em.find(
      WagerTransactionRecord,
      { status: TransactionStatus.PENDING_REFERENCE, nextReferenceCheckAt: { $lte: now } },
      { ...FRESH, fields: ['id', 'walletId'], orderBy: { nextReferenceCheckAt: 'asc' }, limit },
    );
    return rows.map((r) => ({ id: r.id, walletId: r.walletId }));
  }

  async wakePendingDependents(input: {
    providerId: string;
    walletId: string;
    externalTransactionId: string;
    now: Date;
  }): Promise<number> {
    return this.em.nativeUpdate(
      WagerTransactionRecord,
      {
        status: TransactionStatus.PENDING_REFERENCE,
        providerId: input.providerId,
        walletId: input.walletId,
        referenceExternalTransactionId: input.externalTransactionId,
        nextReferenceCheckAt: { $gt: input.now },
      },
      { nextReferenceCheckAt: input.now, updatedAt: input.now },
    );
  }

  async countByStatus(status: TransactionStatus): Promise<number> {
    return this.em.count(WagerTransactionRecord, { status });
  }
}

export class MikroOrmLedgerRepository implements LedgerRepository {
  constructor(private readonly em: EntityManager) {}

  async append(entry: WalletLedgerEntry): Promise<void> {
    await this.em.insert(LedgerEntryRecord, ledgerToRecord(entry));
  }

  async listByWallet(walletId: string, options: { beforeVersion: number | null; limit: number }): Promise<WalletLedgerEntry[]> {
    const where = options.beforeVersion === null ? { walletId } : { walletId, walletVersion: { $lt: options.beforeVersion } };
    const rows = await this.em.find(LedgerEntryRecord, where, {
      ...FRESH,
      orderBy: { walletVersion: 'desc' },
      limit: options.limit,
    });
    return rows.map(ledgerFromRecord);
  }

  async findByTransactionId(transactionId: string): Promise<WalletLedgerEntry | null> {
    if (!isUuid(transactionId)) return null;
    const record = await this.em.findOne(LedgerEntryRecord, { transactionId }, FRESH);
    return record ? ledgerFromRecord(record) : null;
  }

  async summarize(walletId: string, currency: string): Promise<LedgerSummary> {
    const rows = await this.em.execute<{ balance: string; entries: number; last_version: number | null }[]>(
      `SELECT COALESCE(SUM(CASE WHEN direction = 'CREDIT' THEN amount ELSE -amount END), 0)::numeric(22,2)::text AS balance,
              count(*)::int AS entries,
              max(wallet_version) AS last_version
         FROM wallet_ledger_entries
        WHERE wallet_id = ?`,
      [walletId],
    );
    const row = rows[0];
    if (!row) throw new InvariantViolationError('Aggregate query returned no row');
    return {
      balance: Money.parse(row.balance, currency),
      entries: Number(row.entries),
      lastWalletVersion: row.last_version === null ? null : Number(row.last_version),
    };
  }
}

export class MikroOrmOutboxRepository implements OutboxRepository {
  constructor(private readonly em: EntityManager) {}

  async enqueue(messages: readonly OutboxMessage[]): Promise<void> {
    if (messages.length === 0) return;
    await this.em.insertMany(OutboxMessageRecord, messages.map(outboxToInsert) as OutboxMessageRecord[]);
  }
}

export class MikroOrmInboxRepository implements InboxRepository {
  constructor(private readonly em: EntityManager) {}

  async acquire(consumerName: string, messageId: string, now: Date): Promise<InboxMessage> {
    // ON CONFLICT DO NOTHING waits for a concurrent inserter of the same key to finish,
    // then the FOR UPDATE below serialises concurrent deliveries of one message.
    await this.em.execute(
      `INSERT INTO inbox_messages (id, consumer_name, message_id, status, attempts, first_received_at, last_received_at)
       VALUES (?, ?, ?, 'RECEIVED', 0, ?, ?)
       ON CONFLICT (consumer_name, message_id) DO NOTHING`,
      [newId(), consumerName, messageId, now, now],
    );
    const record = await this.em.findOne(
      InboxMessageRecord,
      { consumerName, messageId },
      { ...FRESH, lockMode: LockMode.PESSIMISTIC_WRITE },
    );
    if (!record) throw new InvariantViolationError(`Inbox row ${consumerName}/${messageId} vanished`);
    return inboxFromRecord(record);
  }

  async save(message: InboxMessage): Promise<void> {
    await this.em.nativeUpdate(
      InboxMessageRecord,
      { id: message.id },
      {
        status: message.status,
        attempts: message.attempts,
        lastError: message.lastError,
        result: message.result as Record<string, unknown> | null,
        transactionId: message.transactionId,
        lastReceivedAt: message.lastReceivedAt,
        processedAt: message.processedAt,
      },
    );
  }

  async recordFailedAttempt(consumerName: string, messageId: string, error: string, now: Date): Promise<InboxMessage> {
    await this.em.execute(
      `INSERT INTO inbox_messages (id, consumer_name, message_id, status, attempts, last_error, first_received_at, last_received_at)
       VALUES (?, ?, ?, 'RECEIVED', 1, ?, ?, ?)
       ON CONFLICT (consumer_name, message_id) DO UPDATE
          SET attempts = inbox_messages.attempts + 1,
              last_error = EXCLUDED.last_error,
              last_received_at = EXCLUDED.last_received_at
        WHERE inbox_messages.status = 'RECEIVED'`,
      [newId(), consumerName, messageId, error.slice(0, 2000), now, now],
    );
    const record = await this.em.findOne(InboxMessageRecord, { consumerName, messageId }, FRESH);
    if (!record) throw new InvariantViolationError(`Inbox row ${consumerName}/${messageId} vanished`);
    return inboxFromRecord(record);
  }

  async find(consumerName: string, messageId: string): Promise<InboxMessage | null> {
    const record = await this.em.findOne(InboxMessageRecord, { consumerName, messageId }, FRESH);
    return record ? inboxFromRecord(record) : null;
  }
}

/** clock_timestamp(): real current time on the server, even inside a long transaction. */
export async function databaseNow(em: EntityManager): Promise<Date> {
  const [row] = await em.execute<{ now: Date | string }[]>('SELECT clock_timestamp() AS now');
  if (!row) throw new InvariantViolationError('clock_timestamp() returned no row');
  return row.now instanceof Date ? row.now : new Date(row.now);
}

export function createTransactionContext(em: EntityManager): TransactionContext {
  return {
    databaseNow: () => databaseNow(em),
    wallets: new MikroOrmWalletRepository(em),
    transactions: new MikroOrmWagerTransactionRepository(em),
    ledger: new MikroOrmLedgerRepository(em),
    outbox: new MikroOrmOutboxRepository(em),
    inbox: new MikroOrmInboxRepository(em),
  };
}
