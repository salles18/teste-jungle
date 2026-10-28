import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, Matches } from 'class-validator';
import type { WagerTransaction } from '../../domain/wagering/wager-transaction';
import { ALL_FAILURE_CODES, TransactionKind, TransactionStatus } from '../../domain/wagering/wager-types';
import type { Wallet } from '../../domain/wallet/wallet';
import type { WalletLedgerEntry } from '../../domain/wallet/wallet-ledger-entry';
import { AMOUNT, CURRENCY, EXTERNAL_ID } from '../contracts/wager-transaction.contract';

export class CreateWalletDto {
  @ApiProperty({ example: 'player-42', pattern: EXTERNAL_ID.source })
  @IsString()
  @Matches(EXTERNAL_ID)
  playerId!: string;

  @ApiProperty({ example: 'BRL' })
  @IsString()
  @Matches(CURRENCY)
  currency!: string;

  @ApiProperty({ example: '100.00', description: 'Non-negative, exactly two decimals. "0.00" creates no ledger entry.' })
  @IsString()
  @Matches(AMOUNT, { message: 'initialBalance must be a decimal string with exactly two decimals, e.g. "100.00"' })
  initialBalance!: string;
}

export class MoneyDto {
  @ApiProperty({ example: '20.00' }) amount!: string;
  @ApiProperty({ example: 'BRL' }) currency!: string;
}

export class WalletResponse {
  @ApiProperty({ format: 'uuid' }) walletId!: string;
  @ApiProperty() playerId!: string;
  @ApiProperty({ example: 'BRL' }) currency!: string;
  @ApiProperty({ example: '100.00' }) balance!: string;
  @ApiProperty({ example: 1 }) version!: number;
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;

  static from(w: Wallet): WalletResponse {
    return {
      walletId: w.id,
      playerId: w.playerId,
      currency: w.currency.code,
      balance: w.balance.amount,
      version: w.version,
      createdAt: w.createdAt.toISOString(),
      updatedAt: w.updatedAt.toISOString(),
    };
  }
}

export class LedgerEntryResponse {
  @ApiProperty({ format: 'uuid' }) entryId!: string;
  @ApiProperty({ format: 'uuid' }) transactionId!: string;
  @ApiProperty({ enum: ['DEBIT', 'CREDIT'] }) direction!: string;
  @ApiProperty({ example: '80.00' }) amount!: string;
  @ApiProperty({ example: 'BRL' }) currency!: string;
  @ApiProperty({ example: '100.00' }) balanceBefore!: string;
  @ApiProperty({ example: '20.00' }) balanceAfter!: string;
  @ApiProperty({ description: 'Wallet version produced by this entry (total order per wallet)' }) walletVersion!: number;
  @ApiProperty() createdAt!: string;

  static from(e: WalletLedgerEntry): LedgerEntryResponse {
    return {
      entryId: e.id,
      transactionId: e.transactionId,
      direction: e.direction,
      amount: e.amount.amount,
      currency: e.amount.currency.code,
      balanceBefore: e.balanceBefore.amount,
      balanceAfter: e.balanceAfter.amount,
      walletVersion: e.walletVersion,
      createdAt: e.createdAt.toISOString(),
    };
  }
}

export class LedgerPageResponse {
  @ApiProperty({ format: 'uuid' }) walletId!: string;
  @ApiProperty({ type: [LedgerEntryResponse] }) entries!: LedgerEntryResponse[];
  @ApiPropertyOptional({ nullable: true, description: 'Opaque cursor for the next (older) page' })
  nextCursor!: string | null;
}

export class WagerTransactionResponse {
  @ApiProperty({ format: 'uuid' }) transactionId!: string;
  @ApiProperty() providerId!: string;
  @ApiProperty() externalTransactionId!: string;
  @ApiProperty({ format: 'uuid' }) walletId!: string;
  @ApiProperty() playerId!: string;
  @ApiPropertyOptional({ nullable: true }) roundId!: string | null;
  @ApiPropertyOptional({ nullable: true }) gameId!: string | null;
  @ApiProperty({ enum: Object.values(TransactionKind) }) kind!: string;
  @ApiProperty({ example: '80.00' }) amount!: string;
  @ApiProperty({ example: 'BRL' }) currency!: string;
  @ApiPropertyOptional({ nullable: true }) referenceExternalTransactionId!: string | null;
  @ApiProperty({ enum: Object.values(TransactionStatus) }) status!: string;
  @ApiPropertyOptional({ enum: ALL_FAILURE_CODES, nullable: true }) failureCode!: string | null;
  @ApiPropertyOptional({
    nullable: true,
    example: '20.00',
    description: 'Balance observed when the transaction completed (snapshot, not the current balance)',
  })
  balanceAfter!: string | null;
  @ApiPropertyOptional({ nullable: true }) walletVersion!: number | null;
  @ApiProperty() referenceAttempts!: number;
  @ApiPropertyOptional({ nullable: true }) nextReferenceCheckAt!: string | null;
  @ApiPropertyOptional({ nullable: true }) processedAt!: string | null;
  @ApiProperty() createdAt!: string;
  @ApiProperty({ description: 'true when this response replays an operation that already existed' })
  idempotentReplay!: boolean;

  static from(t: WagerTransaction, idempotentReplay: boolean): WagerTransactionResponse {
    return {
      transactionId: t.id,
      providerId: t.providerId,
      externalTransactionId: t.externalTransactionId,
      walletId: t.walletId,
      playerId: t.playerId,
      roundId: t.roundId,
      gameId: t.gameId,
      kind: t.kind,
      amount: t.money.amount,
      currency: t.money.currency.code,
      referenceExternalTransactionId: t.referenceExternalTransactionId,
      status: t.status,
      failureCode: t.failureCode,
      balanceAfter: t.resultBalance?.amount ?? null,
      walletVersion: t.resultWalletVersion,
      referenceAttempts: t.referenceAttempts,
      nextReferenceCheckAt: t.nextReferenceCheckAt?.toISOString() ?? null,
      processedAt: t.processedAt?.toISOString() ?? null,
      createdAt: t.createdAt.toISOString(),
      idempotentReplay,
    };
  }
}

export class ReconciliationResponse {
  @ApiProperty({ format: 'uuid' }) walletId!: string;
  @ApiProperty() currency!: string;
  @ApiProperty({ example: '20.00' }) materializedBalance!: string;
  @ApiProperty({ example: '20.00' }) ledgerBalance!: string;
  @ApiProperty({ example: '0.00', description: 'materializedBalance - ledgerBalance' }) difference!: string;
  @ApiProperty() consistent!: boolean;
  @ApiProperty() checkedEntries!: number;
  @ApiProperty() walletVersion!: number;
  @ApiPropertyOptional({ nullable: true }) lastLedgerVersion!: number | null;
  @ApiProperty() checkedAt!: string;
}

export class ErrorBody {
  @ApiProperty({ example: 'IDEMPOTENCY_KEY_REUSED' }) code!: string;
  @ApiProperty() message!: string;
  @ApiPropertyOptional({ type: Object }) details?: Record<string, unknown>;
}

export class ErrorResponse {
  @ApiProperty({ type: ErrorBody }) error!: ErrorBody;
  @ApiPropertyOptional({ nullable: true }) correlationId!: string | null;
}
