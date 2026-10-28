import type { MoneyJSON } from '../money/money';
import type { WagerTransaction } from '../wagering/wager-transaction';
import type { FailureCode, LedgerDirection, TransactionKind } from '../wagering/wager-types';
import type { Wallet } from '../wallet/wallet';
import type { WalletLedgerEntry } from '../wallet/wallet-ledger-entry';
import { type EventMetadata, IntegrationEvent } from './integration-event';

export interface WagerTransactionEventData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string | null;
  gameId: string | null;
  kind: TransactionKind;
  money: MoneyJSON;
  referenceExternalTransactionId: string | null;
}

function transactionData(tx: WagerTransaction): WagerTransactionEventData {
  return {
    transactionId: tx.id,
    providerId: tx.providerId,
    externalTransactionId: tx.externalTransactionId,
    walletId: tx.walletId,
    playerId: tx.playerId,
    roundId: tx.roundId,
    gameId: tx.gameId,
    kind: tx.kind,
    money: tx.money.toJSON(),
    referenceExternalTransactionId: tx.referenceExternalTransactionId,
  };
}

// ---------------------------------------------------------------------------

export interface WagerTransactionProcessedData extends WagerTransactionEventData {
  balanceAfter: MoneyJSON | null;
  walletVersion: number | null;
  processedAt: string;
}

/** Emitted for every PROCESSED transaction, including LOSS (which does not move money). */
export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  static readonly TYPE = 'WagerTransactionProcessed';
  static readonly VERSION = 1;
  readonly eventType = WagerTransactionProcessed.TYPE;
  readonly version = WagerTransactionProcessed.VERSION;
  readonly aggregateType = 'WagerTransaction';

  private constructor(tx: WagerTransaction, meta: EventMetadata) {
    super(
      tx.id,
      tx.walletId,
      {
        ...transactionData(tx),
        balanceAfter: tx.resultBalance?.toJSON() ?? null,
        walletVersion: tx.resultWalletVersion,
        processedAt: (tx.processedAt ?? meta.occurredAt).toISOString(),
      },
      meta,
    );
  }

  static from(tx: WagerTransaction, meta: EventMetadata): WagerTransactionProcessed {
    return new WagerTransactionProcessed(tx, meta);
  }
}

// ---------------------------------------------------------------------------

export interface WagerTransactionRejectedData extends WagerTransactionEventData {
  failureCode: FailureCode;
  balance: MoneyJSON | null;
  rejectedAt: string;
}

export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  static readonly TYPE = 'WagerTransactionRejected';
  static readonly VERSION = 1;
  readonly eventType = WagerTransactionRejected.TYPE;
  readonly version = WagerTransactionRejected.VERSION;
  readonly aggregateType = 'WagerTransaction';

  private constructor(tx: WagerTransaction, failureCode: FailureCode, meta: EventMetadata) {
    super(
      tx.id,
      tx.walletId,
      {
        ...transactionData(tx),
        failureCode,
        balance: tx.resultBalance?.toJSON() ?? null,
        rejectedAt: (tx.processedAt ?? meta.occurredAt).toISOString(),
      },
      meta,
    );
  }

  static from(tx: WagerTransaction, meta: EventMetadata): WagerTransactionRejected {
    if (!tx.failureCode) throw new Error('Rejected event requires a failure code');
    return new WagerTransactionRejected(tx, tx.failureCode, meta);
  }
}

// ---------------------------------------------------------------------------

export interface WagerTransactionPendingReferenceData extends WagerTransactionEventData {
  referenceAttempts: number;
  nextReferenceCheckAt: string | null;
  referenceDeadlineAt: string | null;
}

export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  static readonly TYPE = 'WagerTransactionPendingReference';
  static readonly VERSION = 1;
  readonly eventType = WagerTransactionPendingReference.TYPE;
  readonly version = WagerTransactionPendingReference.VERSION;
  readonly aggregateType = 'WagerTransaction';

  private constructor(tx: WagerTransaction, meta: EventMetadata) {
    super(
      tx.id,
      tx.walletId,
      {
        ...transactionData(tx),
        referenceAttempts: tx.referenceAttempts,
        nextReferenceCheckAt: tx.nextReferenceCheckAt?.toISOString() ?? null,
        referenceDeadlineAt: tx.referenceDeadlineAt?.toISOString() ?? null,
      },
      meta,
    );
  }

  static from(tx: WagerTransaction, meta: EventMetadata): WagerTransactionPendingReference {
    return new WagerTransactionPendingReference(tx, meta);
  }
}

// ---------------------------------------------------------------------------

export interface WalletBalanceChangedData {
  walletId: string;
  playerId: string;
  transactionId: string;
  ledgerEntryId: string;
  direction: LedgerDirection;
  amount: MoneyJSON;
  previousBalance: MoneyJSON;
  newBalance: MoneyJSON;
  walletVersion: number;
}

/** Only emitted when the balance actually changed (i.e. a ledger entry exists). */
export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  static readonly TYPE = 'WalletBalanceChanged';
  static readonly VERSION = 1;
  readonly eventType = WalletBalanceChanged.TYPE;
  readonly version = WalletBalanceChanged.VERSION;
  readonly aggregateType = 'Wallet';

  private constructor(wallet: Wallet, entry: WalletLedgerEntry, meta: EventMetadata) {
    super(
      wallet.id,
      wallet.id,
      {
        walletId: wallet.id,
        playerId: wallet.playerId,
        transactionId: entry.transactionId,
        ledgerEntryId: entry.id,
        direction: entry.direction,
        amount: entry.amount.toJSON(),
        previousBalance: entry.balanceBefore.toJSON(),
        newBalance: entry.balanceAfter.toJSON(),
        walletVersion: entry.walletVersion,
      },
      meta,
    );
  }

  static from(wallet: Wallet, entry: WalletLedgerEntry, meta: EventMetadata): WalletBalanceChanged {
    if (entry.walletId !== wallet.id) throw new Error('Ledger entry does not belong to wallet');
    return new WalletBalanceChanged(wallet, entry, meta);
  }
}
