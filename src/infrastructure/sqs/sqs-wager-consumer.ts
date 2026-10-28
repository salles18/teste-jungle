import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  type Message,
  ReceiveMessageCommand,
  SendMessageCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import { errorFields, type Logger } from '../../observability/logger';
import type { HandleDecision, WagerMessageHandler } from './wager-message-handler';

export interface SqsConsumerOptions {
  queueUrl: string;
  dlqUrl: string;
  waitTimeSeconds: number;
  maxMessages: number;
  shutdownGraceMs: number;
}

const MAX_VISIBILITY_SECONDS = 43_200;

/**
 * Long-polls wager-transactions.fifo and applies the handler decision:
 *   ack         -> DeleteMessage (only after the handler's SQL transaction committed)
 *   retry       -> ChangeMessageVisibility(backoff)   (message stays in the queue)
 *   dead_letter -> SendMessage to the DLQ, *then* DeleteMessage
 *
 * Messages of one MessageGroupId (= wallet) are processed sequentially and in order;
 * different groups run concurrently. If a message must be retried, the remaining
 * messages of its group in this batch are released untouched, preserving FIFO order.
 *
 * SIGTERM: stop() aborts the long poll, waits for in-flight messages up to the grace
 * period. Anything unfinished is simply redelivered after its visibility timeout —
 * safe, because processing is idempotent (inbox + financial idempotency).
 */
export class SqsWagerConsumer {
  private running = false;
  private loopPromise: Promise<void> | null = null;
  private poll: AbortController | null = null;
  private readonly inFlight = new Set<Promise<void>>();

  constructor(
    private readonly client: SQSClient,
    private readonly handler: WagerMessageHandler,
    private readonly options: SqsConsumerOptions,
    private readonly logger: Logger,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loopPromise = this.loop();
    this.logger.info({ queueUrl: this.options.queueUrl }, 'sqs consumer started');
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.poll?.abort();
    const grace = new Promise<void>((resolve) => setTimeout(resolve, this.options.shutdownGraceMs));
    await Promise.race([Promise.all([this.loopPromise, ...this.inFlight]), grace]);
    this.logger.info({ unfinished: this.inFlight.size }, 'sqs consumer stopped');
  }

  /** Receives and fully handles one batch. Exposed for tests and scripts. */
  async pollOnce(): Promise<number> {
    this.poll = new AbortController();
    let messages: Message[];
    try {
      const out = await this.client.send(
        new ReceiveMessageCommand({
          QueueUrl: this.options.queueUrl,
          MaxNumberOfMessages: this.options.maxMessages,
          WaitTimeSeconds: this.options.waitTimeSeconds,
          MessageSystemAttributeNames: ['ApproximateReceiveCount', 'MessageGroupId'],
          // legacy spelling of the same request; some SQS emulators only honour this one
          AttributeNames: ['ApproximateReceiveCount', 'MessageGroupId'] as never,
          MessageAttributeNames: ['All'],
        }),
        { abortSignal: this.poll.signal },
      );
      messages = out.Messages ?? [];
    } catch (error) {
      if (!this.running && (error as Error).name === 'AbortError') return 0;
      throw error;
    }
    if (messages.length === 0) return 0;

    const groups = new Map<string, Message[]>();
    for (const m of messages) {
      const group = m.Attributes?.MessageGroupId ?? m.MessageId ?? 'unknown';
      const list = groups.get(group) ?? [];
      list.push(m);
      groups.set(group, list);
    }
    const work = Promise.all([...groups.values()].map((group) => this.processGroup(group))).then(() => undefined);
    this.inFlight.add(work);
    try {
      await work;
    } finally {
      this.inFlight.delete(work);
    }
    return messages.length;
  }

  private async loop(): Promise<void> {
    while (this.running) {
      try {
        await this.pollOnce();
      } catch (error) {
        this.logger.error({ ...errorFields(error) }, 'sqs receive failed');
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
  }

  private async processGroup(messages: Message[]): Promise<void> {
    for (let i = 0; i < messages.length; i++) {
      const message = messages[i] as Message;
      const decision = await this.handleSafely(message);
      await this.apply(message, decision);
      if (decision.action === 'retry') {
        // keep FIFO order: hand the rest of the group back without processing it
        for (const rest of messages.slice(i + 1)) await this.setVisibility(rest, 0);
        return;
      }
    }
  }

  private async handleSafely(message: Message): Promise<HandleDecision> {
    if (!message.MessageId || message.Body === undefined) {
      return { action: 'dead_letter', reason: 'INVALID_MESSAGE: missing id or body' };
    }
    try {
      return await this.handler.handle({
        messageId: message.MessageId,
        body: message.Body,
        receiveCount: Number.parseInt(message.Attributes?.ApproximateReceiveCount ?? '1', 10),
      });
    } catch (error) {
      // the handler converts every failure into a decision; reaching this is a bug
      this.logger.error({ ...errorFields(error) }, 'handler threw unexpectedly');
      return { action: 'retry', delayMs: 5000, attempts: 0, reason: 'handler error' };
    }
  }

  private async apply(message: Message, decision: HandleDecision): Promise<void> {
    try {
      switch (decision.action) {
        case 'ack':
          await this.delete(message);
          return;
        case 'retry':
          await this.setVisibility(message, Math.ceil(decision.delayMs / 1000));
          return;
        case 'dead_letter':
          await this.client.send(
            new SendMessageCommand({
              QueueUrl: this.options.dlqUrl,
              MessageBody: message.Body ?? '',
              MessageGroupId: message.Attributes?.MessageGroupId ?? 'dead-letter',
              MessageDeduplicationId: message.MessageId,
              MessageAttributes: {
                originalMessageId: { DataType: 'String', StringValue: message.MessageId ?? 'unknown' },
                deadLetterReason: { DataType: 'String', StringValue: decision.reason.slice(0, 256) },
              },
            }),
          );
          await this.delete(message);
          return;
      }
    } catch (error) {
      // not acked => redelivered later; idempotency makes that safe
      this.logger.error({ ...errorFields(error), action: decision.action }, 'failed to apply message decision');
    }
  }

  private async delete(message: Message): Promise<void> {
    await this.client.send(new DeleteMessageCommand({ QueueUrl: this.options.queueUrl, ReceiptHandle: message.ReceiptHandle }));
  }

  private async setVisibility(message: Message, seconds: number): Promise<void> {
    await this.client.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: this.options.queueUrl,
        ReceiptHandle: message.ReceiptHandle,
        VisibilityTimeout: Math.min(MAX_VISIBILITY_SECONDS, Math.max(0, seconds)),
      }),
    );
  }
}
