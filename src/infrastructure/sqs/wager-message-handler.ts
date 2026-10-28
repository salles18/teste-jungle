import {
  CommandRejectedError,
  CommandValidationError,
  IdempotencyConflictError,
  WalletNotFoundError,
} from '../../application/errors';
import type { Clock, UnitOfWork } from '../../application/ports/persistence';
import type {
  ProcessWagerTransactionUseCase,
  WagerCommand,
  WagerResult,
} from '../../application/wagering/process-wager-transaction';
import { InboxStatus } from '../../domain/messaging/inbox-message';
import type { RetryPolicy } from '../../domain/shared/retry-policy';
import { validateIdempotencyKey, validateWagerContract } from '../../interfaces/contracts/wager-transaction.contract';
import { enrichLogContext, errorFields, type Logger, withLogContext } from '../../observability/logger';
import type { Metrics } from '../../observability/metrics';

/** Transport-neutral view of a received broker message. */
export interface IncomingMessage {
  messageId: string;
  body: string;
  /** Broker-side receive count (SQS ApproximateReceiveCount). */
  receiveCount: number;
}

export type HandleDecision =
  | { action: 'ack'; outcome: 'processed' | 'duplicate'; transactionId: string | null; transactionStatus: string | null }
  | { action: 'retry'; delayMs: number; attempts: number; reason: string }
  | { action: 'dead_letter'; reason: string };

/**
 * Message envelope on wager-transactions.fifo:
 *   { "idempotencyKey": "...", "correlationId": "..."?, "transaction": { ...WagerTransactionContract } }
 */
interface WagerMessageBody {
  idempotencyKey: unknown;
  correlationId?: unknown;
  transaction: unknown;
}

const PERMANENT_ERRORS = [IdempotencyConflictError, WalletNotFoundError, CommandRejectedError, CommandValidationError];

/**
 * Consumer-side processing of one wager message.
 *
 * In ONE SQL transaction: lock/insert the inbox row (consumerName, messageId), run the
 * same financial use case as HTTP, mark the inbox PROCESSED, commit. Only after that
 * the caller deletes (acks) the broker message. A crash between commit and ack leads
 * to redelivery, which finds the PROCESSED inbox row and just acks.
 *
 *  - business rejection (REJECTED transaction)         -> committed, ack (terminal)
 *  - malformed / incoherent / idempotency conflict     -> inbox DEAD_LETTERED, DLQ
 *  - transient error                                    -> rollback, attempt recorded out
 *                                                          of band, retry with backoff
 *  - attempts exhausted                                 -> inbox DEAD_LETTERED, DLQ
 */
export class WagerMessageHandler {
  constructor(
    private readonly consumerName: string,
    private readonly uow: UnitOfWork,
    private readonly wagers: ProcessWagerTransactionUseCase,
    private readonly retryPolicy: RetryPolicy,
    private readonly clock: Clock,
    private readonly metrics: Metrics,
    private readonly logger: Logger,
  ) {}

  handle(message: IncomingMessage): Promise<HandleDecision> {
    return withLogContext({ messageId: message.messageId }, () => this.handleInContext(message));
  }

