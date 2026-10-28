import { Money } from '../money/money';
import { InvalidStateTransitionError, InvalidValueError, InvariantViolationError } from '../shared/domain-error';
import { newId } from '../shared/ids';
import {
  ALLOWED_REFERENCE_KINDS,
  FailureCode,
  LedgerDirection,
  SUBMITTABLE_KINDS,
  type SubmittableKind,
  TERMINAL_STATUSES,
  TransactionKind,
  TransactionStatus,
} from './wager-types';

export interface WagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string | null;
  gameId: string | null;
  kind: TransactionKind;
  money: Money;
  referenceExternalTransactionId: string | null;
  /** Internal id of the resolved reference (set once the reference is found and validated). */
  referenceTransactionId: string | null;
  status: TransactionStatus;
  failureCode: FailureCode | null;
  /** Balance observed when the transaction reached a terminal state (response snapshot). */
  resultBalance: Money | null;
  /** Wallet version observed when the transaction reached a terminal state. */
  resultWalletVersion: number | null;
  referenceAttempts: number;
  nextReferenceCheckAt: Date | null;
  referenceDeadlineAt: Date | null;
  correlationId: string | null;
  processedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateWagerTransactionInput {
  id?: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: SubmittableKind;
  money: Money;
  referenceExternalTransactionId: string | null;
  correlationId: string | null;
  now: Date;
}

export const SYSTEM_PROVIDER_ID = 'system';

const ALLOWED_TRANSITIONS: Readonly<Record<TransactionStatus, readonly TransactionStatus[]>> = {
  PENDING: ['PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED'],
  PENDING_REFERENCE: ['PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED'],
  PROCESSED: [],
  REJECTED: [],
  FAILED: [],
};

/**
 * A single financial instruction from a game provider (or the internal OPENING).
 * Identity: (providerId, externalTransactionId). Idempotency: (providerId, idempotencyKey).
 */
export class WagerTransaction {
  private props: WagerTransactionProps;

  private constructor(props: WagerTransactionProps) {
    this.props = props;
  }

  static create(input: CreateWagerTransactionInput): WagerTransaction {
    if (!(SUBMITTABLE_KINDS as readonly string[]).includes(input.kind)) {
      throw new InvalidValueError(`Kind ${String(input.kind)} cannot be submitted`);
    }
    if (input.providerId === SYSTEM_PROVIDER_ID) {
      throw new InvalidValueError(`providerId "${SYSTEM_PROVIDER_ID}" is reserved`);
    }
    if (input.money.isNegative()) throw new InvalidValueError('amount must not be negative');
    if (input.kind !== TransactionKind.LOSS && !input.money.isPositive()) {
      throw new InvalidValueError(`${input.kind} amount must be greater than zero`);
    }
    const requiresReference = input.kind === TransactionKind.REFUND || input.kind === TransactionKind.ROLLBACK;
    if (requiresReference && !input.referenceExternalTransactionId) {
      throw new InvalidValueError(`${input.kind} requires referenceExternalTransactionId`);
    }
    if (ALLOWED_REFERENCE_KINDS[input.kind].length === 0 && input.referenceExternalTransactionId) {
      throw new InvalidValueError(`${input.kind} cannot reference another transaction`);
    }
    if (input.referenceExternalTransactionId === input.externalTransactionId) {
      throw new InvalidValueError('A transaction cannot reference itself');
    }
    if (!/^[0-9a-f]{64}$/.test(input.payloadHash)) throw new InvalidValueError('payloadHash must be a SHA-256 hex digest');

    return new WagerTransaction({
      id: input.id ?? newId(),
      providerId: input.providerId,
      externalTransactionId: input.externalTransactionId,
      idempotencyKey: input.idempotencyKey,
      payloadHash: input.payloadHash,
      walletId: input.walletId,
      playerId: input.playerId,
      roundId: input.roundId,
      gameId: input.gameId,
      kind: input.kind,
      money: input.money,
      referenceExternalTransactionId: input.referenceExternalTransactionId,
      referenceTransactionId: null,
      status: TransactionStatus.PENDING,
      failureCode: null,
      resultBalance: null,
      resultWalletVersion: null,
      referenceAttempts: 0,
      nextReferenceCheckAt: null,
      referenceDeadlineAt: null,
      correlationId: input.correlationId,
      processedAt: null,
      createdAt: input.now,
      updatedAt: input.now,
    });
  }

