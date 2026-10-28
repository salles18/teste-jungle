import { createHash } from 'node:crypto';

export type CanonicalValue = null | boolean | string | number | CanonicalValue[] | { [key: string]: CanonicalValue };

/**
 * Deterministic JSON: object keys sorted recursively (by UTF-16 code unit, like
 * Array.prototype.sort), no whitespace, strings NFC-normalised, `undefined` members
 * dropped. Non-integer numbers are refused — money never travels as a number.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalise(value));
}

function normalise(value: unknown): CanonicalValue {
  if (value === null) return null;
  switch (typeof value) {
    case 'string':
      return value.normalize('NFC');
    case 'boolean':
      return value;
    case 'number':
      if (!Number.isSafeInteger(value)) {
        throw new TypeError(`canonicalJson only accepts safe integers, got ${value}`);
      }
      return value;
    case 'object': {
      if (Array.isArray(value)) return value.map((v) => (v === undefined ? null : normalise(v)));
      const out: Record<string, CanonicalValue> = {};
      for (const key of Object.keys(value as object).sort()) {
        const member = (value as Record<string, unknown>)[key];
        if (member !== undefined) out[key.normalize('NFC')] = normalise(member);
      }
      return out;
    }
    default:
      throw new TypeError(`canonicalJson cannot encode ${typeof value}`);
  }
}

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/** Business fields that define a wager operation. Transport metadata never enters the hash. */
export interface WagerBusinessFields {
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: string;
  /** Already normalised to exactly two decimals by Money. */
  amount: string;
  currency: string;
  referenceExternalTransactionId: string | null;
}

export function wagerPayloadHash(fields: WagerBusinessFields): string {
  const canonical: Record<string, CanonicalValue> = {
    amount: fields.amount,
    currency: fields.currency,
    externalTransactionId: fields.externalTransactionId,
    gameId: fields.gameId,
    kind: fields.kind,
    playerId: fields.playerId,
    providerId: fields.providerId,
    referenceExternalTransactionId: fields.referenceExternalTransactionId,
    roundId: fields.roundId,
    walletId: fields.walletId,
  };
  return sha256Hex(canonicalJson(canonical));
}
