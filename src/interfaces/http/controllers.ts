import {
  Body,
  Controller,
  DefaultValuePipe,
  Get,
  Headers,
  HttpCode,
  Inject,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import {
  ApiBody,
  ApiConflictResponse,
  ApiHeader,
  ApiNotFoundResponse,
  ApiOperation,
  ApiQuery,
  ApiResponse,
  ApiTags,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { CommandValidationError } from '../../application/errors';
import { ProcessWagerTransactionUseCase, type WagerResult } from '../../application/wagering/process-wager-transaction';
import { WalletUseCases } from '../../application/wallet/wallet-use-cases';
import { TransactionStatus } from '../../domain/wagering/wager-types';
import { currentLogContext } from '../../observability/logger';
import { validateIdempotencyKey, validateWagerContract, WagerTransactionContract } from '../contracts/wager-transaction.contract';
import {
  CreateWalletDto,
  ErrorResponse,
  LedgerEntryResponse,
  LedgerPageResponse,
  ReconciliationResponse,
  WagerTransactionResponse,
  WalletResponse,
} from './dto';

const UUID_PIPE = new ParseUUIDPipe({ version: undefined });

@ApiTags('wallets')
@Controller('wallets')
export class WalletsController {
  constructor(@Inject(WalletUseCases) private readonly wallets: WalletUseCases) {}

  @Post()
  @HttpCode(201)
  @ApiOperation({ summary: 'Create a wallet (positive initial balance => OPENING + CREDIT in the same SQL transaction)' })
  @ApiResponse({ status: 201, type: WalletResponse })
  @ApiResponse({ status: 400, type: ErrorResponse })
  @ApiConflictResponse({ description: 'WALLET_ALREADY_EXISTS (same player + currency)', type: ErrorResponse })
  @ApiUnprocessableEntityResponse({ description: 'CURRENCY_NOT_SUPPORTED', type: ErrorResponse })
  async create(@Body() body: CreateWalletDto): Promise<WalletResponse> {
    const wallet = await this.wallets.create(body, currentLogContext().correlationId ?? null);
    return WalletResponse.from(wallet);
  }

  @Get(':walletId')
  @ApiResponse({ status: 200, type: WalletResponse })
  @ApiNotFoundResponse({ type: ErrorResponse })
  async get(@Param('walletId', UUID_PIPE) walletId: string): Promise<WalletResponse> {
    return WalletResponse.from(await this.wallets.get(walletId));
  }

  @Get(':walletId/ledger')
  @ApiOperation({ summary: 'Ledger entries, newest first, keyset pagination with an opaque cursor' })
  @ApiQuery({ name: 'cursor', required: false })
  @ApiQuery({ name: 'limit', required: false, schema: { default: 50, minimum: 1, maximum: 200 } })
  @ApiResponse({ status: 200, type: LedgerPageResponse })
  async ledger(
    @Param('walletId', UUID_PIPE) walletId: string,
    @Query('cursor') cursor: string | undefined,
    @Query('limit', new DefaultValuePipe(50), ParseIntPipe) limit: number,
  ): Promise<LedgerPageResponse> {
    if (limit < 1 || limit > 200) throw new CommandValidationError('limit must be between 1 and 200');
    const page = await this.wallets.ledger(walletId, cursor || undefined, limit);
    return { walletId, entries: page.entries.map(LedgerEntryResponse.from), nextCursor: page.nextCursor };
  }

  @Post(':walletId/reconciliation')
  @HttpCode(200)
  @ApiOperation({ summary: 'Compare materialised balance with ledger-reconstructed balance (never corrects)' })
  @ApiResponse({ status: 200, type: ReconciliationResponse })
  async reconcile(@Param('walletId', UUID_PIPE) walletId: string): Promise<ReconciliationResponse> {
    return this.wallets.reconcile(walletId);
  }
}

function statusFor(result: WagerResult): number {
  switch (result.transaction.status) {
    case TransactionStatus.PROCESSED:
      return result.idempotentReplay ? 200 : 201;
    case TransactionStatus.PENDING_REFERENCE:
    case TransactionStatus.PENDING:
      return 202;
    default:
      return 422;
  }
}

@ApiTags('wagering')
@Controller()
export class WageringController {
  constructor(@Inject(ProcessWagerTransactionUseCase) private readonly wagers: ProcessWagerTransactionUseCase) {}

  @Post('wagering/transactions')
  @ApiOperation({ summary: 'Submit BET / WIN / LOSS / REFUND / ROLLBACK' })
  @ApiHeader({ name: 'Idempotency-Key', required: true, description: 'Scope: providerId. 8-128 chars [A-Za-z0-9._:-]' })
  @ApiHeader({ name: 'X-Correlation-Id', required: false })
  @ApiBody({ type: WagerTransactionContract })
  @ApiResponse({ status: 201, type: WagerTransactionResponse, description: 'Created and PROCESSED' })
  @ApiResponse({ status: 200, type: WagerTransactionResponse, description: 'Idempotent replay of a PROCESSED operation' })
  @ApiResponse({ status: 202, type: WagerTransactionResponse, description: 'Accepted, PENDING_REFERENCE' })
  @ApiResponse({ status: 400, type: ErrorResponse, description: 'VALIDATION_FAILED (body or Idempotency-Key)' })
  @ApiResponse({ status: 404, type: ErrorResponse, description: 'WALLET_NOT_FOUND' })
  @ApiResponse({ status: 409, type: ErrorResponse, description: 'IDEMPOTENCY_KEY_REUSED / EXTERNAL_TRANSACTION_CONFLICT' })
  @ApiResponse({
    status: 422,
    description:
      'Business rejection: body is the REJECTED transaction (failureCode) — or an ErrorResponse for PLAYER_WALLET_MISMATCH / CURRENCY_*',
  })
  @ApiResponse({ status: 503, type: ErrorResponse, description: 'Transient failure — retry with the same key' })
  async submit(
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ): Promise<WagerTransactionResponse> {
    const key = validateIdempotencyKey(idempotencyKey);
    if (!key.ok) throw new CommandValidationError('Invalid Idempotency-Key', key.violations);
    const contract = validateWagerContract(body);
    if (!contract.ok) throw new CommandValidationError('Invalid wager transaction', contract.violations);

    const result = await this.wagers.execute(contract.value, {
      idempotencyKey: key.value,
      correlationId: currentLogContext().correlationId ?? null,
      causationId: key.value,
      channel: 'http',
    });
    res.status(statusFor(result));
    res.setHeader('Idempotent-Replay', String(result.idempotentReplay));
    return WagerTransactionResponse.from(result.transaction, result.idempotentReplay);
  }

  @Get('wagering/transactions/:transactionId')
  @ApiResponse({ status: 200, type: WagerTransactionResponse })
  @ApiNotFoundResponse({ type: ErrorResponse })
  async byId(@Param('transactionId', UUID_PIPE) transactionId: string): Promise<WagerTransactionResponse> {
    return WagerTransactionResponse.from(await this.wagers.getById(transactionId), false);
  }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  @ApiResponse({ status: 200, type: WagerTransactionResponse })
  @ApiNotFoundResponse({ type: ErrorResponse })
  async byExternalId(
    @Param('providerId') providerId: string,
    @Param('externalTransactionId') externalTransactionId: string,
  ): Promise<WagerTransactionResponse> {
    return WagerTransactionResponse.from(await this.wagers.getByExternalId(providerId, externalTransactionId), false);
  }
}
