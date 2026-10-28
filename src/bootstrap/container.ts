import type { MikroORM } from '@mikro-orm/postgresql';
import { type Clock, systemClock } from '../application/ports/persistence';
import { ProcessWagerTransactionUseCase } from '../application/wagering/process-wager-transaction';
import { ResolvePendingReferencesUseCase } from '../application/wagering/resolve-pending-references';
import { WalletUseCases } from '../application/wallet/wallet-use-cases';
import type { AppConfig } from '../config/app-config';
import { RetryPolicy } from '../domain/shared/retry-policy';
import { MikroOrmUnitOfWork } from '../infrastructure/database/mikro-orm-unit-of-work';
import { createOrm } from '../infrastructure/database/orm';
import { OutboxStore } from '../infrastructure/outbox/outbox-store';
import { createLogger, type Logger } from '../observability/logger';
import { Metrics } from '../observability/metrics';

/**
 * Plain composition root. NestJS wires these instances as providers; tests and scripts
 * use them directly, so every entry point runs exactly the same code.
 */
export interface Container {
  config: AppConfig;
  orm: MikroORM;
  logger: Logger;
  metrics: Metrics;
  clock: Clock;
  uow: MikroOrmUnitOfWork;
  wallets: WalletUseCases;
  wagers: ProcessWagerTransactionUseCase;
  pendingReferences: ResolvePendingReferencesUseCase;
  outboxStore: OutboxStore;
  close(): Promise<void>;
}

export interface ContainerOverrides {
  clock?: Clock;
  logger?: Logger;
  metrics?: Metrics;
}

export async function createContainer(config: AppConfig, overrides: ContainerOverrides = {}): Promise<Container> {
  const logger = overrides.logger ?? createLogger(config.logLevel, { instanceId: config.instanceId });
  const metrics = overrides.metrics ?? new Metrics();
  const clock = overrides.clock ?? systemClock;
  const orm = await createOrm({ url: config.database.url, poolMax: config.database.poolMax, debug: config.database.debug });

  const uow = new MikroOrmUnitOfWork(
    orm,
    {
      maxAttempts: config.transactionRetry.maxAttempts,
      baseDelayMs: config.transactionRetry.baseDelayMs,
      maxDelayMs: config.transactionRetry.maxDelayMs,
      lockTimeoutMs: config.database.lockTimeoutMs,
      statementTimeoutMs: config.database.statementTimeoutMs,
    },
    metrics,
    logger,
  );

  const pr = config.pendingReference;
  const wagers = new ProcessWagerTransactionUseCase(uow, metrics, logger, {
    supportedCurrencies: config.supportedCurrencies,
    waitPolicy: {
      retry: new RetryPolicy({ maxAttempts: pr.maxAttempts, baseDelayMs: pr.baseDelayMs, maxDelayMs: pr.maxDelayMs }),
      ttlMs: pr.ttlMs,
    },
  });

  return {
    config,
    orm,
    logger,
    metrics,
    clock,
    uow,
    wagers,
    wallets: new WalletUseCases(uow, clock, metrics, logger, config.supportedCurrencies),
    pendingReferences: new ResolvePendingReferencesUseCase(uow, wagers, metrics, logger),
    outboxStore: new OutboxStore(orm, clock),
    close: () => orm.close(true),
  };
}
