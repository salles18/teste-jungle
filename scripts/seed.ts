import { WalletAlreadyExistsError } from '../src/application/errors';
import { createContainer } from '../src/bootstrap/container';
import { loadConfig } from '../src/config/app-config';

/** Deterministic demo data: three wallets. Safe to run repeatedly. */
const c = await createContainer({ ...loadConfig(), logLevel: 'warn' });
try {
  for (const [playerId, initialBalance] of [
    ['demo-player-1', '100.00'],
    ['demo-player-2', '250.50'],
    ['demo-player-3', '0.00'],
  ] as const) {
    try {
      const w = await c.wallets.create({ playerId, currency: 'BRL', initialBalance }, 'seed');
      console.log(`created ${playerId}: walletId=${w.id} balance=${w.balance.amount}`);
    } catch (error) {
      if (!(error instanceof WalletAlreadyExistsError)) throw error;
      console.log(`exists  ${playerId}: walletId=${String(error.details.existingWalletId)}`);
    }
  }
} finally {
  await c.close();
}
