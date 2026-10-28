/**
 * Classification of PostgreSQL / driver errors. Works on both raw `pg` errors and
 * MikroORM DriverExceptions (which copy `code` and `constraint` from the pg error).
 */
export type DbErrorKind =
  | 'deadlock'
  | 'serialization'
  | 'lock_timeout'
  | 'statement_timeout'
  | 'connection'
  | 'unique_violation'
  | 'integrity_trigger'
  | 'other';

export interface DbErrorInfo {
  kind: DbErrorKind;
  sqlState: string | null;
  constraint: string | null;
}

/** Unique violations that mean "someone else just inserted the same operation": retry and replay. */
export const RETRYABLE_UNIQUE_CONSTRAINTS = new Set([
  'uq_wager_provider_idempotency',
  'uq_wager_provider_external',
  'ux_wager_single_reversal',
  'uq_ledger_wallet_version',
  'uq_inbox_consumer_message',
]);

const CONNECTION_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN']);

export function classifyDbError(error: unknown): DbErrorInfo {
  if (!error || typeof error !== 'object') return { kind: 'other', sqlState: null, constraint: null };
  const e = error as { code?: unknown; constraint?: unknown; name?: unknown; message?: unknown };
  const code = typeof e.code === 'string' ? e.code : null;
  const constraint = typeof e.constraint === 'string' ? e.constraint : null;
  const name = typeof e.name === 'string' ? e.name : '';
  const message = typeof e.message === 'string' ? e.message : '';

  const info = (kind: DbErrorKind): DbErrorInfo => ({ kind, sqlState: code, constraint });

  if (code === '40P01') return info('deadlock');
  if (code === '40001') return info('serialization');
  if (code === '55P03') return info('lock_timeout');
  if (code === '57014') return info('statement_timeout');
  if (code === '23505') return info('unique_violation');
  if (code === 'JW001') return info('integrity_trigger');
  if (code && (code.startsWith('08') || code === '57P01' || code === '57P02' || code === '57P03' || code === '53300')) {
    return info('connection');
  }
  if (code && CONNECTION_CODES.has(code)) return info('connection');
  if (name === 'ConnectionException' || name === 'KnexTimeoutError' || /Timeout acquiring a connection/i.test(message)) {
    return info('connection');
  }
  if (/Connection terminated|connection.*(closed|ended)/i.test(message)) return info('connection');
  return info('other');
}

/**
 * Whether re-running the *whole* unit of work is safe and useful.
 * Safe because every write path is idempotent (re-checks under the wallet lock).
 */
export function isRetryable(info: DbErrorInfo): boolean {
  switch (info.kind) {
    case 'deadlock':
    case 'serialization':
    case 'lock_timeout':
    case 'connection':
      return true;
    case 'unique_violation':
      return info.constraint !== null && RETRYABLE_UNIQUE_CONSTRAINTS.has(info.constraint);
    default:
      return false;
  }
}
