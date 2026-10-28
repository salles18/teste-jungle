import { SendMessageBatchCommand, type SQSClient } from '@aws-sdk/client-sqs';
import type { OutboxMessage } from '../../domain/messaging/outbox-message';
import type { EventPublisher, PublishResult } from '../outbox/outbox-publisher';

/**
 * Publishes outbox messages to wallet-events.fifo.
 * MessageGroupId = wallet id (per-wallet ordering on the broker),
 * MessageDeduplicationId = eventId (broker drops re-publications within 5 minutes;
 * consumers must still dedupe by eventId beyond that window).
 */
export class SqsEventPublisher implements EventPublisher {
  constructor(
    private readonly client: SQSClient,
    private readonly queueUrl: string,
  ) {}

  async publishBatch(messages: readonly OutboxMessage[]): Promise<PublishResult> {
    const result: PublishResult = { succeeded: [], failed: [] };
    for (let i = 0; i < messages.length; i += 10) {
      const chunk = messages.slice(i, i + 10);
      try {
        const out = await this.client.send(
          new SendMessageBatchCommand({
            QueueUrl: this.queueUrl,
            Entries: chunk.map((m, index) => ({
              Id: String(index),
              MessageBody: JSON.stringify(m.payload),
              MessageGroupId: m.messageGroupId,
              MessageDeduplicationId: m.id,
              MessageAttributes: {
                eventType: { DataType: 'String', StringValue: m.eventType },
                eventVersion: { DataType: 'Number', StringValue: String(m.eventVersion) },
              },
            })),
          }),
        );
        for (const ok of out.Successful ?? []) {
          const msg = chunk[Number(ok.Id)];
          if (msg) result.succeeded.push(msg.id);
        }
        for (const failed of out.Failed ?? []) {
          const msg = chunk[Number(failed.Id)];
          if (msg) result.failed.push({ id: msg.id, error: `${failed.Code}: ${failed.Message ?? ''}` });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        for (const msg of chunk) result.failed.push({ id: msg.id, error: message });
      }
    }
    return result;
  }
}
