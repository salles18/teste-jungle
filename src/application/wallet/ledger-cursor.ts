import { CommandValidationError } from '../errors';

/**
 * Opaque keyset cursor for ledger pagination (newest first).
 *
 * It encodes the wallet id and the wallet_version of the last entry returned.
 * wallet_version is unique per wallet and assigned under the wallet row lock, so it
 * is a total, gap-free order that matches commit order: entries inserted later always
 * get a higher version and appear *before* the cursor, never shifting later pages.
 */
const PREFIX = 'l1';

export function encodeLedgerCursor(walletId: string, walletVersion: number): string {
  return Buffer.from(`${PREFIX}:${walletId}:${walletVersion}`, 'utf8').toString('base64url');
}

export function decodeLedgerCursor(cursor: string, walletId: string): number {
  const invalid = () => new CommandValidationError('Invalid ledger cursor', ['cursor is malformed or belongs to another wallet']);
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(cursor)) throw invalid();
  const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  const [prefix, cursorWallet, version, ...rest] = decoded.split(':');
  if (prefix !== PREFIX || cursorWallet !== walletId || rest.length > 0 || !version || !/^[1-9]\d{0,9}$/.test(version)) {
    throw invalid();
  }
  return Number.parseInt(version, 10);
}
