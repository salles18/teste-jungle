import type {
  ErrorResponse,
  LedgerPageResponse,
  ReconciliationResponse,
  WagerTransactionResponse,
  WalletResponse,
} from '../../src/interfaces/http/dto';

/**
 * Typed view of any JSON body returned by the API, built from the production DTOs:
 * a test that asserts on a field the contract does not have fails to compile.
 */
export type ApiBody = Partial<
  WagerTransactionResponse & WalletResponse & LedgerPageResponse & ReconciliationResponse & ErrorResponse
> & {
  /** health endpoints */
  checks?: Record<string, string>;
};
