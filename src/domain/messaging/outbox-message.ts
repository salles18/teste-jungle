import type { EventEnvelope, IntegrationEvent } from '../events/integration-event';
import { InvalidStateTransitionError } from '../shared/domain-error';
import type { RetryPolicy } from '../shared/retry-policy';

export const OutboxStatus = {
  PENDING: 'PENDING',
  PUBLISHED: 'PUBLISHED',
  /** Gave up after the retry budget. Kept forever for manual requeue — never deleted. */
  DEAD: 'DEAD',
} as const;
export type OutboxStatus = (typeof OutboxStatus)[keyof typeof OutboxStatus];

export interface OutboxMessageProps {
  id: string;
  eventType: string;
  eventVersion: number;
  aggregateType: string;
  aggregateId: string;
  messageGroupId: string;
  payload: EventEnvelope;
  status: OutboxStatus;
  attempts: number;
  nextAttemptAt: Date;
  lockedBy: string | null;
  lockedUntil: Date | null;
  lastError: string | null;
  publishedAt: Date | null;
  occurredAt: Date;
  createdAt: Date;
}

/**
 * An integration event persisted in the same SQL transaction as the state change that
 * caused it. Publication is at-least-once; consumers deduplicate by eventId.
 */
export class OutboxMessage {
  private props: OutboxMessageProps;

  private constructor(props: OutboxMessageProps) {
    this.props = props;
  }

  static fromEvent(event: IntegrationEvent, now: Date): OutboxMessage {
    return new OutboxMessage({
      id: event.eventId,
      eventType: event.eventType,
      eventVersion: event.version,
      aggregateType: event.aggregateType,
      aggregateId: event.aggregateId,
      messageGroupId: event.messageGroupId,
      payload: event.toEnvelope(),
      status: OutboxStatus.PENDING,
      attempts: 0,
      nextAttemptAt: now,
      lockedBy: null,
      lockedUntil: null,
      lastError: null,
      publishedAt: null,
      occurredAt: event.occurredAt,
      createdAt: now,
    });
  }

  static rehydrate(props: OutboxMessageProps): OutboxMessage {
    return new OutboxMessage({ ...props });
  }

  get id(): string {
    return this.props.id;
  }
  get eventType(): string {
    return this.props.eventType;
  }
  get eventVersion(): number {
    return this.props.eventVersion;
  }
  get aggregateType(): string {
    return this.props.aggregateType;
  }
  get aggregateId(): string {
    return this.props.aggregateId;
  }
  get messageGroupId(): string {
    return this.props.messageGroupId;
  }
  get payload(): EventEnvelope {
    return this.props.payload;
  }
  get status(): OutboxStatus {
    return this.props.status;
  }
  get attempts(): number {
    return this.props.attempts;
  }
  get nextAttemptAt(): Date {
    return this.props.nextAttemptAt;
  }
  get lockedBy(): string | null {
    return this.props.lockedBy;
  }
  get lockedUntil(): Date | null {
    return this.props.lockedUntil;
  }
  get lastError(): string | null {
    return this.props.lastError;
  }
  get publishedAt(): Date | null {
    return this.props.publishedAt;
  }
  get occurredAt(): Date {
    return this.props.occurredAt;
  }
  get createdAt(): Date {
    return this.props.createdAt;
  }

  markPublished(now: Date): void {
    if (this.props.status !== OutboxStatus.PENDING) {
      throw new InvalidStateTransitionError(`OutboxMessage(${this.id})`, this.props.status, OutboxStatus.PUBLISHED);
    }
    this.props = { ...this.props, status: OutboxStatus.PUBLISHED, publishedAt: now, lockedBy: null, lockedUntil: null };
  }

  /** `attempts` was already incremented when the message was claimed. */
  recordFailure(error: string, policy: RetryPolicy, now: Date): void {
    if (this.props.status !== OutboxStatus.PENDING) {
      throw new InvalidStateTransitionError(`OutboxMessage(${this.id})`, this.props.status, 'FAILED_ATTEMPT');
    }
    const exhausted = policy.isExhausted(this.props.attempts);
    this.props = {
      ...this.props,
      status: exhausted ? OutboxStatus.DEAD : OutboxStatus.PENDING,
      lastError: error.slice(0, 2000),
      nextAttemptAt: exhausted ? this.props.nextAttemptAt : policy.nextAttemptAt(this.props.attempts, now),
      lockedBy: null,
      lockedUntil: null,
    };
  }
}
