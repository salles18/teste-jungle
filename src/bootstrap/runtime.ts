import type { SQSClient } from '@aws-sdk/client-sqs';
import { RetryPolicy } from '../domain/shared/retry-policy';
import { OutboxPublisher } from '../infrastructure/outbox/outbox-publisher';
import { createSqsClient, type QueueUrls, resolveQueueUrls } from '../infrastructure/sqs/sqs';
import { SqsEventPublisher } from '../infrastructure/sqs/sqs-event-publisher';
import { SqsWagerConsumer } from '../infrastructure/sqs/sqs-wager-consumer';
import { WagerMessageHandler } from '../infrastructure/sqs/wager-message-handler';
import { PollingLoop } from '../infrastructure/workers/polling-loop';
import { errorFields } from '../observability/logger';
import type { Container } from './container';

/**
 * Background roles of one process, each toggled by configuration:
 *  RUN_PENDING_REFERENCE_WORKER  (PostgreSQL only)
 *  RUN_SQS_CONSUMER              (needs SQS)
 *  RUN_OUTBOX_PUBLISHER          (needs SQS)
 * If SQS is unreachable at boot, SQS roles keep retrying in the background instead of
 * crashing the process; /health/ready reports SQS as down meanwhile.
 */
export class Runtime {
  readonly sqs: SQSClient | null;
  queueUrls: QueueUrls | null = null;
  consumer: SqsWagerConsumer | null = null;
  outboxLoop: PollingLoop | null = null;
  pendingLoop: PollingLoop | null = null;
  private stopped = false;
  private sqsInit: Promise<void> | null = null;

  constructor(private readonly c: Container) {
    const needsSqs = c.config.consumer.enabled || c.config.outbox.enabled;
    this.sqs = needsSqs ? createSqsClient(c.config) : null;
  }

  start(): void {
    const { config, logger } = this.c;
    if (config.pendingReference.enabled) {
      this.pendingLoop = new PollingLoop(
        'pending-reference',
        config.pendingReference.pollIntervalMs,
        async () => (await this.c.pendingReferences.runOnce(config.pendingReference.batchSize)).examined > 0,
        logger,
      );
      this.pendingLoop.start();
    }
    if (this.sqs) this.sqsInit = this.startSqsRoles(this.sqs);
  }

  private async startSqsRoles(sqs: SQSClient): Promise<void> {
    const { config, logger } = this.c;
    while (!this.stopped && !this.queueUrls) {
      try {
        this.queueUrls = await resolveQueueUrls(sqs, config);
      } catch (error) {
        logger.warn({ ...errorFields(error) }, 'SQS queues not available yet, retrying in 5s');
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }
    }
    if (this.stopped || !this.queueUrls) return;

    if (config.outbox.enabled) {
      const publisher = new OutboxPublisher(
        this.c.outboxStore,
        new SqsEventPublisher(sqs, this.queueUrls.events),
        new RetryPolicy({
          maxAttempts: config.outbox.maxAttempts,
          baseDelayMs: config.outbox.baseBackoffMs,
          maxDelayMs: config.outbox.maxBackoffMs,
        }),
        this.c.metrics,
        logger,
        { owner: config.instanceId, batchSize: config.outbox.batchSize, leaseMs: config.outbox.leaseMs },
      );
      this.outboxLoop = new PollingLoop(
        'outbox-publisher',
        config.outbox.pollIntervalMs,
        async () => (await publisher.publishOnce()).claimed > 0,
        logger,
      );
      this.outboxLoop.start();
    }

    if (config.consumer.enabled) {
      const handler = new WagerMessageHandler(
        config.consumer.name,
        this.c.uow,
        this.c.wagers,
        new RetryPolicy({
          maxAttempts: config.consumer.maxAttempts,
          baseDelayMs: config.consumer.baseBackoffMs,
          maxDelayMs: config.consumer.maxBackoffMs,
        }),
        this.c.clock,
        this.c.metrics,
        logger,
      );
      this.consumer = new SqsWagerConsumer(
        sqs,
        handler,
        {
          queueUrl: this.queueUrls.wager,
          dlqUrl: this.queueUrls.dlq,
          waitTimeSeconds: config.consumer.waitTimeSeconds,
          maxMessages: config.consumer.maxMessages,
          shutdownGraceMs: config.consumer.shutdownGraceMs,
        },
        logger,
      );
      this.consumer.start();
    }
  }

  /** Stop intake first, then background workers; the outbox stops last to flush events. */
  async stop(): Promise<void> {
    this.stopped = true;
    await this.consumer?.stop();
    await this.pendingLoop?.stop();
    await this.outboxLoop?.stop();
    await this.sqsInit?.catch(() => undefined);
    this.sqs?.destroy();
  }
}
