import { IsolationLevel } from '@mikro-orm/core';
import type { EntityManager, MikroORM } from '@mikro-orm/postgresql';
import { ApplicationError, IntegrityViolationError, TransientInfrastructureError } from '../../application/errors';
import type { TransactionContext, UnitOfWork, UnitOfWorkOptions } from '../../application/ports/persistence';
import { DuplicateWalletSignal } from '../../application/wallet/wallet-use-cases';
import { DomainError } from '../../domain/shared/domain-error';
import { RetryPolicy } from '../../domain/shared/retry-policy';
import { errorFields, type Logger } from '../../observability/logger';
import type { Metrics } from '../../observability/metrics';
import { classifyDbError, isRetryable } from './pg-errors';
import { createTransactionContext } from './repositories';

export interface UnitOfWorkSettings {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  lockTimeoutMs: number;
  statementTimeoutMs: number;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * One SQL transaction per call, on a freshly forked EntityManager (never shared between
 * concurrent operations; the global EM is disabled by `allowGlobalContext: false`).
 *
 * Transient failures (deadlock, lock timeout, serialization, dropped connection,
 * duplicate-insert race) re-run the whole closure with jittered exponential backoff,
 * up to `maxAttempts`. This is safe because every write path re-checks idempotency
 * under the wallet lock, so a retry can never apply an effect twice — including the
 * case where COMMIT succeeded but the acknowledgement was lost.
 */
export class MikroOrmUnitOfWork implements UnitOfWork {
  private readonly backoff: RetryPolicy;

  constructor(
    private readonly orm: MikroORM,
    private readonly settings: UnitOfWorkSettings,
    private readonly metrics: Metrics,
    private readonly logger: Logger,
  ) {
    this.backoff = new RetryPolicy({
      maxAttempts: settings.maxAttempts,
      baseDelayMs: settings.baseDelayMs,
      maxDelayMs: settings.maxDelayMs,
      jitterRatio: 1,
    });
  }

  async run<T>(work: (ctx: TransactionContext) => Promise<T>, options: UnitOfWorkOptions): Promise<T> {
    const maxAttempts = options.retry === false ? 1 : this.settings.maxAttempts;
    const isolationLevel =
      options.isolation === 'REPEATABLE READ' ? IsolationLevel.REPEATABLE_READ : IsolationLevel.READ_COMMITTED;

    for (let attempt = 1; ; attempt++) {
      const em = this.orm.em.fork({ clear: true }) as EntityManager;
      try {
        return await em.transactional(
          async (txEm) => {
            // Integer settings, interpolated only after validation by config parsing.
            await txEm.execute(`SET LOCAL lock_timeout = ${Math.trunc(this.settings.lockTimeoutMs)}`);
            await txEm.execute(`SET LOCAL statement_timeout = ${Math.trunc(this.settings.statementTimeoutMs)}`);
            return work(createTransactionContext(txEm));
          },
          { isolationLevel, readOnly: options.readOnly ?? false },
        );
      } catch (error) {
        if (error instanceof ApplicationError || error instanceof DomainError || error instanceof DuplicateWalletSignal) {
          throw error;
        }
        const info = classifyDbError(error);
        if (info.kind === 'integrity_trigger') {
          this.logger.error({ ...errorFields(error), label: options.label }, 'database integrity trigger fired');
          throw new IntegrityViolationError(error instanceof Error ? error.message : String(error));
        }
        if (!isRetryable(info)) throw error;

        if (info.kind === 'deadlock' || info.kind === 'lock_timeout' || info.kind === 'serialization') {
          this.metrics.lockConflictsTotal.inc({ type: info.kind });
        }
        if (attempt >= maxAttempts) {
          this.logger.warn({ ...errorFields(error), label: options.label, attempt }, 'transaction retries exhausted');
          throw new TransientInfrastructureError(
            `Database operation "${options.label}" failed after ${attempt} attempt(s): ${info.kind}`,
            info.kind,
            error,
          );
        }
        this.metrics.retriesTotal.inc({ component: 'db_transaction', reason: info.kind });
        this.logger.debug(
          { label: options.label, attempt, reason: info.kind, constraint: info.constraint },
          'retrying transaction',
        );
        await sleep(this.backoff.delayAfter(attempt));
      }
    }
  }

  async read<T>(work: (ctx: TransactionContext) => Promise<T>): Promise<T> {
    const em = this.orm.em.fork({ clear: true }) as EntityManager;
    try {
      return await work(createTransactionContext(em));
    } catch (error) {
      if (error instanceof ApplicationError || error instanceof DomainError) throw error;
      const info = classifyDbError(error);
      if (info.kind === 'connection' || info.kind === 'statement_timeout') {
        throw new TransientInfrastructureError(`Database read failed: ${info.kind}`, info.kind, error);
      }
      throw error;
    }
  }
}
