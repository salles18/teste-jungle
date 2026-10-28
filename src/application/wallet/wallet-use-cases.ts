import { WalletBalanceChanged } from '../../domain/events/wallet-events';
import { OutboxMessage } from '../../domain/messaging/outbox-message';
import { Money } from '../../domain/money/money';
import { DomainError } from '../../domain/shared/domain-error';
import { newId } from '../../domain/shared/ids';
import { WagerTransaction } from '../../domain/wagering/wager-transaction';
import { Wallet } from '../../domain/wallet/wallet';
import type { WalletLedgerEntry } from '../../domain/wallet/wallet-ledger-entry';
import type { Logger } from '../../observability/logger';
import type { Metrics } from '../../observability/metrics';
import { CommandRejectedError, CommandValidationError, WalletAlreadyExistsError, WalletNotFoundError } from '../errors';
import type { Clock, UnitOfWork } from '../ports/persistence';
import { canonicalJson, sha256Hex } from '../wagering/payload-hash';
import { decodeLedgerCursor, encodeLedgerCursor } from './ledger-cursor';

export interface CreateWalletCommand {
  playerId: string;
  currency: string;
  initialBalance: string;
}

export interface LedgerPage {
  entries: WalletLedgerEntry[];
  nextCursor: string | null;
}

export interface ReconciliationReport {
  walletId: string;
  currency: string;
  materializedBalance: string;
  ledgerBalance: string;
  difference: string;
  consistent: boolean;
  checkedEntries: number;
  walletVersion: number;
  lastLedgerVersion: number | null;
  checkedAt: string;
}

/** Thrown by repositories when the unique (player_id, currency) constraint fires. */
export class DuplicateWalletSignal extends Error {}

export class WalletUseCases {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly metrics: Metrics,
    private readonly logger: Logger,
    private readonly supportedCurrencies: readonly string[],
  ) {}

  /**
   * Creates the wallet and — when the initial balance is positive — the internal OPENING
   * transaction, its CREDIT ledger entry and a WalletBalanceChanged event, in one SQL
   * transaction. A zero initial balance creates no ledger entry (nothing moved).
   */
  async create(command: CreateWalletCommand, correlationId: string | null): Promise<Wallet> {
    if (!this.supportedCurrencies.includes(command.currency)) {
      throw new CommandRejectedError('CURRENCY_NOT_SUPPORTED', `Currency ${command.currency} is not enabled`);
    }
    let initialBalance: Money;
    try {
      initialBalance = Money.of(command.initialBalance, command.currency);
    } catch (error) {
      if (error instanceof DomainError) throw new CommandValidationError(error.message, [error.message]);
      throw error;
    }

    try {
      return await this.uow.run(
        async (ctx) => {
          const existing = await ctx.wallets.findByPlayerAndCurrency(command.playerId, command.currency);
          if (existing) throw new WalletAlreadyExistsError(command.playerId, command.currency, existing.id);

          const now = await ctx.databaseNow();
          const walletId = newId();
          const openingTransactionId = newId();
          let opened: ReturnType<typeof Wallet.open>;
          try {
            opened = Wallet.open({
              id: walletId,
              playerId: command.playerId,
              currency: command.currency,
              initialBalance,
              openingTransactionId,
              now,
            });
          } catch (error) {
            if (error instanceof DomainError) throw new CommandValidationError(error.message, [error.message]);
            throw error;
          }
          const { wallet, openingEntry } = opened;
          await ctx.wallets.insert(wallet);

          if (openingEntry) {
            const opening = WagerTransaction.opening({
              id: openingTransactionId,
              walletId,
              playerId: wallet.playerId,
              money: initialBalance,
              payloadHash: sha256Hex(
                canonicalJson({
                  walletId,
                  playerId: wallet.playerId,
                  amount: initialBalance.amount,
                  currency: wallet.currency.code,
                }),
              ),
              correlationId,
              now,
            });
            await ctx.transactions.insert(opening);
            await ctx.ledger.append(openingEntry);
            await ctx.outbox.enqueue([
              OutboxMessage.fromEvent(
                WalletBalanceChanged.from(wallet, openingEntry, { correlationId, causationId: opening.id, occurredAt: now }),
                now,
              ),
            ]);
          }
          this.logger.info({ walletId, currency: wallet.currency.code }, 'wallet created');
          return wallet;
        },
        { label: 'wallet.create' },
      );
    } catch (error) {
      if (error instanceof DuplicateWalletSignal) {
        throw new WalletAlreadyExistsError(command.playerId, command.currency, null);
      }
      throw error;
    }
  }

  async get(walletId: string): Promise<Wallet> {
    const wallet = await this.uow.read((ctx) => ctx.wallets.findById(walletId));
    if (!wallet) throw new WalletNotFoundError(walletId);
    return wallet;
  }

  async ledger(walletId: string, cursor: string | undefined, limit: number): Promise<LedgerPage> {
    const beforeVersion = cursor ? decodeLedgerCursor(cursor, walletId) : null;
    return this.uow.read(async (ctx) => {
      const wallet = await ctx.wallets.findById(walletId);
      if (!wallet) throw new WalletNotFoundError(walletId);
      // fetch one extra row to know whether another page exists
      const rows = await ctx.ledger.listByWallet(walletId, { beforeVersion, limit: limit + 1 });
      const entries = rows.slice(0, limit);
      const last = entries.at(-1);
      const nextCursor = rows.length > limit && last ? encodeLedgerCursor(walletId, last.walletVersion) : null;
      return { entries, nextCursor };
    });
  }

  /**
   * Compares the materialised balance with the ledger-reconstructed balance in one
   * REPEATABLE READ snapshot. Never corrects anything: divergence is logged and counted.
   */
  async reconcile(walletId: string): Promise<ReconciliationReport> {
    const report = await this.uow.run(
      async (ctx) => {
        const wallet = await ctx.wallets.findById(walletId);
        if (!wallet) throw new WalletNotFoundError(walletId);
        const summary = await ctx.ledger.summarize(walletId, wallet.currency.code);
        const difference = wallet.balance.subtract(summary.balance);
        // balance must match, and the newest entry must carry the wallet's current version
        // (a wallet without entries has never moved: version 1).
        const versionsAgree =
          summary.lastWalletVersion === null ? wallet.version === 1 : summary.lastWalletVersion === wallet.version;
        const consistent = difference.isZero() && versionsAgree;
        return {
          walletId,
          currency: wallet.currency.code,
          materializedBalance: wallet.balance.amount,
          ledgerBalance: summary.balance.amount,
          difference: difference.amount,
          consistent,
          checkedEntries: summary.entries,
          walletVersion: wallet.version,
          lastLedgerVersion: summary.lastWalletVersion,
          checkedAt: this.clock.now().toISOString(),
        } satisfies ReconciliationReport;
      },
      { label: 'wallet.reconcile', isolation: 'REPEATABLE READ', readOnly: true },
    );
    if (!report.consistent) {
      this.metrics.reconciliationMismatchTotal.inc();
      this.logger.error(
        { walletId, difference: report.difference, checkedEntries: report.checkedEntries },
        'wallet reconciliation mismatch',
      );
    } else {
      this.logger.info({ walletId, checkedEntries: report.checkedEntries }, 'wallet reconciliation ok');
    }
    return report;
  }
}
