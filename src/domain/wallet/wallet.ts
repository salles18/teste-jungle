import { Currency } from '../money/currency';
import { Money } from '../money/money';
import { InsufficientFundsError, InvalidValueError, InvariantViolationError } from '../shared/domain-error';
import { newId } from '../shared/ids';
import { LedgerDirection } from '../wagering/wager-types';
import { WalletLedgerEntry } from './wallet-ledger-entry';

export interface WalletProps {
  id: string;
  playerId: string;
  currency: Currency;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface OpenWalletInput {
  id?: string;
  playerId: string;
  currency: string;
  initialBalance: Money;
  /** Id of the internal OPENING transaction; required when initialBalance > 0. */
  openingTransactionId?: string;
  now: Date;
}

export interface OpenedWallet {
  wallet: Wallet;
  /** CREDIT entry for the opening balance, null when the wallet opens at zero. */
  openingEntry: WalletLedgerEntry | null;
}

const PLAYER_ID = /^[A-Za-z0-9._:@-]{1,128}$/;

/**
 * Aggregate root for a player's balance in one currency.
 *
 * Invariants: balance never negative; version starts at 1 and increments by exactly
 * one whenever (and only when) the balance changes; every balance change yields
 * exactly one ledger entry carrying the new version.
 */
export class Wallet {
  private props: WalletProps;
  /** Version as loaded from storage — used as the optimistic guard on update. */
  private readonly persistedVersion: number;

  private constructor(props: WalletProps, persistedVersion: number) {
    this.props = props;
    this.persistedVersion = persistedVersion;
  }

  static open(input: OpenWalletInput): OpenedWallet {
    if (!PLAYER_ID.test(input.playerId)) {
      throw new InvalidValueError('playerId must be 1-128 chars of [A-Za-z0-9._:@-]');
    }
    const currency = Currency.of(input.currency);
    if (!input.initialBalance.hasCurrency(currency)) {
      throw new InvalidValueError('initialBalance currency differs from wallet currency');
    }
    if (input.initialBalance.isNegative()) {
      throw new InvalidValueError('initialBalance must not be negative');
    }
    const id = input.id ?? newId();
    const wallet = new Wallet(
      {
        id,
        playerId: input.playerId,
        currency,
        balance: input.initialBalance,
        version: 1,
        createdAt: input.now,
        updatedAt: input.now,
      },
      0,
    );
    let openingEntry: WalletLedgerEntry | null = null;
    if (input.initialBalance.isPositive()) {
      if (!input.openingTransactionId) {
        throw new InvariantViolationError('A positive opening balance requires an OPENING transaction');
      }
      openingEntry = WalletLedgerEntry.record({
        walletId: id,
        transactionId: input.openingTransactionId,
        direction: LedgerDirection.CREDIT,
        amount: input.initialBalance,
        balanceBefore: Money.zero(currency),
        balanceAfter: input.initialBalance,
        walletVersion: 1,
        createdAt: input.now,
      });
    }
    return { wallet, openingEntry };
  }

  /** Rebuilds persisted state as-is. Only structural invariants are checked. */
  static rehydrate(props: WalletProps): Wallet {
    if (props.balance.isNegative()) throw new InvariantViolationError(`Wallet ${props.id} persisted with negative balance`);
    if (!props.balance.hasCurrency(props.currency)) throw new InvariantViolationError('Wallet balance currency mismatch');
    if (!Number.isInteger(props.version) || props.version < 1) throw new InvariantViolationError('Wallet version < 1');
    return new Wallet({ ...props }, props.version);
  }

  get id(): string {
    return this.props.id;
  }
  get playerId(): string {
    return this.props.playerId;
  }
  get currency(): Currency {
    return this.props.currency;
  }
  get balance(): Money {
    return this.props.balance;
  }
  get version(): number {
    return this.props.version;
  }
  get createdAt(): Date {
    return this.props.createdAt;
  }
  get updatedAt(): Date {
    return this.props.updatedAt;
  }
  /** Version the row had when loaded; the repository updates WHERE version = expectedVersion. */
  get expectedVersion(): number {
    return this.persistedVersion;
  }
  get hasChanges(): boolean {
    return this.props.version !== this.persistedVersion;
  }

  canDebit(amount: Money): boolean {
    return this.props.balance.isGreaterThanOrEqual(amount);
  }

  credit(amount: Money, transactionId: string, now: Date): WalletLedgerEntry {
    return this.apply(LedgerDirection.CREDIT, amount, transactionId, now);
  }

  debit(amount: Money, transactionId: string, now: Date): WalletLedgerEntry {
    if (!this.canDebit(amount)) {
      throw new InsufficientFundsError(this.id, this.balance.amount, amount.amount);
    }
    return this.apply(LedgerDirection.DEBIT, amount, transactionId, now);
  }

  apply(direction: LedgerDirection, amount: Money, transactionId: string, now: Date): WalletLedgerEntry {
    if (!amount.hasCurrency(this.currency)) {
      throw new InvalidValueError(`Wallet ${this.id} is ${this.currency.code}, got ${amount.currency.code}`);
    }
    if (!amount.isPositive()) {
      throw new InvariantViolationError('Wallet movements must be strictly positive');
    }
    const before = this.props.balance;
    const after = direction === LedgerDirection.CREDIT ? before.add(amount) : before.subtract(amount);
    if (after.isNegative()) {
      throw new InsufficientFundsError(this.id, before.amount, amount.amount);
    }
    const nextVersion = this.props.version + 1;
    const entry = WalletLedgerEntry.record({
      walletId: this.id,
      transactionId,
      direction,
      amount,
      balanceBefore: before,
      balanceAfter: after,
      walletVersion: nextVersion,
      createdAt: now,
    });
    this.props = { ...this.props, balance: after, version: nextVersion, updatedAt: now };
    return entry;
  }
}