  /** Internal transaction that justifies the opening CREDIT of a wallet. Born PROCESSED. */
  static opening(input: {
    id?: string;
    walletId: string;
    playerId: string;
    money: Money;
    payloadHash: string;
    correlationId: string | null;
    now: Date;
  }): WagerTransaction {
    if (!input.money.isPositive()) throw new InvalidValueError('OPENING requires a positive amount');
    const id = input.id ?? newId();
    return new WagerTransaction({
      id,
      providerId: SYSTEM_PROVIDER_ID,
      externalTransactionId: `opening:${input.walletId}`,
      idempotencyKey: `opening:${input.walletId}`,
      payloadHash: input.payloadHash,
      walletId: input.walletId,
      playerId: input.playerId,
      roundId: null,
      gameId: null,
      kind: TransactionKind.OPENING,
      money: input.money,
      referenceExternalTransactionId: null,
      referenceTransactionId: null,
      status: TransactionStatus.PROCESSED,
      failureCode: null,
      resultBalance: input.money,
      resultWalletVersion: 1,
      referenceAttempts: 0,
      nextReferenceCheckAt: null,
      referenceDeadlineAt: null,
      correlationId: input.correlationId,
      processedAt: input.now,
      createdAt: input.now,
      updatedAt: input.now,
    });
  }

  /** Rebuilds persisted state without re-running creation or transition rules. */
  static rehydrate(props: WagerTransactionProps): WagerTransaction {
    return new WagerTransaction({ ...props });
  }

  // ---- getters -------------------------------------------------------------
  get id(): string {
    return this.props.id;
  }
  get providerId(): string {
    return this.props.providerId;
  }
  get externalTransactionId(): string {
    return this.props.externalTransactionId;
  }
  get idempotencyKey(): string {
    return this.props.idempotencyKey;
  }
  get payloadHash(): string {
    return this.props.payloadHash;
  }
  get walletId(): string {
    return this.props.walletId;
  }
  get playerId(): string {
    return this.props.playerId;
  }
  get roundId(): string | null {
    return this.props.roundId;
  }
  get gameId(): string | null {
    return this.props.gameId;
  }
  get kind(): TransactionKind {
    return this.props.kind;
  }
  get money(): Money {
    return this.props.money;
  }
  get referenceExternalTransactionId(): string | null {
    return this.props.referenceExternalTransactionId;
  }
  get referenceTransactionId(): string | null {
    return this.props.referenceTransactionId;
  }
  get status(): TransactionStatus {
    return this.props.status;
  }
  get failureCode(): FailureCode | null {
    return this.props.failureCode;
  }
  get resultBalance(): Money | null {
    return this.props.resultBalance;
  }
  get resultWalletVersion(): number | null {
    return this.props.resultWalletVersion;
  }
  get referenceAttempts(): number {
    return this.props.referenceAttempts;
  }
  get nextReferenceCheckAt(): Date | null {
    return this.props.nextReferenceCheckAt;
  }
  get referenceDeadlineAt(): Date | null {
    return this.props.referenceDeadlineAt;
  }
  get correlationId(): string | null {
    return this.props.correlationId;
  }
  get processedAt(): Date | null {
    return this.props.processedAt;
  }
  get createdAt(): Date {
    return this.props.createdAt;
  }
  get updatedAt(): Date {
    return this.props.updatedAt;
  }

  // ---- queries -------------------------------------------------------------
  affectsBalance(): boolean {
    return this.kind !== TransactionKind.LOSS;
  }

  requiresReference(): boolean {
    return this.kind === TransactionKind.REFUND || this.kind === TransactionKind.ROLLBACK;
  }

  hasReference(): boolean {
    return this.referenceExternalTransactionId !== null;
  }

  isReversal(): boolean {
    return this.requiresReference();
  }

