/** UUID generation through the Web Crypto API (available in Bun and Node 19+). */
export function newId(): string {
  return crypto.randomUUID();
}
