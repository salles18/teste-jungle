import { describe, expect, test } from 'bun:test';
import { InvariantViolationError } from '../../src/domain/shared/domain-error';
import type { WalletRecord } from '../../src/infrastructure/database/entities';
import { walletFromRecord } from '../../src/infrastructure/database/mappers';

const record = (balance: unknown): WalletRecord =>
  ({
    id: '00000000-0000-4000-8000-000000000001',
    playerId: 'p1',
    currency: 'BRL',
    balance,
    version: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
  }) as WalletRecord;

describe('persistence mappers (money)', () => {
  test('NUMERIC strings are parsed exactly, including the largest NUMERIC(20,2) value', () => {
    expect(walletFromRecord(record('999999999999999999.99')).balance.amount).toBe('999999999999999999.99');
    expect(walletFromRecord(record('20.00')).balance.amount).toBe('20.00');
  });

  test('a NUMERIC delivered as a JS number is rejected, not stringified', () => {
    expect(() => walletFromRecord(record(20))).toThrow(InvariantViolationError);
    expect(() => walletFromRecord(record(0.1 + 0.2))).toThrow(InvariantViolationError);
  });
});
