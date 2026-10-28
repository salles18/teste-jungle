import { WagerTransactionRejected } from '../../domain/events/wallet-events';
import { OutboxMessage } from '../../domain/messaging/outbox-message';
import { FailureCode, TransactionStatus } from '../../domain/wagering/wager-types';
import { errorFields, type Logger, withLogContext } from '../../observability/logger';
import type { Metrics } from '../../observability/metrics';
import { TransientInfrastructureError } from '../errors';
import type { Clock, UnitOfWork } from '../ports/persistence';
import type { ProcessWagerTransactionUseCase } from './process-wager-transaction';

export interface PendingReferenceRunResult {
  examined: number;
  processed: number;
  rejected: number;
  stillPending: number;
  skipped: number;
  failed: number;
  errors: number;
}

/**
 * Re-evaluates PENDING_REFERENCE transactions whose next check is due.
 *
 * Multi-worker safety without extra claim tables: each candidate is handled in its own
 * SQL transaction that first locks the *wallet* (same lock order as every other write
 * path) and then re-reads the transaction. A second worker that picked the same row
 * blocks on the wallet lock, then sees the new status / next_reference_check_at and
 * skips it. All state lives in PostgreSQL, so a restart simply resumes.
 */
export class ResolvePendingReferencesUseCase {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly wagers: ProcessWagerTransactionUseCase,
    private readonly clock: Clock,
    private readonly metrics: Metrics,
    private readonly logger: Logger,
  ) {}

  async runOnce(limit: number): Promise<PendingReferenceRunResult> {
    const result: PendingReferenceRunResult = {
      examined: 0,
      processed: 0,
      rejected: 0,
      stillPending: 0,
      skipped: 0,
      failed: 0,
      errors: 0,
    };
    const due = await this.uow.read((ctx) => ctx.transactions.findDuePendingReferences(this.clock.now(), limit));
    for (const candidate of due) {
      result.examined++;
      try {
        const status = await withLogContext({ transactionId: candidate.id, walletId: candidate.walletId }, () =>
          this.resolveOne(candidate.id, candidate.walletId),
        );
        if (status === null) result.skipped++;
        else if (status === TransactionStatus.PROCESSED) result.processed++;
        else if (status === TransactionStatus.REJECTED) result.rejected++;
        else result.stillPending++;
      } catch (error) {
        result.errors++;
        this.logger.error({ ...errorFields(error), transactionId: candidate.id }, 'pending reference resolution failed');
        // A transient error leaves the row due: the next sweep retries it.
        // Anything else would fail identically forever, so the transaction is finished as FAILED.
        if (!(error instanceof TransientInfrastructureError)) {
          if (await this.failPermanently(candidate.id, candidate.walletId).catch(() => false)) result.failed++;
        }
      }
    }
    await this.refreshGauge();
    if (result.examined > 0) this.logger.info({ ...result }, 'pending reference sweep finished');
    return result;
  }

  /** Returns the resulting status, or null when another worker already handled it. */
  async resolveOne(transactionId: string, walletId: string): Promise<TransactionStatus | null> {
    const status = await this.uow.run(
      async (ctx) => {
        const wallet = await ctx.wallets.findByIdForUpdate(walletId);
        if (!wallet) return null;
        const tx = await ctx.transactions.findById(transactionId);
        const now = this.clock.now();
        if (
          !tx ||
          tx.status !== TransactionStatus.PENDING_REFERENCE ||
          (tx.nextReferenceCheckAt !== null && tx.nextReferenceCheckAt.getTime() > now.getTime())
        ) {
          return null;
        }
        const outcome = await this.wagers.settle(ctx, tx, wallet);
        await ctx.transactions.save(tx);
        await this.wagers.persistOutcome(ctx, tx, wallet, outcome, {
          correlationId: tx.correlationId,
          causationId: `pending-reference:${tx.id}:${tx.referenceAttempts}`,
        });
        return tx.status;
      },
      { label: 'wager.resolve_pending_reference' },
    );
    if (status && status !== TransactionStatus.PENDING_REFERENCE) {
      this.metrics.transactionsTotal.inc({ kind: 'deferred', status, channel: 'worker' });
    }
    if (status === TransactionStatus.PENDING_REFERENCE) {
      this.metrics.retriesTotal.inc({ component: 'pending_reference', reason: 'reference_missing' });
    }
    return status;
  }

  /** Terminal FAILED (INTERNAL_INVARIANT_VIOLATION) + WagerTransactionRejected event. */
  private async failPermanently(transactionId: string, walletId: string): Promise<boolean> {
    const failed = await this.uow.run(
      async (ctx) => {
        const wallet = await ctx.wallets.findByIdForUpdate(walletId);
        const tx = wallet ? await ctx.transactions.findById(transactionId) : null;
        if (!tx || tx.status !== TransactionStatus.PENDING_REFERENCE) return false;
        const now = this.clock.now();
        tx.markFailed({ failureCode: FailureCode.INTERNAL_INVARIANT_VIOLATION, now });
        await ctx.transactions.save(tx);
        await ctx.outbox.enqueue([
          OutboxMessage.fromEvent(
            WagerTransactionRejected.from(tx, {
              correlationId: tx.correlationId,
              causationId: `failed:${tx.id}`,
              occurredAt: now,
            }),
            now,
          ),
        ]);
        return true;
      },
      { label: 'wager.fail_pending_reference' },
    );
    if (failed) {
      this.metrics.transactionsTotal.inc({ kind: 'deferred', status: TransactionStatus.FAILED, channel: 'worker' });
      this.logger.error({ transactionId }, 'pending transaction marked FAILED after a non-transient error');
    }
    return failed;
  }

  async refreshGauge(): Promise<void> {
    const pending = await this.uow.read((ctx) => ctx.transactions.countByStatus(TransactionStatus.PENDING_REFERENCE));
    this.metrics.pendingReferenceTransactions.set(pending);
  }
}
