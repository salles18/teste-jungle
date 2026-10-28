import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { plainToInstance } from 'class-transformer';
import { IsIn, IsOptional, IsString, IsUUID, Matches, ValidateIf, validateSync } from 'class-validator';
import type { WagerCommand } from '../../application/wagering/process-wager-transaction';
import { SUBMITTABLE_KINDS, type SubmittableKind } from '../../domain/wagering/wager-types';

/** Identifiers from providers: printable, no spaces, bounded. */
export const EXTERNAL_ID = /^[A-Za-z0-9._:@-]{1,128}$/;
export const PROVIDER_ID = /^[A-Za-z0-9._-]{1,64}$/;
/** Exactly two decimals, no sign, no exponent, no leading zeros, <= 18 integer digits. */
export const AMOUNT = /^(0|[1-9]\d{0,17})\.\d{2}$/;
export const CURRENCY = /^[A-Z]{3}$/;
export const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{8,128}$/;

/**
 * Wire contract of a wager instruction — identical for POST /wagering/transactions
 * and for the `transaction` field of a wager-transactions.fifo message.
 */
export class WagerTransactionContract {
  @ApiProperty({ example: 'pragmatic', pattern: PROVIDER_ID.source })
  @IsString()
  @Matches(PROVIDER_ID)
  providerId!: string;

  @ApiProperty({ example: 'bet-000123', pattern: EXTERNAL_ID.source })
  @IsString()
  @Matches(EXTERNAL_ID)
  externalTransactionId!: string;

  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  walletId!: string;

  @ApiProperty({ example: 'player-42', pattern: EXTERNAL_ID.source })
  @IsString()
  @Matches(EXTERNAL_ID)
  playerId!: string;

  @ApiProperty({ example: 'round-9' })
  @IsString()
  @Matches(EXTERNAL_ID)
  roundId!: string;

  @ApiProperty({ example: 'sweet-bonanza' })
  @IsString()
  @Matches(EXTERNAL_ID)
  gameId!: string;

  @ApiProperty({ enum: SUBMITTABLE_KINDS, description: 'OPENING is internal and rejected here' })
  @IsIn(SUBMITTABLE_KINDS as unknown as string[])
  kind!: SubmittableKind;

  @ApiProperty({ example: '80.00', description: 'Decimal string with exactly two decimals', pattern: AMOUNT.source })
  @IsString()
  @Matches(AMOUNT, { message: 'amount must be a decimal string with exactly two decimals, e.g. "80.00"' })
  amount!: string;

  @ApiProperty({ example: 'BRL', pattern: CURRENCY.source })
  @IsString()
  @Matches(CURRENCY)
  currency!: string;

  @ApiPropertyOptional({
    example: 'bet-000123',
    nullable: true,
    description: 'Required for REFUND/ROLLBACK; optional for WIN/LOSS (must point to a BET)',
  })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @Matches(EXTERNAL_ID)
  referenceExternalTransactionId?: string | null;
}

export type ValidationOutcome<T> = { ok: true; value: T } | { ok: false; violations: string[] };

export function validateWagerContract(raw: unknown): ValidationOutcome<WagerCommand> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, violations: ['body must be a JSON object'] };
  }
  const instance = plainToInstance(WagerTransactionContract, raw);
  const errors = validateSync(instance, { whitelist: true, forbidNonWhitelisted: true, forbidUnknownValues: true });
  if (errors.length > 0) {
    return {
      ok: false,
      violations: errors.flatMap((e) => Object.values(e.constraints ?? { [e.property]: `${e.property} is invalid` })),
    };
  }
  const kind = instance.kind;
  const reference = instance.referenceExternalTransactionId ?? null;
  if ((kind === 'REFUND' || kind === 'ROLLBACK') && reference === null) {
    return { ok: false, violations: [`referenceExternalTransactionId is required for ${kind}`] };
  }
  if (kind === 'BET' && reference !== null) {
    return { ok: false, violations: ['BET cannot reference another transaction'] };
  }
  if (reference !== null && reference === instance.externalTransactionId) {
    return { ok: false, violations: ['a transaction cannot reference itself'] };
  }
  return {
    ok: true,
    value: {
      providerId: instance.providerId,
      externalTransactionId: instance.externalTransactionId,
      walletId: instance.walletId.toLowerCase(),
      playerId: instance.playerId,
      roundId: instance.roundId,
      gameId: instance.gameId,
      kind,
      amount: instance.amount,
      currency: instance.currency,
      referenceExternalTransactionId: reference,
    },
  };
}

export function validateIdempotencyKey(value: unknown): ValidationOutcome<string> {
  if (typeof value !== 'string' || value.length === 0) {
    return { ok: false, violations: ['Idempotency-Key header is required'] };
  }
  if (!IDEMPOTENCY_KEY.test(value)) {
    return { ok: false, violations: ['Idempotency-Key must be 8-128 chars of [A-Za-z0-9._:-]'] };
  }
  return { ok: true, value };
}
