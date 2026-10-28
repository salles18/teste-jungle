import type { EventMetadata } from '../../domain/events/integration-event';
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from '../../domain/events/wallet-events';
import { OutboxMessage } from '../../domain/messaging/outbox-message';
import { Money } from '../../domain/money/money';
import { DomainError } from '../../domain/shared/domain-error';
import { type ReferenceWaitPolicy, type SettlementOutcome, settleWagerTransaction } from '../../domain/wagering/wager-settlement';
import { WagerTransaction } from '../../domain/wagering/wager-transaction';
import { type SubmittableKind, TransactionStatus } from '../../domain/wagering/wager-types';
import type { Wallet } from '../../domain/wallet/wallet';
import { enrichLogContext, type Logger } from '../../observability/logger';
import type { Metrics } from '../../observability/metrics';
import {
  CommandRejectedError,
  CommandValidationError,
  IdempotencyConflictError,
  TransactionNotFoundError,
  WalletNotFoundError,
} from '../errors';
import type { TransactionContext, UnitOfWork } from '../ports/persistence';
import { wagerPayloadHash } from './payload-hash';

/** Business fields of a provider instruction. Identical for HTTP and SQS. */
export interface WagerCommand {
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: SubmittableKind;
  amount: string;
  currency: string;
  referenceExternalTransactionId: string | null;
}

export type Channel = 'http' | 'sqs' | 'worker';

export interface CommandMetadata {
  idempotencyKey: string;
  correlationId: string | null;
  /** What caused this command (HTTP: idempotency key; SQS: broker message id). */
  causationId: string | null;
  channel: Channel;
}

export interface WagerResult {
  transaction: WagerTransaction;
  idempotentReplay: boolean;
}

interface PreparedCommand {
  command: WagerCommand;
  meta: CommandMetadata;
  money: Money;
  payloadHash: string;
}

export interface ProcessWagerOptions {
  waitPolicy: ReferenceWaitPolicy;
  supportedCurrencies: readonly string[];
}

/**
 * The single financial use case. Concurrency model:
 *
 *  1. (optional fast path, no locks) a committed transaction with this key is replayed.
 *  2. BEGIN; SELECT wallet FOR UPDATE — serialises *everything* that touches this wallet.
 *  3. Re-check idempotency under the lock (READ COMMITTED: the statement sees rows
 *     committed by whoever held the lock before us).
 *  4. Resolve reference (same wallet => protected by the same lock), apply domain rules.
 *  5. Insert transaction, ledger entry, update wallet (version-guarded) and enqueue
 *     outbox events. COMMIT. Deferred DB triggers re-verify ledger/balance coherence.
 *
 * Unique violations on (provider, idempotency_key) / (provider, external_id) can only
 * happen when two requests with the same key target *different* wallets (different
 * locks). The unit of work retries, and step 1/3 then reports the conflict.
 */
