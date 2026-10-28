/**
 * Application-level errors. Each has a stable `code` that the HTTP layer and the SQS
 * consumer translate into status codes / ack decisions.
 */
export abstract class ApplicationError extends Error {
  abstract readonly code: string;
  readonly details: Record<string, unknown>;

  protected constructor(message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = new.target.name;
    this.details = details;
  }
}

/** Input rejected before anything was persisted (malformed / not allowed). */
export class CommandValidationError extends ApplicationError {
  readonly code = 'VALIDATION_FAILED';

  constructor(
    message: string,
    readonly violations: string[] = [],
  ) {
    super(message, { violations });
  }
}

export class WalletNotFoundError extends ApplicationError {
  readonly code = 'WALLET_NOT_FOUND';

  constructor(walletId: string) {
    super(`Wallet ${walletId} not found`, { walletId });
  }
}

export class TransactionNotFoundError extends ApplicationError {
  readonly code = 'TRANSACTION_NOT_FOUND';

  constructor(details: Record<string, unknown>) {
    super('Wager transaction not found', details);
  }
}

export class WalletAlreadyExistsError extends ApplicationError {
  readonly code = 'WALLET_ALREADY_EXISTS';

  constructor(playerId: string, currency: string, existingWalletId: string | null) {
    super(`Player ${playerId} already has a ${currency} wallet`, { playerId, currency, existingWalletId });
  }
}

export type IdempotencyConflictCode = 'IDEMPOTENCY_KEY_REUSED' | 'EXTERNAL_TRANSACTION_CONFLICT';

/** Same idempotency key with another payload, or same external id under another key. Nothing executed. */
export class IdempotencyConflictError extends ApplicationError {
  constructor(
    readonly code: IdempotencyConflictCode,
    message: string,
    readonly existingTransactionId: string,
  ) {
    super(message, { existingTransactionId });
  }
}

export type CommandRejectionCode = 'PLAYER_WALLET_MISMATCH' | 'CURRENCY_MISMATCH' | 'CURRENCY_NOT_SUPPORTED';

/**
 * The command is well-formed but incoherent with the target wallet. It is not
 * persisted as a wager transaction because it cannot be attached to that wallet.
 */
export class CommandRejectedError extends ApplicationError {
  constructor(
    readonly code: CommandRejectionCode,
    message: string,
    details: Record<string, unknown> = {},
  ) {
    super(message, details);
  }
}

/** Database/broker unavailable, or retries on lock conflicts exhausted. Safe to retry later. */
export class TransientInfrastructureError extends ApplicationError {
  readonly code = 'TRANSIENT_INFRASTRUCTURE_FAILURE';

  constructor(
    message: string,
    readonly reason: string,
    override readonly cause?: unknown,
  ) {
    super(message, { reason });
  }
}

/** A database integrity trigger fired (SQLSTATE JW001) — indicates a bug, never a user error. */
export class IntegrityViolationError extends ApplicationError {
  readonly code = 'INTEGRITY_VIOLATION';

  constructor(message: string) {
    super(message);
  }
}
