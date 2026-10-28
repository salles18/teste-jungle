import { EntitySchema } from '@mikro-orm/core';

/**
 * Persistence records. These are deliberately separate from the domain classes:
 * the domain has no ORM decorators, and repositories map records <-> aggregates via
 * the domain `rehydrate` factories. NUMERIC columns are typed `decimal`, which
 * MikroORM returns as string — money never becomes a JS number.
 */

export class WalletRecord {
  id!: string;
  playerId!: string;
  currency!: string;
  balance!: string;
  version!: number;
  createdAt!: Date;
  updatedAt!: Date;
}

export const WalletSchema = new EntitySchema<WalletRecord>({
  class: WalletRecord,
  tableName: 'wallets',
  properties: {
    id: { type: 'uuid', primary: true },
    playerId: { type: 'string', length: 128 },
    currency: { type: 'string', length: 3 },
    balance: { type: 'decimal', precision: 20, scale: 2 },
    version: { type: 'integer' },
    createdAt: { type: 'datetime' },
    updatedAt: { type: 'datetime' },
  },
});

export class WagerTransactionRecord {
  id!: string;
  providerId!: string;
  externalTransactionId!: string;
  idempotencyKey!: string;
  payloadHash!: string;
  walletId!: string;
  playerId!: string;
  currency!: string;
  roundId!: string | null;
  gameId!: string | null;
  kind!: string;
  amount!: string;
  referenceExternalTransactionId!: string | null;
  referenceTransactionId!: string | null;
  status!: string;
  failureCode!: string | null;
  resultBalance!: string | null;
  resultWalletVersion!: number | null;
  referenceAttempts!: number;
  nextReferenceCheckAt!: Date | null;
  referenceDeadlineAt!: Date | null;
  correlationId!: string | null;
  processedAt!: Date | null;
  createdAt!: Date;
  updatedAt!: Date;
}

export const WagerTransactionSchema = new EntitySchema<WagerTransactionRecord>({
  class: WagerTransactionRecord,
  tableName: 'wager_transactions',
  properties: {
    id: { type: 'uuid', primary: true },
    providerId: { type: 'string' },
    externalTransactionId: { type: 'string' },
    idempotencyKey: { type: 'string' },
    payloadHash: { type: 'string' },
    walletId: { type: 'uuid' },
    playerId: { type: 'string' },
    currency: { type: 'string' },
    roundId: { type: 'string', nullable: true },
    gameId: { type: 'string', nullable: true },
    kind: { type: 'string' },
    amount: { type: 'decimal', precision: 20, scale: 2 },
    referenceExternalTransactionId: { type: 'string', nullable: true },
    referenceTransactionId: { type: 'uuid', nullable: true },
    status: { type: 'string' },
    failureCode: { type: 'string', nullable: true },
    resultBalance: { type: 'decimal', precision: 20, scale: 2, nullable: true },
    resultWalletVersion: { type: 'integer', nullable: true },
    referenceAttempts: { type: 'integer' },
    nextReferenceCheckAt: { type: 'datetime', nullable: true },
    referenceDeadlineAt: { type: 'datetime', nullable: true },
    correlationId: { type: 'string', nullable: true },
    processedAt: { type: 'datetime', nullable: true },
    createdAt: { type: 'datetime' },
    updatedAt: { type: 'datetime' },
  },
});

export class LedgerEntryRecord {
  id!: string;
  walletId!: string;
  transactionId!: string;
  currency!: string;
  direction!: string;
  amount!: string;
  balanceBefore!: string;
  balanceAfter!: string;
  walletVersion!: number;
  createdAt!: Date;
}

export const LedgerEntrySchema = new EntitySchema<LedgerEntryRecord>({
  class: LedgerEntryRecord,
  tableName: 'wallet_ledger_entries',
  properties: {
    id: { type: 'uuid', primary: true },
    walletId: { type: 'uuid' },
    transactionId: { type: 'uuid' },
    currency: { type: 'string' },
    direction: { type: 'string' },
    amount: { type: 'decimal', precision: 20, scale: 2 },
    balanceBefore: { type: 'decimal', precision: 20, scale: 2 },
    balanceAfter: { type: 'decimal', precision: 20, scale: 2 },
    walletVersion: { type: 'integer' },
    createdAt: { type: 'datetime' },
  },
});

export class InboxMessageRecord {
  id!: string;
  consumerName!: string;
  messageId!: string;
  status!: string;
  attempts!: number;
  lastError!: string | null;
  result!: Record<string, unknown> | null;
  transactionId!: string | null;
  firstReceivedAt!: Date;
  lastReceivedAt!: Date;
  processedAt!: Date | null;
}

export const InboxMessageSchema = new EntitySchema<InboxMessageRecord>({
  class: InboxMessageRecord,
  tableName: 'inbox_messages',
  properties: {
    id: { type: 'uuid', primary: true },
    consumerName: { type: 'string' },
    messageId: { type: 'string' },
    status: { type: 'string' },
    attempts: { type: 'integer' },
    lastError: { type: 'text', nullable: true },
    result: { type: 'json', nullable: true },
    transactionId: { type: 'uuid', nullable: true },
    firstReceivedAt: { type: 'datetime' },
    lastReceivedAt: { type: 'datetime' },
    processedAt: { type: 'datetime', nullable: true },
  },
});

export class OutboxMessageRecord {
  id!: string;
  seq!: string;
  eventType!: string;
  eventVersion!: number;
  aggregateType!: string;
  aggregateId!: string;
  messageGroupId!: string;
  payload!: Record<string, unknown>;
  status!: string;
  attempts!: number;
  nextAttemptAt!: Date;
  lockedBy!: string | null;
  lockedUntil!: Date | null;
  lastError!: string | null;
  publishedAt!: Date | null;
  occurredAt!: Date;
  createdAt!: Date;
}

export const OutboxMessageSchema = new EntitySchema<OutboxMessageRecord>({
  class: OutboxMessageRecord,
  tableName: 'outbox_messages',
  properties: {
    id: { type: 'uuid', primary: true },
    // GENERATED ALWAYS AS IDENTITY: never written by the application
    seq: { type: 'bigint', persist: false },
    eventType: { type: 'string' },
    eventVersion: { type: 'integer' },
    aggregateType: { type: 'string' },
    aggregateId: { type: 'string' },
    messageGroupId: { type: 'string' },
    payload: { type: 'json' },
    status: { type: 'string' },
    attempts: { type: 'integer' },
    nextAttemptAt: { type: 'datetime' },
    lockedBy: { type: 'string', nullable: true },
    lockedUntil: { type: 'datetime', nullable: true },
    lastError: { type: 'text', nullable: true },
    publishedAt: { type: 'datetime', nullable: true },
    occurredAt: { type: 'datetime' },
    createdAt: { type: 'datetime' },
  },
});

export const ALL_SCHEMAS = [WalletSchema, WagerTransactionSchema, LedgerEntrySchema, InboxMessageSchema, OutboxMessageSchema];
