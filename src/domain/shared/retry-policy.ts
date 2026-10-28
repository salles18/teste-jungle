import { InvalidValueError } from './domain-error';

export interface RetryPolicyOptions {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  /** 0..1 — fraction of the computed delay that is randomised ("equal jitter"). */
  jitterRatio?: number;
}

/**
 * Exponential backoff with bounded jitter. Pure and deterministic given `random`,
 * which keeps it unit-testable. Attempt numbers are 1-based: attempt 1 is the first try.
 */
export class RetryPolicy {
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  readonly jitterRatio: number;

  constructor(
    options: RetryPolicyOptions,
    private readonly random: () => number = Math.random,
  ) {
    if (!Number.isInteger(options.maxAttempts) || options.maxAttempts < 1) {
      throw new InvalidValueError('maxAttempts must be an integer >= 1');
    }
    if (options.baseDelayMs < 0 || options.maxDelayMs < options.baseDelayMs) {
      throw new InvalidValueError('delays must satisfy 0 <= baseDelayMs <= maxDelayMs');
    }
    const jitter = options.jitterRatio ?? 0.5;
    if (jitter < 0 || jitter > 1) throw new InvalidValueError('jitterRatio must be within [0, 1]');
    this.maxAttempts = options.maxAttempts;
    this.baseDelayMs = options.baseDelayMs;
    this.maxDelayMs = options.maxDelayMs;
    this.jitterRatio = jitter;
  }

  /** True once `attemptsMade` attempts have consumed the whole budget. */
  isExhausted(attemptsMade: number): boolean {
    return attemptsMade >= this.maxAttempts;
  }

  /** Delay to wait after the given (1-based) failed attempt. */
  delayAfter(attempt: number): number {
    const exp = Math.min(this.maxDelayMs, this.baseDelayMs * 2 ** Math.max(0, attempt - 1));
    const jitterSpan = exp * this.jitterRatio;
    return Math.round(exp - jitterSpan + this.random() * jitterSpan);
  }

  nextAttemptAt(attempt: number, now: Date): Date {
    return new Date(now.getTime() + this.delayAfter(attempt));
  }
}
