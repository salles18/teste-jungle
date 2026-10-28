import { InvariantViolationError } from '../shared/domain-error';
import type { RetryPolicy } from '../shared/retry-policy';
import type { Wallet } from '../wallet/wallet';
import type { WalletLedgerEntry } from '../wallet/wallet-ledger-entry';
import type { WagerTransaction } from './wager-transaction';
import { FailureCode, LedgerDirection, TransactionKind, TransactionStatus } from './wager-types';

export interface ReferenceWaitPolicy {
  /** Backoff between reference checks; `maxAttempts` bounds the number of checks. */
  retry: RetryPolicy;
  /** Absolute time budget measured from the first check. */
  ttlMs: number;
}

export interface SettlementInput {
  transaction: WagerTransaction;
  /** Must be the wallet row locked FOR UPDATE in the current database transaction. */
  wallet: Wallet;
  /** Reference resolved by (providerId, referenceExternalTransactionId), or null if absent. */
  reference: WagerTransaction | null;
  /** True when the reference already has a PROCESSED REFUND or ROLLBACK. */
  referenceAlreadyReversed: boolean;
  waitPolicy: ReferenceWaitPolicy;
  now: Date;
}

export type SettlementOutcome =
  | { status: typeof TransactionStatus.PROCESSED; ledgerEntry: WalletLedgerEntry | null }
  | { status: typeof TransactionStatus.REJECTED; failureCode: FailureCode }
  | { status: typeof TransactionStatus.PENDING_REFERENCE; nextCheckAt: Date };

/**
 * The single place where financial rules are applied. HTTP, the SQS consumer and the
 * pending-reference worker all call this; none of them re-implement rules.
 *
 * Mutates `transaction` and `wallet` in memory; the caller persists both, the ledger
 * entry and the outbox events in the same database transaction.
 */
export function settleWagerTransaction(input: SettlementInput): SettlementOutcome {
  const { transaction: tx, wallet, now } = input;
  if (tx.isTerminal()) {
    throw new InvariantViolationError(`Transaction ${tx.id} is already ${tx.status}`);
  }
  if (tx.walletId !== wallet.id) {
    throw new InvariantViolationError(`Transaction ${tx.id} does not belong to wallet ${wallet.id}`);
  }
  if (!tx.money.hasCurrency(wallet.currency)) {
    throw new InvariantViolationError(`Transaction ${tx.id} currency differs from wallet currency`);
  }

  let reference: WagerTransaction | null = null;
  if (tx.hasReference()) {
    if (!input.reference) return waitForReference(input, FailureCode.REFERENCE_NOT_FOUND);
    const verdict = tx.validateReference(input.reference);
    if (verdict === 'WAIT') return waitForReference(input, FailureCode.REFERENCE_NOT_PROCESSED);
    if (verdict !== null) return reject(input, verdict);
    if (tx.isReversal() && input.referenceAlreadyReversed) {
      return reject(input, FailureCode.REFERENCE_ALREADY_REVERSED);
    }
    reference = input.reference;
  }

  const direction = tx.ledgerDirectionFor(reference);
  if (direction === null) {
    tx.markProcessed({
      balanceAfter: wallet.balance,
      walletVersion: wallet.version,
      referenceTransactionId: reference?.id ?? null,
      now,
    });
    return { status: TransactionStatus.PROCESSED, ledgerEntry: null };
  }

  if (direction === LedgerDirection.DEBIT && !wallet.canDebit(tx.money)) {
    const code = tx.kind === TransactionKind.ROLLBACK ? FailureCode.ROLLBACK_INSUFFICIENT_FUNDS : FailureCode.INSUFFICIENT_FUNDS;
    return reject(input, code);
  }

  const ledgerEntry = wallet.apply(direction, tx.money, tx.id, now);
  tx.markProcessed({
    balanceAfter: wallet.balance,
    walletVersion: wallet.version,
    referenceTransactionId: reference?.id ?? null,
    now,
  });
  return { status: TransactionStatus.PROCESSED, ledgerEntry };
}

function reject(input: SettlementInput, failureCode: FailureCode): SettlementOutcome {
  input.transaction.markRejected({
    failureCode,
    balance: input.wallet.balance,
    walletVersion: input.wallet.version,
    now: input.now,
  });
  return { status: TransactionStatus.REJECTED, failureCode };
}

/**
 * Reference missing (or not yet terminal): park the transaction, or reject it when the
 * attempt budget or the TTL is exhausted.
 */
function waitForReference(input: SettlementInput, exhaustedCode: FailureCode): SettlementOutcome {
  const { transaction: tx, waitPolicy, now } = input;
  const attempt = tx.referenceAttempts + 1;
  const deadline = tx.referenceDeadlineAt ?? new Date(now.getTime() + waitPolicy.ttlMs);
  if (waitPolicy.retry.isExhausted(attempt) || now.getTime() >= deadline.getTime()) {
    return reject(input, exhaustedCode);
  }
  const nextCheckAt = waitPolicy.retry.nextAttemptAt(attempt, now);
  tx.markPendingReference({ nextCheckAt, deadlineAt: deadline, now });
  return { status: TransactionStatus.PENDING_REFERENCE, nextCheckAt };
}
