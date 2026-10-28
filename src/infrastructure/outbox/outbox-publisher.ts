import type { OutboxMessage } from '../../domain/messaging/outbox-message';
import { OutboxStatus } from '../../domain/messaging/outbox-message';
import type { RetryPolicy } from '../../domain/shared/retry-policy';
import { errorFields, type Logger } from '../../observability/logger';
import type { Metrics } from '../../observability/metrics';
import type { OutboxStore } from './outbox-store';

export interface PublishResult {
  succeeded: string[];
  failed: { id: string; error: string }[];
}

/** Port to the external broker. */
export interface EventPublisher {
  publishBatch(messages: readonly OutboxMessage[]): Promise<PublishResult>;
}

export interface OutboxPublisherOptions {
  owner: string;
  batchSize: number;
  leaseMs: number;
}

export interface PublishCycle {
  claimed: number;
  published: number;
  failed: number;
  dead: number;
}

/**
 * Relays committed outbox rows to the broker. At-least-once: if the process dies
 * after the broker accepted a message but before markPublished, the lease expires and
 * the message is sent again. Exactly-once delivery to an external system would need
 * the broker to take part in our database transaction (2PC), which SQS does not
 * support; instead every event carries a stable eventId (also used as the SQS FIFO
 * deduplication id) and consumers deduplicate on it.
 */
export class OutboxPublisher {
  constructor(
    private readonly store: OutboxStore,
    private readonly publisher: EventPublisher,
    private readonly policy: RetryPolicy,
    private readonly metrics: Metrics,
    private readonly logger: Logger,
    private readonly options: OutboxPublisherOptions,
  ) {}

  async publishOnce(): Promise<PublishCycle> {
    const cycle: PublishCycle = { claimed: 0, published: 0, failed: 0, dead: 0 };
    const batch = await this.store.claimBatch(this.options.owner, this.options.batchSize, this.options.leaseMs);
    cycle.claimed = batch.length;

    if (batch.length > 0) {
      let result: PublishResult;
      try {
        result = await this.publisher.publishBatch(batch);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        result = { succeeded: [], failed: batch.map((m) => ({ id: m.id, error: message })) };
        this.logger.warn({ ...errorFields(error), batch: batch.length }, 'outbox batch publish failed');
      }

      cycle.published = await this.store.markPublished(result.succeeded);
      const byId = new Map(batch.map((m) => [m.id, m]));
      for (const id of result.succeeded) {
        const msg = byId.get(id);
        if (msg) this.metrics.outboxPublishedTotal.inc({ event_type: msg.eventType });
      }

      const now = this.store.now();
      for (const failure of result.failed) {
        const msg = byId.get(failure.id);
        if (!msg) continue;
        msg.recordFailure(failure.error, this.policy, now);
        const saved = await this.store.saveFailure(msg, this.options.owner, now);
        cycle.failed++;
        if (msg.status === OutboxStatus.DEAD) {
          cycle.dead++;
          this.metrics.outboxFailuresTotal.inc({ outcome: 'dead' });
          this.logger.error({ outboxId: msg.id, eventType: msg.eventType, attempts: msg.attempts }, 'outbox message dead');
        } else {
          this.metrics.outboxFailuresTotal.inc({ outcome: 'retry' });
          this.metrics.retriesTotal.inc({ component: 'outbox', reason: 'publish_failed' });
        }
        if (!saved) this.logger.warn({ outboxId: msg.id }, 'outbox lease lost before failure was recorded');
      }
    }

    const stats = await this.store.stats();
    this.metrics.outboxPending.set(stats.pending);
    this.metrics.outboxLagSeconds.set(stats.oldestPendingAgeSeconds);
    return cycle;
  }
}