  isTerminal(): boolean {
    return TERMINAL_STATUSES.has(this.status);
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  /**
   * Direction of the ledger movement this transaction causes, or null when it
   * does not move money (LOSS). ROLLBACK inverts the direction of its reference.
   */
  ledgerDirectionFor(reference: WagerTransaction | null): LedgerDirection | null {
    switch (this.kind) {
      case TransactionKind.LOSS:
        return null;
      case TransactionKind.BET:
        return LedgerDirection.DEBIT;
      case TransactionKind.OPENING:
      case TransactionKind.WIN:
      case TransactionKind.REFUND:
        return LedgerDirection.CREDIT;
      case TransactionKind.ROLLBACK: {
        if (!reference) throw new InvariantViolationError('ROLLBACK direction needs its reference');
        const original = reference.ledgerDirectionFor(null);
        if (original === null) throw new InvariantViolationError(`Cannot roll back ${reference.kind}`);
        return original === LedgerDirection.DEBIT ? LedgerDirection.CREDIT : LedgerDirection.DEBIT;
      }
    }
  }

  /**
   * Validates a found reference against this transaction. Returns the failure code or
   * null when valid. Does NOT check reversal uniqueness (needs repository knowledge).
   * A reference that is not yet terminal is reported as 'WAIT'.
   */
  validateReference(reference: WagerTransaction): FailureCode | 'WAIT' | null {
    if (reference.id === this.id || reference.externalTransactionId === this.externalTransactionId) {
      return FailureCode.REFERENCE_SELF;
    }
    if (
      reference.providerId !== this.providerId ||
      reference.playerId !== this.playerId ||
      reference.walletId !== this.walletId ||
      !reference.money.hasCurrency(this.money.currency) ||
      reference.roundId !== this.roundId
    ) {
      return FailureCode.REFERENCE_MISMATCH;
    }
    if (!ALLOWED_REFERENCE_KINDS[this.kind].includes(reference.kind)) {
      return FailureCode.REFERENCE_INVALID_KIND;
    }
    if (!reference.isTerminal()) return 'WAIT';
    if (reference.status !== TransactionStatus.PROCESSED) return FailureCode.REFERENCE_NOT_PROCESSED;
    if (this.isReversal() && !reference.money.equals(this.money)) {
      return FailureCode.REFERENCE_AMOUNT_MISMATCH;
    }
    return null;
  }

  // ---- transitions ---------------------------------------------------------
  markProcessed(input: { balanceAfter: Money; walletVersion: number; referenceTransactionId: string | null; now: Date }): void {
    this.transition(TransactionStatus.PROCESSED);
    if (this.hasReference() && !input.referenceTransactionId) {
      throw new InvariantViolationError('A processed transaction with a reference must store the resolved reference id');
    }
    this.props = {
      ...this.props,
      status: TransactionStatus.PROCESSED,
      failureCode: null,
      referenceTransactionId: input.referenceTransactionId,
      resultBalance: input.balanceAfter,
      resultWalletVersion: input.walletVersion,
      nextReferenceCheckAt: null,
      processedAt: input.now,
      updatedAt: input.now,
    };
  }

  markRejected(input: { failureCode: FailureCode; balance: Money; walletVersion: number; now: Date }): void {
    this.transition(TransactionStatus.REJECTED);
    this.props = {
      ...this.props,
      status: TransactionStatus.REJECTED,
      failureCode: input.failureCode,
      resultBalance: input.balance,
      resultWalletVersion: input.walletVersion,
      nextReferenceCheckAt: null,
      processedAt: input.now,
      updatedAt: input.now,
    };
  }

  markFailed(input: { failureCode: FailureCode; now: Date }): void {
    this.transition(TransactionStatus.FAILED);
    this.props = {
      ...this.props,
      status: TransactionStatus.FAILED,
      failureCode: input.failureCode,
      nextReferenceCheckAt: null,
      processedAt: input.now,
      updatedAt: input.now,
    };
  }

  /**
   * Records one more unsuccessful attempt to resolve the reference and schedules the next.
   * The deadline is fixed by the first call and never extended.
   */
  markPendingReference(input: { nextCheckAt: Date; deadlineAt: Date; now: Date }): void {
    this.transition(TransactionStatus.PENDING_REFERENCE);
    if (!this.hasReference()) throw new InvariantViolationError('Only transactions with a reference can wait for it');
    this.props = {
      ...this.props,
      status: TransactionStatus.PENDING_REFERENCE,
      referenceAttempts: this.props.referenceAttempts + 1,
      nextReferenceCheckAt: input.nextCheckAt,
      referenceDeadlineAt: this.props.referenceDeadlineAt ?? input.deadlineAt,
      updatedAt: input.now,
    };
  }

  private transition(to: TransactionStatus): void {
    if (!ALLOWED_TRANSITIONS[this.status].includes(to)) {
      throw new InvalidStateTransitionError(`WagerTransaction(${this.id})`, this.status, to);
    }
  }
}
