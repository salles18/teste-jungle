import { InvalidStateTransitionError } from '../shared/domain-error';
import type { RetryPolicy } from '../shared/retry-policy';

export const InboxStatus = {
  /** Seen at least once, not completed yet (a previous attempt failed transiently). */
  RECEIVED: 'RECEIVED',
  /** Handled to completion (including business rejections). Terminal. */
  PROCESSED: 'PROCESSED',
  /** Permanently failed / invalid; forwarded to the DLQ. Terminal. */
  DEAD_LETTERED: 'DEAD_LETTERED',
} as const;
export type InboxStatus = (typeof InboxStatus)[keyof typeof InboxStatus];

export interface InboxResult {
  outcome: string;
  transactionId: string | null;
  transactionStatus: string | null;
  detail?: string;
}

export interface InboxMessageProps {
  id: string;
  consumerName: string;
  messageId: string;
  status: InboxStatus;
  attempts: number;
  lastError: string | null;
  result: InboxResult | null;
  transactionId: string | null;
  firstReceivedAt: Date;
  lastReceivedAt: Date;
  processedAt: Date | null;
}

/**
 * Record that a given consumer has seen a given broker message.
 *
 * Responsibility split: the inbox deduplicates *deliveries* of one broker message
 * (redelivery after crash / visibility timeout). Financial idempotency of the
 * *operation* is a separate guarantee owned by wager_transactions
 * (provider + idempotency key / external id), which also covers the same
 * operation arriving through HTTP or as a different broker message.
 */
export class InboxMessage {
  private props: InboxMessageProps;

  private constructor(props: InboxMessageProps) {
    this.props = props;
  }

  static rehydrate(props: InboxMessageProps): InboxMessage {
    return new InboxMessage({ ...props });
  }

  get id(): string {
    return this.props.id;
  }
  get consumerName(): string {
    return this.props.consumerName;
  }
  get messageId(): string {
    return this.props.messageId;
  }
  get status(): InboxStatus {
    return this.props.status;
  }
  get attempts(): number {
    return this.props.attempts;
  }
  get lastError(): string | null {
    return this.props.lastError;
  }
  get result(): InboxResult | null {
    return this.props.result;
  }
  get transactionId(): string | null {
    return this.props.transactionId;
  }
  get firstReceivedAt(): Date {
    return this.props.firstReceivedAt;
  }
  get lastReceivedAt(): Date {
    return this.props.lastReceivedAt;
  }
  get processedAt(): Date | null {
    return this.props.processedAt;
  }

  isCompleted(): boolean {
    return this.props.status !== InboxStatus.RECEIVED;
  }

  /** Counts a new attempt; called when processing starts. */
  beginAttempt(now: Date): void {
    this.assertOpen(InboxStatus.RECEIVED);
    this.props = { ...this.props, attempts: this.props.attempts + 1, lastReceivedAt: now };
  }

  markProcessed(result: InboxResult, now: Date): void {
    this.assertOpen(InboxStatus.PROCESSED);
    this.props = {
      ...this.props,
      status: InboxStatus.PROCESSED,
      result,
      transactionId: result.transactionId,
      processedAt: now,
      lastError: null,
    };
  }

  markDeadLettered(reason: string, now: Date): void {
    this.assertOpen(InboxStatus.DEAD_LETTERED);
    this.props = {
      ...this.props,
      status: InboxStatus.DEAD_LETTERED,
      lastError: reason.slice(0, 2000),
      result: { outcome: 'DEAD_LETTERED', transactionId: null, transactionStatus: null, detail: reason.slice(0, 500) },
      processedAt: now,
    };
  }

  recordFailure(error: string): void {
    this.assertOpen(InboxStatus.RECEIVED);
    this.props = { ...this.props, lastError: error.slice(0, 2000) };
  }

  shouldDeadLetter(policy: RetryPolicy): boolean {
    return policy.isExhausted(this.props.attempts);
  }

  private assertOpen(to: string): void {
    if (this.props.status !== InboxStatus.RECEIVED) {
      throw new InvalidStateTransitionError(`InboxMessage(${this.id})`, this.props.status, to);
    }
  }
}
