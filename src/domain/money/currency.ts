import { InvalidValueError } from '../shared/domain-error';

/**
 * ISO-4217 currencies the domain understands. Only currencies with exactly two
 * minor units are listed, because the persisted scale is NUMERIC(20,2) and the
 * wire format is a string with exactly two decimals. Currencies with 0 or 3 minor
 * units (JPY, KWD...) would need a per-currency scale and are intentionally absent.
 *
 * Which of these are *enabled* for the running application is configuration
 * (SUPPORTED_CURRENCIES), not domain knowledge.
 */
const ISO_4217_TWO_DECIMAL = new Set([
  'BRL',
  'USD',
  'EUR',
  'GBP',
  'CAD',
  'AUD',
  'NZD',
  'CHF',
  'MXN',
  'ARS',
  'COP',
  'PEN',
  'UYU',
  'SEK',
  'NOK',
  'DKK',
  'PLN',
  'CZK',
  'ZAR',
  'INR',
  'CNY',
  'HKD',
  'SGD',
]);

export class Currency {
  static readonly MINOR_UNITS = 2;

  private constructor(readonly code: string) {}

  static of(code: string): Currency {
    if (typeof code !== 'string' || !/^[A-Z]{3}$/.test(code)) {
      throw new InvalidValueError(`Currency must be a 3-letter upper-case ISO-4217 code, got "${String(code)}"`);
    }
    if (!ISO_4217_TWO_DECIMAL.has(code)) {
      throw new InvalidValueError(`Currency ${code} is not supported by the domain`);
    }
    return new Currency(code);
  }

  static isKnown(code: string): boolean {
    return ISO_4217_TWO_DECIMAL.has(code);
  }

  equals(other: Currency): boolean {
    return this.code === other.code;
  }

  toString(): string {
    return this.code;
  }
}