export class ProcessWagerTransactionUseCase {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly metrics: Metrics,
    private readonly logger: Logger,
    private readonly options: ProcessWagerOptions,
  ) {}

  /** Own SQL transaction (HTTP path). */
  async execute(command: WagerCommand, meta: CommandMetadata): Promise<WagerResult> {
    const started = performance.now();
    const prepared = this.prepare(command, meta);
    let outcome = 'error';
    try {
      const committed = await this.uow.read((ctx) => this.findExisting(ctx, prepared));
      const result = committed
        ? this.replay(committed, prepared)
        : await this.uow.run((ctx) => this.executeWithin(ctx, prepared), { label: 'wager.process' });
      outcome = result.idempotentReplay ? 'replay' : result.transaction.status;
      this.record(result, meta.channel);
      return result;
    } catch (error) {
      outcome = error instanceof Error ? error.name : 'error';
      throw error;
    } finally {
      this.metrics.processingLatency.observe({ channel: meta.channel, outcome }, (performance.now() - started) / 1000);
    }
  }

  /** Runs inside a caller-owned SQL transaction (SQS consumer: inbox + financial effects atomically). */
  async executeInTransaction(ctx: TransactionContext, command: WagerCommand, meta: CommandMetadata): Promise<WagerResult> {
    return this.executeWithin(ctx, this.prepare(command, meta));
  }

  /** Call after the owning SQL transaction committed, so outcomes are counted once. */
  record(result: WagerResult, channel: Channel): void {
    if (result.idempotentReplay) {
      this.metrics.duplicatesTotal.inc({ type: 'idempotent_replay', channel });
      return;
    }
    this.metrics.transactionsTotal.inc({ kind: result.transaction.kind, status: result.transaction.status, channel });
  }

  async getById(transactionId: string): Promise<WagerTransaction> {
    const tx = await this.uow.read((ctx) => ctx.transactions.findById(transactionId));
    if (!tx) throw new TransactionNotFoundError({ transactionId });
    return tx;
  }

  async getByExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction> {
    const tx = await this.uow.read((ctx) => ctx.transactions.findByExternalId(providerId, externalTransactionId));
    if (!tx) throw new TransactionNotFoundError({ providerId, externalTransactionId });
    return tx;
  }

  // ---------------------------------------------------------------------------

  private prepare(command: WagerCommand, meta: CommandMetadata): PreparedCommand {
    if (!this.options.supportedCurrencies.includes(command.currency)) {
      throw new CommandRejectedError('CURRENCY_NOT_SUPPORTED', `Currency ${command.currency} is not enabled`, {
        currency: command.currency,
      });
    }
    let money: Money;
    try {
      money = Money.of(command.amount, command.currency);
    } catch (error) {
      if (error instanceof DomainError) throw new CommandValidationError(error.message, [error.message]);
      throw error;
    }
    const payloadHash = wagerPayloadHash({ ...command, amount: money.amount });
    return { command, meta, money, payloadHash };
  }

  private async executeWithin(ctx: TransactionContext, prepared: PreparedCommand): Promise<WagerResult> {
    const { command, meta, money } = prepared;
    enrichLogContext({ walletId: command.walletId, providerId: command.providerId });

    const wallet = await ctx.wallets.findByIdForUpdate(command.walletId);
    if (!wallet) throw new WalletNotFoundError(command.walletId);
    // read after the lock wait, so the instant reflects when the decision is made
    const now = await ctx.databaseNow();

    const existing = await this.findExisting(ctx, prepared);
    if (existing) return this.replay(existing, prepared);

    if (wallet.playerId !== command.playerId) {
      throw new CommandRejectedError('PLAYER_WALLET_MISMATCH', 'Wallet does not belong to playerId', {
        walletId: wallet.id,
      });
    }
    if (!money.hasCurrency(wallet.currency)) {
      throw new CommandRejectedError('CURRENCY_MISMATCH', `Wallet currency is ${wallet.currency.code}`, {
        walletId: wallet.id,
        walletCurrency: wallet.currency.code,
      });
    }

    let tx: WagerTransaction;
    try {
      tx = WagerTransaction.create({
        providerId: command.providerId,
        externalTransactionId: command.externalTransactionId,
        idempotencyKey: meta.idempotencyKey,
        payloadHash: prepared.payloadHash,
        walletId: wallet.id,
        playerId: command.playerId,
        roundId: command.roundId,
        gameId: command.gameId,
        kind: command.kind,
        money,
        referenceExternalTransactionId: command.referenceExternalTransactionId,
        correlationId: meta.correlationId,
        now,
      });
    } catch (error) {
      if (error instanceof DomainError) throw new CommandValidationError(error.message, [error.message]);
      throw error;
    }
    enrichLogContext({ transactionId: tx.id });

    const outcome = await this.settle(ctx, tx, wallet, now);
    await ctx.transactions.insert(tx);
    await this.persistOutcome(ctx, tx, wallet, outcome, meta, now);

    this.logger.info(
      { kind: tx.kind, status: tx.status, failureCode: tx.failureCode, channel: meta.channel },
      'wager transaction settled',
    );
    return { transaction: tx, idempotentReplay: false };
  }

  /**
   * Applies the rules to a transaction whose wallet is locked by the caller.
   * Shared with the pending-reference worker. `now` must come from ctx.databaseNow().
   */
  async settle(ctx: TransactionContext, tx: WagerTransaction, wallet: Wallet, now: Date): Promise<SettlementOutcome> {
    const reference = tx.referenceExternalTransactionId
      ? await ctx.transactions.findByExternalId(tx.providerId, tx.referenceExternalTransactionId)
      : null;
    const referenceAlreadyReversed =
      reference !== null && tx.isReversal() ? await ctx.transactions.hasProcessedReversal(reference.id) : false;
    return settleWagerTransaction({
      transaction: tx,
      wallet,
      reference,
      referenceAlreadyReversed,
      waitPolicy: this.options.waitPolicy,
      now,
    });
  }

  /**
   * Writes everything that must commit together with the transaction row:
   * ledger entry, wallet, outbox events and dependent wake-ups.
   * Order matters for the DB triggers: transaction row -> ledger -> wallet.
   */
  async persistOutcome(
    ctx: TransactionContext,
    tx: WagerTransaction,
    wallet: Wallet,
    outcome: SettlementOutcome,
    meta: Pick<CommandMetadata, 'correlationId' | 'causationId'>,
    now: Date,
  ): Promise<void> {
    const eventMeta: EventMetadata = { correlationId: meta.correlationId, causationId: meta.causationId, occurredAt: now };
    const events: OutboxMessage[] = [];

    switch (outcome.status) {
      case TransactionStatus.PROCESSED: {
        if (outcome.ledgerEntry) {
          await ctx.ledger.append(outcome.ledgerEntry);
          await ctx.wallets.save(wallet);
          events.push(OutboxMessage.fromEvent(WalletBalanceChanged.from(wallet, outcome.ledgerEntry, eventMeta), now));
        }
        events.push(OutboxMessage.fromEvent(WagerTransactionProcessed.from(tx, eventMeta), now));
        await ctx.transactions.wakePendingDependents({
          providerId: tx.providerId,
          walletId: tx.walletId,
          externalTransactionId: tx.externalTransactionId,
          now,
        });
        break;
      }
      case TransactionStatus.REJECTED:
        events.push(OutboxMessage.fromEvent(WagerTransactionRejected.from(tx, eventMeta), now));
        break;
      case TransactionStatus.PENDING_REFERENCE:
        // announce only when the transaction starts waiting, not on every re-check
        if (tx.referenceAttempts === 1) {
          events.push(OutboxMessage.fromEvent(WagerTransactionPendingReference.from(tx, eventMeta), now));
        }
        break;
    }
    await ctx.outbox.enqueue(events);
  }

  /**
   * The two lookups are separate statements. On the lock-free fast path the original
   * request can commit *between* them: the key lookup misses, the external-id lookup
   * hits a row that carries this very key. That row is the same operation (replay,
   * still hash-checked by the caller), not a conflict.
   */
  private async findExisting(ctx: TransactionContext, prepared: PreparedCommand): Promise<WagerTransaction | null> {
    const { command, meta } = prepared;
    const byKey = await ctx.transactions.findByIdempotencyKey(command.providerId, meta.idempotencyKey);
    if (byKey) return byKey;
    const byExternalId = await ctx.transactions.findByExternalId(command.providerId, command.externalTransactionId);
    if (byExternalId && byExternalId.idempotencyKey === meta.idempotencyKey) return byExternalId;
    if (byExternalId) {
      this.metrics.duplicatesTotal.inc({ type: 'external_id_conflict', channel: meta.channel });
      throw new IdempotencyConflictError(
        'EXTERNAL_TRANSACTION_CONFLICT',
        `externalTransactionId ${command.externalTransactionId} was already submitted with another Idempotency-Key`,
        byExternalId.id,
      );
    }
    return null;
  }

  private replay(existing: WagerTransaction, prepared: PreparedCommand): WagerResult {
    if (!existing.matchesPayload(prepared.payloadHash)) {
      this.metrics.duplicatesTotal.inc({ type: 'idempotency_key_conflict', channel: prepared.meta.channel });
      throw new IdempotencyConflictError(
        'IDEMPOTENCY_KEY_REUSED',
        'Idempotency-Key was already used with a different payload',
        existing.id,
      );
    }
    enrichLogContext({ transactionId: existing.id });
    return { transaction: existing, idempotentReplay: true };
  }
}
