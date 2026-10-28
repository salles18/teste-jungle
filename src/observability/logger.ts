import { AsyncLocalStorage } from 'node:async_hooks';
import pino, { type Logger as PinoLogger } from 'pino';

/** Identifiers attached to every log line emitted within a request / message / job. */
export interface LogContext {
  correlationId?: string;
  messageId?: string;
  transactionId?: string;
  walletId?: string;
  providerId?: string;
}

const storage = new AsyncLocalStorage<LogContext>();

export function withLogContext<T>(context: LogContext, fn: () => T): T {
  const parent = storage.getStore() ?? {};
  return storage.run({ ...parent, ...context }, fn);
}

/** Adds fields to the current context (e.g. once the transaction id is known). */
export function enrichLogContext(context: LogContext): void {
  const store = storage.getStore();
  if (store) Object.assign(store, context);
}

export function currentLogContext(): LogContext {
  return storage.getStore() ?? {};
}

export type Logger = PinoLogger;

/**
 * Structured JSON logger. Payloads, amounts in bulk and secrets are never logged by
 * the application; redaction is a second line of defence for headers.
 */
export function createLogger(level: string, base: Record<string, unknown> = {}): Logger {
  return pino({
    level,
    base: { service: 'jungle-wallet', ...base },
    timestamp: pino.stdTimeFunctions.isoTime,
    messageKey: 'message',
    formatters: { level: (label) => ({ level: label }) },
    mixin: () => ({ ...currentLogContext() }),
    redact: {
      paths: ['req.headers.authorization', 'headers.authorization', '*.secretAccessKey', '*.password'],
      censor: '[redacted]',
    },
  });
}

export function errorFields(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    return { errorName: error.name, errorMessage: error.message, ...(code !== undefined ? { errorCode: code } : {}) };
  }
  return { errorMessage: String(error) };
}
