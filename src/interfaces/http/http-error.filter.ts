import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException, HttpStatus } from '@nestjs/common';
import type { Request, Response } from 'express';
import {
  ApplicationError,
  CommandRejectedError,
  CommandValidationError,
  IdempotencyConflictError,
  IntegrityViolationError,
  TransactionNotFoundError,
  TransientInfrastructureError,
  WalletAlreadyExistsError,
  WalletNotFoundError,
} from '../../application/errors';
import { DomainError, InvalidValueError } from '../../domain/shared/domain-error';
import { classifyDbError } from '../../infrastructure/database/pg-errors';
import { currentLogContext, errorFields, type Logger } from '../../observability/logger';

/**
 * Error -> HTTP contract:
 *   400 VALIDATION_FAILED                      malformed body / header / cursor
 *   404 WALLET_NOT_FOUND / TRANSACTION_NOT_FOUND
 *   409 IDEMPOTENCY_KEY_REUSED / EXTERNAL_TRANSACTION_CONFLICT / WALLET_ALREADY_EXISTS
 *   422 PLAYER_WALLET_MISMATCH / CURRENCY_MISMATCH / CURRENCY_NOT_SUPPORTED
 *       (a REJECTED wager is also 422, but returned by the controller with the transaction body)
 *   503 TRANSIENT_INFRASTRUCTURE_FAILURE       retry later (Retry-After header)
 *   500 INTEGRITY_VIOLATION / INTERNAL_ERROR   bugs only
 */
@Catch()
export class HttpErrorFilter implements ExceptionFilter {
  constructor(private readonly logger: Logger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request>();
    const { status, code, message, details } = this.map(exception);

    if (status >= 500) {
      this.logger.error({ ...errorFields(exception), status, path: req.path, method: req.method }, 'request failed');
    } else {
      this.logger.info({ status, code, path: req.path, method: req.method }, 'request rejected');
    }
    if (status === HttpStatus.SERVICE_UNAVAILABLE) res.setHeader('Retry-After', '1');
    res.status(status).json({
      error: { code, message, ...(details ? { details } : {}) },
      correlationId: currentLogContext().correlationId ?? null,
    });
  }

  private map(e: unknown): { status: number; code: string; message: string; details?: Record<string, unknown> } {
    if (e instanceof CommandValidationError) {
      return { status: 400, code: e.code, message: e.message, details: { violations: e.violations } };
    }
    if (e instanceof WalletNotFoundError || e instanceof TransactionNotFoundError) {
      return { status: 404, code: e.code, message: e.message, details: e.details };
    }
    if (e instanceof IdempotencyConflictError || e instanceof WalletAlreadyExistsError) {
      return { status: 409, code: e.code, message: e.message, details: e.details };
    }
    if (e instanceof CommandRejectedError) {
      return { status: 422, code: e.code, message: e.message, details: e.details };
    }
    if (e instanceof TransientInfrastructureError) {
      return { status: 503, code: e.code, message: 'Temporary failure, retry with the same Idempotency-Key' };
    }
    if (e instanceof IntegrityViolationError) {
      return { status: 500, code: e.code, message: 'Integrity violation' };
    }
    if (e instanceof ApplicationError) {
      return { status: 422, code: e.code, message: e.message, details: e.details };
    }
    if (e instanceof InvalidValueError) {
      return { status: 400, code: 'VALIDATION_FAILED', message: e.message };
    }
    if (e instanceof DomainError) {
      return { status: 500, code: e.code, message: 'Internal error' };
    }
    if (e instanceof HttpException) {
      const status = e.getStatus();
      const response = e.getResponse();
      const violations =
        typeof response === 'object' && response !== null && 'message' in response
          ? ([] as string[]).concat((response as { message: string | string[] }).message)
          : [e.message];
      const code = status === 400 ? 'VALIDATION_FAILED' : status === 404 ? 'NOT_FOUND' : `HTTP_${status}`;
      return { status, code, message: status === 400 ? 'Invalid request' : e.message, details: { violations } };
    }
    const db = classifyDbError(e);
    if (db.kind === 'connection' || db.kind === 'statement_timeout' || db.kind === 'lock_timeout') {
      return { status: 503, code: 'TRANSIENT_INFRASTRUCTURE_FAILURE', message: 'Temporary failure, retry later' };
    }
    return { status: 500, code: 'INTERNAL_ERROR', message: 'Internal error' };
  }
}
