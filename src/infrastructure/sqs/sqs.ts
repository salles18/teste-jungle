import {
  CreateQueueCommand,
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  ListQueuesCommand,
  SetQueueAttributesCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import type { AppConfig } from '../../config/app-config';

export function createSqsClient(config: AppConfig): SQSClient {
  return new SQSClient({
    region: config.aws.region,
    ...(config.aws.endpoint ? { endpoint: config.aws.endpoint } : {}),
    credentials: { accessKeyId: config.aws.accessKeyId, secretAccessKey: config.aws.secretAccessKey },
    maxAttempts: 3,
  });
}

export interface QueueUrls {
  wager: string;
  dlq: string;
  events: string;
}

export async function resolveQueueUrls(client: SQSClient, config: AppConfig): Promise<QueueUrls> {
  const url = async (name: string): Promise<string> => {
    const out = await client.send(new GetQueueUrlCommand({ QueueName: name }));
    if (!out.QueueUrl) throw new Error(`Queue ${name} not found`);
    return out.QueueUrl;
  };
  return {
    wager: await url(config.sqs.wagerQueueName),
    dlq: await url(config.sqs.wagerDlqName),
    events: await url(config.sqs.eventsQueueName),
  };
}

/**
 * Idempotently creates the FIFO queues:
 *  - wager-transactions-dlq.fifo : dead letters, 14 days retention
 *  - wager-transactions.fifo     : inbound instructions; redrive to the DLQ after
 *                                  `redriveMaxReceiveCount` receives (safety net — the
 *                                  consumer dead-letters explicitly earlier)
 *  - wallet-events.fifo          : outbound integration events from the outbox
 */
export async function ensureQueues(client: SQSClient, config: AppConfig): Promise<QueueUrls> {
  // Converges instead of failing: SQS rejects CreateQueue for an existing queue whose
  // attributes differ (e.g. created by the LocalStack init script, or by an older config).
  // In that case the queue's mutable attributes are updated to the current configuration.
  const create = async (name: string, attributes: Record<string, string>): Promise<string> => {
    try {
      const out = await client.send(new CreateQueueCommand({ QueueName: name, Attributes: attributes }));
      if (!out.QueueUrl) throw new Error(`Could not create ${name}`);
      return out.QueueUrl;
    } catch (error) {
      if (!isQueueExistsError(error)) throw error;
      const existing = await client.send(new GetQueueUrlCommand({ QueueName: name }));
      if (!existing.QueueUrl) throw error;
      const { FifoQueue: _immutable, ...mutable } = attributes;
      await client.send(new SetQueueAttributesCommand({ QueueUrl: existing.QueueUrl, Attributes: mutable }));
      return existing.QueueUrl;
    }
  };
  const visibility = String(config.sqs.visibilityTimeoutSeconds);

  const dlq = await create(config.sqs.wagerDlqName, {
    FifoQueue: 'true',
    ContentBasedDeduplication: 'false',
    MessageRetentionPeriod: '1209600',
    VisibilityTimeout: visibility,
  });
  const dlqAttributes = await client.send(new GetQueueAttributesCommand({ QueueUrl: dlq, AttributeNames: ['QueueArn'] }));
  const dlqArn = dlqAttributes.Attributes?.QueueArn;
  if (!dlqArn) throw new Error('DLQ has no ARN');

  const wager = await create(config.sqs.wagerQueueName, {
    FifoQueue: 'true',
    // producers should send an explicit MessageDeduplicationId (e.g. the Idempotency-Key);
    // content-based dedup is a fallback. Either way it is only a 5-minute optimisation.
    ContentBasedDeduplication: 'true',
    VisibilityTimeout: visibility,
    MessageRetentionPeriod: '345600',
    ReceiveMessageWaitTimeSeconds: '10',
    RedrivePolicy: JSON.stringify({
      deadLetterTargetArn: dlqArn,
      maxReceiveCount: String(config.sqs.redriveMaxReceiveCount),
    }),
  });
  const events = await create(config.sqs.eventsQueueName, {
    FifoQueue: 'true',
    ContentBasedDeduplication: 'false',
    VisibilityTimeout: visibility,
  });
  return { wager, dlq, events };
}

function isQueueExistsError(error: unknown): boolean {
  const e = error as { name?: string; Code?: string; message?: string };
  return (
    e?.name === 'QueueNameExists' ||
    e?.name === 'QueueAlreadyExists' ||
    e?.Code === 'QueueAlreadyExists' ||
    /already exists/i.test(e?.message ?? '')
  );
}

/** Cheap readiness probe for the broker. */
export async function pingSqs(client: SQSClient, timeoutMs: number): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    await client.send(new ListQueuesCommand({ MaxResults: 1 }), { abortSignal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}
