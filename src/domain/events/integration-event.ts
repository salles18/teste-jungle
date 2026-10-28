import { newId } from '../shared/ids';

export interface EventEnvelope<TData = unknown> {
  eventId: string;
  eventType: string;
  version: number;
  aggregateType: string;
  aggregateId: string;
  correlationId: string | null;
  causationId: string | null;
  /** ISO-8601 UTC. */
  occurredAt: string;
  data: TData;
}

export interface EventMetadata {
  correlationId: string | null;
  causationId: string | null;
  occurredAt: Date;
  eventId?: string;
}

/**
 * Event published to other bounded contexts through the transactional outbox.
 * `data` must only contain JSON primitives — money is always { amount: string, currency }.
 */
export abstract class IntegrationEvent<TData extends object = object> {
  abstract readonly eventType: string;
  abstract readonly version: number;
  abstract readonly aggregateType: string;

  readonly eventId: string;
  readonly correlationId: string | null;
  readonly causationId: string | null;
  readonly occurredAt: Date;

  protected constructor(
    readonly aggregateId: string,
    /** Ordering scope on the broker (SQS FIFO MessageGroupId). We use the wallet id. */
    readonly messageGroupId: string,
    readonly data: TData,
    meta: EventMetadata,
  ) {
    this.eventId = meta.eventId ?? newId();
    this.correlationId = meta.correlationId;
    this.causationId = meta.causationId;
    this.occurredAt = meta.occurredAt;
  }

  toEnvelope(): EventEnvelope<TData> {
    return {
      eventId: this.eventId,
      eventType: this.eventType,
      version: this.version,
      aggregateType: this.aggregateType,
      aggregateId: this.aggregateId,
      correlationId: this.correlationId,
      causationId: this.causationId,
      occurredAt: this.occurredAt.toISOString(),
      data: this.data,
    };
  }
}
