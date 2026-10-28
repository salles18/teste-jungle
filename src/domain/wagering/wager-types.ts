export const TransactionKind = {
  OPENING: 'OPENING',
  BET: 'BET',
  WIN: 'WIN',
  LOSS: 'LOSS',
  REFUND: 'REFUND',
  ROLLBACK: 'ROLLBACK',
} as const;
export type TransactionKind = (typeof TransactionKind)[keyof typeof TransactionKind];

/** Kinds that may be submitted by providers (HTTP / queue). OPENING is internal only. */
export const SUBMITTABLE_KINDS = [
  TransactionKind.BET,
  TransactionKind.WIN,
  TransactionKind.LOSS,
  TransactionKind.REFUND,
  TransactionKind.ROLLBACK,
] as const;
export type SubmittableKind = (typeof SUBMITTABLE_KINDS)[number];

export const TransactionStatus = {
  PENDING: 'PENDING',
  PENDING_REFERENCE: 'PENDING_REFERENCE',
  PROCESSED: 'PROCESSED',
  REJECTED: 'REJECTED',
  FAILED: 'FAILED',
} as const;
export type TransactionStatus = (typeof TransactionStatus)[keyof typeof TransactionStatus];

export const TERMINAL_STATUSES: ReadonlySet<TransactionStatus> = new Set([
  TransactionStatus.PROCESSED,
  TransactionStatus.REJECTED,
  TransactionStatus.FAILED,
]);

export const LedgerDirection = {
  DEBIT: 'DEBIT',
  CREDIT: 'CREDIT',
} as const;
export type LedgerDirection = (typeof LedgerDirection)[keyof typeof LedgerDirection];

/**
 * Stable, machine-readable reasons a wager transaction ends REJECTED or FAILED.
 * Values are part of the public contract: never rename, only add.
 */
export const FailureCode = {
  /** BET larger than the available balance. */
  INSUFFICIENT_FUNDS: 'INSUFFICIENT_FUNDS',
  /** ROLLBACK whose inverse effect (a debit) would make the balance negative. */
  ROLLBACK_INSUFFICIENT_FUNDS: 'ROLLBACK_INSUFFICIENT_FUNDS',
  /** Referenced transaction never arrived before the retry budget / TTL expired. */
  REFERENCE_NOT_FOUND: 'REFERENCE_NOT_FOUND',
  /** Referenced transaction has a kind this operation cannot reference. */
  REFERENCE_INVALID_KIND: 'REFERENCE_INVALID_KIND',
  /** Referenced transaction exists but ended REJECTED/FAILED. */
  REFERENCE_NOT_PROCESSED: 'REFERENCE_NOT_PROCESSED',
  /** Referenced transaction belongs to another provider/player/wallet/currency/round. */
  REFERENCE_MISMATCH: 'REFERENCE_MISMATCH',
  /** REFUND/ROLLBACK amount differs from the referenced transaction amount. */
  REFERENCE_AMOUNT_MISMATCH: 'REFERENCE_AMOUNT_MISMATCH',
  /** Referenced transaction already has a processed REFUND or ROLLBACK. */
  REFERENCE_ALREADY_REVERSED: 'REFERENCE_ALREADY_REVERSED',
  /** A transaction cannot reference itself. */
  REFERENCE_SELF: 'REFERENCE_SELF',
  /** Processing hit a broken invariant; requires investigation (status FAILED). */
  INTERNAL_INVARIANT_VIOLATION: 'INTERNAL_INVARIANT_VIOLATION',
} as const;
export type FailureCode = (typeof FailureCode)[keyof typeof FailureCode];

export const ALL_FAILURE_CODES: readonly FailureCode[] = Object.values(FailureCode);

/** Which kinds each kind may reference. Empty = cannot reference anything. */
export const ALLOWED_REFERENCE_KINDS: Readonly<Record<TransactionKind, readonly TransactionKind[]>> = {
  OPENING: [],
  BET: [],
  WIN: [TransactionKind.BET],
  LOSS: [TransactionKind.BET],
  REFUND: [TransactionKind.BET],
  ROLLBACK: [TransactionKind.BET, TransactionKind.WIN, TransactionKind.REFUND],
};
