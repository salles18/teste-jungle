import { Counter, Gauge, Histogram, Registry } from 'prom-client';

/**
 * All service metrics on an isolated registry (one per Metrics instance) so tests
 * can assert on values without global state.
 */
export class Metrics {
  readonly registry = new Registry();

  readonly transactionsTotal = new Counter({
    name: 'wallet_wager_transactions_total',
    help: 'Wager transactions by outcome',
    labelNames: ['kind', 'status', 'channel'] as const,
    registers: [this.registry],
  });

  readonly duplicatesTotal = new Counter({
    name: 'wallet_duplicates_detected_total',
    help: 'Duplicates detected: idempotent replays, idempotency conflicts, inbox redeliveries',
    labelNames: ['type', 'channel'] as const,
    registers: [this.registry],
  });

  readonly retriesTotal = new Counter({
    name: 'wallet_retries_total',
    help: 'Retries performed by component and reason',
    labelNames: ['component', 'reason'] as const,
    registers: [this.registry],
  });

  readonly lockConflictsTotal = new Counter({
    name: 'wallet_lock_conflicts_total',
    help: 'Deadlocks, lock timeouts and serialization failures seen by the database layer',
    labelNames: ['type'] as const,
    registers: [this.registry],
  });

  readonly dlqMessagesTotal = new Counter({
    name: 'wallet_dlq_messages_total',
    help: 'Messages forwarded to the dead-letter queue',
    labelNames: ['reason'] as const,
    registers: [this.registry],
  });

  readonly outboxPublishedTotal = new Counter({
    name: 'wallet_outbox_published_total',
    help: 'Outbox messages published',
    labelNames: ['event_type'] as const,
    registers: [this.registry],
  });

  readonly outboxFailuresTotal = new Counter({
    name: 'wallet_outbox_failures_total',
    help: 'Outbox publication failures (dead = gave up)',
    labelNames: ['outcome'] as const,
    registers: [this.registry],
  });

  readonly outboxLagSeconds = new Gauge({
    name: 'wallet_outbox_lag_seconds',
    help: 'Age of the oldest PENDING outbox message',
    registers: [this.registry],
  });

  readonly outboxPending = new Gauge({
    name: 'wallet_outbox_pending_messages',
    help: 'Number of PENDING outbox messages',
    registers: [this.registry],
  });

  readonly pendingReferenceTransactions = new Gauge({
    name: 'wallet_pending_reference_transactions',
    help: 'Transactions waiting for their reference (PENDING_REFERENCE)',
    registers: [this.registry],
  });

  readonly reconciliationMismatchTotal = new Counter({
    name: 'wallet_reconciliation_mismatch_total',
    help: 'Reconciliations where materialised balance != ledger balance',
    registers: [this.registry],
  });

  readonly processingLatency = new Histogram({
    name: 'wallet_processing_latency_seconds',
    help: 'Latency of financial processing by channel',
    labelNames: ['channel', 'outcome'] as const,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [this.registry],
  });

  async valueOf(name: string, labels: Record<string, string> = {}): Promise<number> {
    const metric = await this.registry.getSingleMetric(name)?.get();
    if (!metric) return 0;
    return metric.values
      .filter((v) => Object.entries(labels).every(([k, val]) => String(v.labels[k]) === val))
      .reduce((sum, v) => sum + v.value, 0);
  }
}
