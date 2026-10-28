import type { CommandMetadata, WagerCommand } from '../../src/application/wagering/process-wager-transaction';
import type { Container } from '../../src/bootstrap/container';
import type { SubmittableKind } from '../../src/domain/wagering/wager-types';

let seq = 0;
export const uniq = (prefix: string): string => `${prefix}-${Date.now().toString(36)}-${(seq++).toString(36)}`;

export async function openWallet(c: Container, initialBalance = '100.00', playerId = uniq('player')) {
  return c.wallets.create({ playerId, currency: 'BRL', initialBalance }, null);
}

export function wager(
  wallet: { id: string; playerId: string },
  kind: SubmittableKind,
  amount: string,
  extra: Partial<WagerCommand> = {},
): WagerCommand {
  return {
    providerId: 'prov-a',
    externalTransactionId: uniq(kind.toLowerCase()),
    walletId: wallet.id,
    playerId: wallet.playerId,
    roundId: 'round-1',
    gameId: 'game-1',
    kind,
    amount,
    currency: 'BRL',
    referenceExternalTransactionId: null,
    ...extra,
  };
}

export function meta(idempotencyKey = uniq('idem'), channel: CommandMetadata['channel'] = 'http'): CommandMetadata {
  return { idempotencyKey, correlationId: 'test-correlation', causationId: idempotencyKey, channel };
}

/**
 * Awaits a promise that must reject and returns the error.
 * (Bun 1.3.1's `expect(p).rejects` hangs with some Error subclasses, so tests use this.)
 */
export async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected promise to reject, but it resolved');
}
