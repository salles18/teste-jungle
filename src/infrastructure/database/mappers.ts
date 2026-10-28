import type { EventEnvelope } from '../../domain/events/integration-event';
import { InboxMessage, type InboxResult, type InboxStatus } from '../../domain/messaging/inbox-message';
import { OutboxMessage, type OutboxStatus } from '../../domain/messaging/outbox-message';
import { Currency } from '../../domain/money/currency';
import { Money } from '../../domain/money/money';
import { InvariantViolationError } from '../../domain/shared/domain-error';
import { WagerTransaction } from '../../domain/wagering/wager-transaction';
import type { FailureCode, LedgerDirection, TransactionKind, TransactionStatus } from '../../domain/wagering/wager-types';
import { Wallet } from '../../domain/wallet/wallet';
import { WalletLedgerEntry } from '../../domain/wallet/wallet-ledger-entry';
import type {
  InboxMessageRecord,
  LedgerEntryRecord,
  OutboxMessageRecord,
  WagerTransactionRecord,
  WalletRecord,
} from './entities';

/** pg returns NUMERIC as string; keep it a string and let Money parse it strictly. */
function money(amount: string, currency: string): Money {
  // Refuse anything that is not already a string: a driver/ORM change that started
  // returning NUMERIC as a JS number must fail loudly, never be stringified silently.
  if (typeof amount !== 'string') {
    throw new InvariantViolationError(`NUMERIC column returned ${typeof amount} instead of string`);
  }
  return Money.parse(amount, currency);
}

function date(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function optionalDate(value: Date | string | null): Date | null {
  return value === null || value === undefined ? null : date(value);
}

export function walletFromRecord(r: WalletRecord): Wallet {
  const currency = Currency.of(r.currency.trim());
  return Wallet.rehydrate({
    id: r.id,
    playerId: r.playerId,
    currency,
    balance: money(r.balance, currency.code),
    version: r.version,
    createdAt: date(r.createdAt),
    updatedAt: date(r.updatedAt),
  });
}

export function walletToRecord(w: Wallet): WalletRecord {
  return {
    id: w.id,
    playerId: w.playerId,
    currency: w.currency.code,
    balance: w.balance.amount,
    version: w.version,
    createdAt: w.createdAt,
    updatedAt: w.updatedAt,
  };
}

export function wagerFromRecord(r: WagerTransactionRecord): WagerTransaction {
  const currency = r.currency.trim();
  return WagerTransaction.rehydrate({
    id: r.id,
    providerId: r.providerId,
    externalTransactionId: r.externalTransactionId,
    idempotencyKey: r.idempotencyKey,
    payloadHash: r.payloadHash.trim(),
    walletId: r.walletId,
    playerId: r.playerId,
    roundId: r.roundId,
    gameId: r.gameId,
    kind: r.kind as TransactionKind,
    money: money(r.amount, currency),
    referenceExternalTransactionId: r.referenceExternalTransactionId,
    referenceTransactionId: r.referenceTransactionId,
    status: r.status as TransactionStatus,
    failureCode: r.failureCode as FailureCode | null,
    resultBalance: r.resultBalance === null ? null : money(r.resultBalance, currency),
    resultWalletVersion: r.resultWalletVersion,
    referenceAttempts: r.referenceAttempts,
    nextReferenceCheckAt: optionalDate(r.nextReferenceCheckAt),
    referenceDeadlineAt: optionalDate(r.referenceDeadlineAt),
    correlationId: r.correlationId,
    processedAt: optionalDate(r.processedAt),
    createdAt: date(r.createdAt),
    updatedAt: date(r.updatedAt),
  });
}

export function wagerToRecord(t: WagerTransaction): WagerTransactionRecord {
  return {
    id: t.id,
    providerId: t.providerId,
    externalTransactionId: t.externalTransactionId,
    idempotencyKey: t.idempotencyKey,
    payloadHash: t.payloadHash,
    walletId: t.walletId,
    playerId: t.playerId,
    currency: t.money.currency.code,
    roundId: t.roundId,
    gameId: t.gameId,
    kind: t.kind,
    amount: t.money.amount,
    referenceExternalTransactionId: t.referenceExternalTransactionId,
    referenceTransactionId: t.referenceTransactionId,
    status: t.status,
    failureCode: t.failureCode,
    resultBalance: t.resultBalance?.amount ?? null,
    resultWalletVersion: t.resultWalletVersion,
    referenceAttempts: t.referenceAttempts,
    nextReferenceCheckAt: t.nextReferenceCheckAt,
    referenceDeadlineAt: t.referenceDeadlineAt,
    correlationId: t.correlationId,
    processedAt: t.processedAt,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
  };
}

export function ledgerFromRecord(r: LedgerEntryRecord): WalletLedgerEntry {
  const currency = r.currency.trim();
  return WalletLedgerEntry.rehydrate({
    id: r.id,
    walletId: r.walletId,
    transactionId: r.transactionId,
    direction: r.direction as LedgerDirection,
    amount: money(r.amount, currency),
    balanceBefore: money(r.balanceBefore, currency),
    balanceAfter: money(r.balanceAfter, currency),
    walletVersion: r.walletVersion,
    createdAt: date(r.createdAt),
  });
}

export function ledgerToRecord(e: WalletLedgerEntry): LedgerEntryRecord {
  return {
    id: e.id,
    walletId: e.walletId,
    transactionId: e.transactionId,
    currency: e.amount.currency.code,
    direction: e.direction,
    amount: e.amount.amount,
    balanceBefore: e.balanceBefore.amount,
    balanceAfter: e.balanceAfter.amount,
    walletVersion: e.walletVersion,
    createdAt: e.createdAt,
  };
}

export function outboxFromRecord(r: OutboxMessageRecord): OutboxMessage {
  return OutboxMessage.rehydrate({
    id: r.id,
    eventType: r.eventType,
    eventVersion: r.eventVersion,
    aggregateType: r.aggregateType,
    aggregateId: r.aggregateId,
    messageGroupId: r.messageGroupId,
    payload: r.payload as unknown as EventEnvelope,
    status: r.status as OutboxStatus,
    attempts: r.attempts,
    nextAttemptAt: date(r.nextAttemptAt),
    lockedBy: r.lockedBy,
    lockedUntil: optionalDate(r.lockedUntil),
    lastError: r.lastError,
    publishedAt: optionalDate(r.publishedAt),
    occurredAt: date(r.occurredAt),
    createdAt: date(r.createdAt),
  });
}

export function outboxToInsert(m: OutboxMessage): Omit<OutboxMessageRecord, 'seq'> {
  return {
    id: m.id,
    eventType: m.eventType,
    eventVersion: m.eventVersion,
    aggregateType: m.aggregateType,
    aggregateId: m.aggregateId,
    messageGroupId: m.messageGroupId,
    payload: m.payload as unknown as Record<string, unknown>,
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

export function inboxFromRecord(r: InboxMessageRecord): InboxMessage {
  return InboxMessage.rehydrate({
    id: r.id,
    consumerName: r.consumerName,
    messageId: r.messageId,
    status: r.status as InboxStatus,
    attempts: r.attempts,
    lastError: r.lastError,
    result: r.result as InboxResult | null,
    transactionId: r.transactionId,
    firstReceivedAt: date(r.firstReceivedAt),
    lastReceivedAt: date(r.lastReceivedAt),
    processedAt: optionalDate(r.processedAt),
  });
}
