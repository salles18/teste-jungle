/**
 * Decides at module load whether SQS-backed tests run, so that unavailable
 * scenarios are reported as SKIPPED by the runner instead of silently passing.
 * REQUIRE_SQS=1 turns an unreachable endpoint into a hard failure.
 */
export async function sqsReachable(endpoint: string, timeoutMs = 2000): Promise<boolean> {
  try {
    const res = await fetch(endpoint, { signal: AbortSignal.timeout(timeoutMs) });
    await res.arrayBuffer();
    return true;
  } catch {
    if (process.env.REQUIRE_SQS === '1') throw new Error(`REQUIRE_SQS=1 but ${endpoint} is unreachable`);
    console.warn(`\n⚠️  SQS endpoint ${endpoint} unreachable — SQS scenarios SKIPPED (docker compose up -d localstack)\n`);
    return false;
  }
}
