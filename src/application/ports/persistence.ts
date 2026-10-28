import type { InboxMessage } from '../../domain/messaging/inbox-message';
import type { OutboxMessage } from '../../domain/messaging/outbox-message';
import type { Money } from '../../domain/money/money';
import type { WagerTransaction } from '../../domain/wagering/wager-transaction';
import type { TransactionStatus } from '../../domain/wagering/wager-types';
import type { Wallet } from '../../domain/wallet/wallet';
import type { WalletLedgerEntry } from '../../domain/wallet/wallet-ledger-entry';

export interface WalletRepository {
  insert(wallet: Wallet): Promise<void>;
  findById(id: string): Promise<Wallet | null>;
  /** SELECT ... FOR UPDATE. Must be the first statement touching the wallet in a write unit of work. */
  findByIdForUpdate(id: string): Promise<Wallet | null>;
  findByPlayerAndCurrency(playerId: string, currency: string): Promise<Wallet | null>;
  /** Persists balance/version, guarded by WHERE version = wallet.expectedVersion. */
  save(wallet: Wallet): Promise<void>;
}

export interface DuePendingReference {
  id: string;
  walletId: string;
}

export interface WagerTransactionRepository {
  insert(tx: WagerTransaction): Promise<void>;
  /** Persists the mutable (state) fields of an existing transaction. */
  save(tx: WagerTransaction): Promise<void>;
  findById(id: string): Promise<WagerTransaction | null>;
  findByIdempotencyKey(providerId: string, idempotencyKey: string): Promise<WagerTransaction | null>;
  findByExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | null>;
  hasProcessedReversal(referenceTransactionId: string): Promise<boolean>;
  findDuePendingReferences(now: Date, limit: number): Promise<DuePendingReference[]>;
  /** Pulls forward the next check of PENDING_REFERENCE rows of this wallet that wait for `externalTransactionId`. */
  wakePendingDependents(input: {
    providerId: string;
    walletId: string;
    externalTransactionId: string;
    now: Date;
  }): Promise<number>;
  countByStatus(status: TransactionStatus): Promise<number>;
}

export interface LedgerSummary {
  balance: Money;
  entries: number;
  lastWalletVersion: number | null;
}

export interface LedgerRepository {
  append(entry: WalletLedgerEntry): Promise<void>;
  /** Newest first, keyset on wallet_version (strictly below `beforeVersion` when given). */
  listByWallet(walletId: string, options: { beforeVersion: number | null; limit: number }): Promise<WalletLedgerEntry[]>;
  findByTransactionId(transactionId: string): Promise<WalletLedgerEntry | null>;
  summarize(walletId: string, currency: string): Promise<LedgerSummary>;
}

export interface OutboxRepository {
  enqueue(messages: readonly OutboxMessage[]): Promise<void>;
}

export interface InboxRepository {
  /**
   * Inserts the (consumer, messageId) row if absent and locks it FOR UPDATE.
   * Concurrent deliveries of the same message serialise here.
   */
  acquire(consumerName: string, messageId: string, now: Date): Promise<InboxMessage>;
  save(message: InboxMessage): Promise<void>;
  /** Out-of-band attempt bookkeeping, used after the main transaction rolled back. */
  recordFailedAttempt(consumerName: string, messageId: string, error: string, now: Date): Promise<InboxMessage>;
  find(consumerName: string, messageId: string): Promise<InboxMessage | null>;
}

/** Repositories bound to one database transaction (one forked EntityManager). */
export interface TransactionContext {
  wallets: WalletRepository;
  transactions: WagerTransactionRepository;
  ledger: LedgerRepository;
  outbox: OutboxRepository;
  inbox: InboxRepository;
}

export interface UnitOfWorkOptions {
  /** Label for logs/metrics. */
  label: string;
  isolation?: 'READ COMMITTED' | 'REPEATABLE READ';
  readOnly?: boolean;
  /** Retry the whole closure on transient DB errors (default true). */
  retry?: boolean;
}

export interface UnitOfWork {
  /**
   * Runs `work` in exactly one SQL transaction with a fresh persistence context.
   * The closure may run more than once (transient-error retry), so it must not
   * perform external side effects.
   */
  run<T>(work: (ctx: TransactionContext) => Promise<T>, options: UnitOfWorkOptions): Promise<T>;
  /** Non-transactional reads with a fresh persistence context. */
  read<T>(work: (ctx: TransactionContext) => Promise<T>): Promise<T>;
}

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };
