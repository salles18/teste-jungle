import { Money } from '../money/money';
import { InvariantViolationError } from '../shared/domain-error';
import { newId } from '../shared/ids';
import { LedgerDirection } from '../wagering/wager-types';

export interface WalletLedgerEntryProps {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  amount: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  /** Wallet version produced by this entry. Unique per wallet => total, gap-free order of entries. */
  walletVersion: number;
  createdAt: Date;
}

/**
 * One immutable movement of a wallet balance. The factory refuses any entry whose
 * arithmetic does not close (before ± amount = after). The database repeats the same
 * check and additionally blocks UPDATE/DELETE on the table.
 */
export class WalletLedgerEntry {
  private constructor(private readonly props: Readonly<WalletLedgerEntryProps>) {
    Object.freeze(this);
  }

  static record(input: Omit<WalletLedgerEntryProps, 'id'> & { id?: string }): WalletLedgerEntry {
    const { amount, balanceBefore, balanceAfter } = input;
    if (!amount.isPositive()) {
      throw new InvariantViolationError(`Ledger amount must be positive, got ${amount.toString()}`);
    }
    if (!amount.hasCurrency(balanceBefore.currency) || !amount.hasCurrency(balanceAfter.currency)) {
      throw new InvariantViolationError('Ledger entry mixes currencies');
    }
    const expected = input.direction === LedgerDirection.CREDIT ? balanceBefore.add(amount) : balanceBefore.subtract(amount);
    if (!expected.equals(balanceAfter)) {
      throw new InvariantViolationError(
        `Ledger arithmetic broken: ${balanceBefore.amount} ${input.direction} ${amount.amount} != ${balanceAfter.amount}`,
      );
    }
    if (balanceAfter.isNegative() || balanceBefore.isNegative()) {
      throw new InvariantViolationError('Ledger entry would leave a negative balance');
    }
    if (!Number.isInteger(input.walletVersion) || input.walletVersion < 1) {
      throw new InvariantViolationError('Ledger walletVersion must be an integer >= 1');
    }
    return new WalletLedgerEntry({ ...input, id: input.id ?? newId() });
  }

  /** Rebuilds a persisted entry. Arithmetic is still checked: a stored entry that does not close is corruption. */
  static rehydrate(props: WalletLedgerEntryProps): WalletLedgerEntry {
    return WalletLedgerEntry.record(props);
  }

  get id(): string {
    return this.props.id;
  }
  get walletId(): string {
    return this.props.walletId;
  }
  get transactionId(): string {
    return this.props.transactionId;
  }
  get direction(): LedgerDirection {
    return this.props.direction;
  }
  get amount(): Money {
    return this.props.amount;
  }
  get balanceBefore(): Money {
    return this.props.balanceBefore;
  }
  get balanceAfter(): Money {
    return this.props.balanceAfter;
  }
  get walletVersion(): number {
    return this.props.walletVersion;
  }
  get createdAt(): Date {
    return this.props.createdAt;
  }

  /** Signed effect on the balance: +amount for CREDIT, -amount for DEBIT. */
  signedAmount(): Money {
    return this.direction === LedgerDirection.CREDIT ? this.amount : this.amount.negate();
  }
}
