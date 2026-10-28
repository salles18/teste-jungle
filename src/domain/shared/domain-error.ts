/**
 * Base class for every error raised by the domain layer.
 * `code` is stable and machine readable; `message` is for humans/logs.
 */
export abstract class DomainError extends Error {
  abstract readonly code: string;

  protected constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** Input that can never form a valid domain value (bad amount string, unknown currency...). */
export class InvalidValueError extends DomainError {
  readonly code = 'INVALID_VALUE';

  constructor(message: string) {
    super(message);
  }
}

export class CurrencyMismatchError extends DomainError {
  readonly code = 'CURRENCY_MISMATCH';

  constructor(expected: string, received: string) {
    super(`Currency mismatch: expected ${expected}, received ${received}`);
  }
}

export class InsufficientFundsError extends DomainError {
  readonly code = 'INSUFFICIENT_FUNDS';

  constructor(walletId: string, balance: string, requested: string) {
    super(`Wallet ${walletId} has ${balance}, cannot debit ${requested}`);
  }
}

export class InvalidStateTransitionError extends DomainError {
  readonly code = 'INVALID_STATE_TRANSITION';

  constructor(entity: string, from: string, to: string) {
    super(`${entity}: transition ${from} -> ${to} is not allowed`);
  }
}

/** A rule that must always hold was broken. Indicates a bug or corrupted state, never a user error. */
export class InvariantViolationError extends DomainError {
  readonly code = 'INVARIANT_VIOLATION';

  constructor(message: string) {
    super(message);
  }
}