  private async handleInContext(message: IncomingMessage): Promise<HandleDecision> {
    const started = performance.now();
    const parsed = this.parse(message.body);
    if (!parsed.ok) {
      return this.deadLetter(message, `INVALID_MESSAGE: ${parsed.violations.join('; ')}`);
    }
    const { command, idempotencyKey, correlationId } = parsed;
    enrichLogContext({ correlationId: correlationId ?? undefined, providerId: command.providerId, walletId: command.walletId });

    try {
      const outcome = await this.uow.run(
        async (ctx) => {
          const inbox = await ctx.inbox.acquire(this.consumerName, message.messageId, this.clock.now());
          if (inbox.isCompleted()) return { kind: 'already_handled' as const, inbox };

          inbox.beginAttempt(this.clock.now());
          let result: WagerResult;
          try {
            result = await this.wagers.executeInTransaction(ctx, command, {
              idempotencyKey,
              correlationId,
              causationId: message.messageId,
              channel: 'sqs',
            });
          } catch (error) {
            const permanent = PERMANENT_ERRORS.find((type) => error instanceof type);
            if (!permanent) throw error;
            // nothing financial was written (these are raised before any write);
            // commit the inbox decision so redeliveries are not re-evaluated.
            const reason = `${(error as { code: string }).code}: ${(error as Error).message}`;
            inbox.markDeadLettered(reason, this.clock.now());
            await ctx.inbox.save(inbox);
            return { kind: 'permanent_failure' as const, reason };
          }
          inbox.markProcessed(
            {
              outcome: result.idempotentReplay ? 'IDEMPOTENT_REPLAY' : 'APPLIED',
              transactionId: result.transaction.id,
              transactionStatus: result.transaction.status,
            },
            this.clock.now(),
          );
          await ctx.inbox.save(inbox);
          return { kind: 'processed' as const, result };
        },
        { label: 'sqs.wager_message' },
      );

      switch (outcome.kind) {
        case 'already_handled': {
          this.metrics.duplicatesTotal.inc({ type: 'inbox_redelivery', channel: 'sqs' });
          this.logger.info({ inboxStatus: outcome.inbox.status }, 'redelivered message already handled');
          if (outcome.inbox.status === InboxStatus.DEAD_LETTERED) {
            return { action: 'dead_letter', reason: outcome.inbox.lastError ?? 'previously dead-lettered' };
          }
          return {
            action: 'ack',
            outcome: 'duplicate',
            transactionId: outcome.inbox.transactionId,
            transactionStatus: outcome.inbox.result?.transactionStatus ?? null,
          };
        }
        case 'permanent_failure':
          this.metrics.dlqMessagesTotal.inc({ reason: 'permanent' });
          this.logger.warn({ reason: outcome.reason }, 'message permanently failed');
          return { action: 'dead_letter', reason: outcome.reason };
        case 'processed': {
          this.wagers.record(outcome.result, 'sqs');
          this.metrics.processingLatency.observe(
            { channel: 'sqs', outcome: outcome.result.transaction.status },
            (performance.now() - started) / 1000,
          );
          return {
            action: 'ack',
            outcome: 'processed',
            transactionId: outcome.result.transaction.id,
            transactionStatus: outcome.result.transaction.status,
          };
        }
      }
    } catch (error) {
      return this.transientFailure(message, error);
    }
  }

  private async transientFailure(message: IncomingMessage, error: unknown): Promise<HandleDecision> {
    const reason = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    let attempts = message.receiveCount;
    try {
      const inbox = await this.uow.run(
        (ctx) => ctx.inbox.recordFailedAttempt(this.consumerName, message.messageId, reason, this.clock.now()),
        { label: 'sqs.inbox_failure', retry: false },
      );
      attempts = Math.max(attempts, inbox.attempts);
    } catch (bookkeepingError) {
      // the database is probably down; the broker receive count is the fallback counter
      this.logger.warn({ ...errorFields(bookkeepingError) }, 'could not record failed attempt');
    }

    if (this.retryPolicy.isExhausted(attempts)) {
      this.metrics.dlqMessagesTotal.inc({ reason: 'retries_exhausted' });
      return this.deadLetter(message, `RETRIES_EXHAUSTED after ${attempts} attempts: ${reason}`);
    }
    const delayMs = this.retryPolicy.delayAfter(attempts);
    this.metrics.retriesTotal.inc({ component: 'sqs_consumer', reason: error instanceof Error ? error.name : 'unknown' });
    this.logger.warn({ ...errorFields(error), attempts, delayMs }, 'message processing failed, will retry');
    return { action: 'retry', delayMs, attempts, reason };
  }

  private async deadLetter(message: IncomingMessage, reason: string): Promise<HandleDecision> {
    try {
      await this.uow.run(
        async (ctx) => {
          const inbox = await ctx.inbox.acquire(this.consumerName, message.messageId, this.clock.now());
          if (!inbox.isCompleted()) {
            inbox.markDeadLettered(reason, this.clock.now());
            await ctx.inbox.save(inbox);
          }
        },
        { label: 'sqs.inbox_dead_letter' },
      );
    } catch (error) {
      this.logger.warn({ ...errorFields(error) }, 'could not record dead letter in inbox');
    }
    if (reason.startsWith('INVALID_MESSAGE')) this.metrics.dlqMessagesTotal.inc({ reason: 'invalid' });
    this.logger.warn({ reason }, 'message dead-lettered');
    return { action: 'dead_letter', reason };
  }

  private parse(
    body: string,
  ):
    | { ok: true; command: WagerCommand; idempotencyKey: string; correlationId: string | null }
    | { ok: false; violations: string[] } {
    let json: WagerMessageBody;
    try {
      json = JSON.parse(body) as WagerMessageBody;
    } catch {
      return { ok: false, violations: ['body is not valid JSON'] };
    }
    if (!json || typeof json !== 'object') return { ok: false, violations: ['body must be an object'] };
    const key = validateIdempotencyKey(json.idempotencyKey);
    if (!key.ok) return key;
    const contract = validateWagerContract(json.transaction);
    if (!contract.ok) return contract;
    const correlationId =
      typeof json.correlationId === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(json.correlationId) ? json.correlationId : null;
    return { ok: true, command: contract.value, idempotencyKey: key.value, correlationId };
  }
}
