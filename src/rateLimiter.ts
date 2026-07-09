// Simple token-bucket rate limiter shared across all Helius callers
// (rpcCall, parseSwapTx, cexLabels) so we self-throttle instead of bursting
// past Helius's own rate limits and generating 429s under heavy chain-wide
// swap volume. This runs in-process; it's deliberately conservative since
// 4 keys share one underlying account tier in practice.
const MAX_TOKENS = 8; // burst allowance
const REFILL_PER_SEC = 8; // steady-state requests/sec across the whole pool

let tokens = MAX_TOKENS;
let lastRefill = Date.now();

function refill() {
  const now = Date.now();
  const elapsedSec = (now - lastRefill) / 1000;
  if (elapsedSec <= 0) return;
  tokens = Math.min(MAX_TOKENS, tokens + elapsedSec * REFILL_PER_SEC);
  lastRefill = now;
}

/**
 * Resolves once a token is available. Waits (does not throw) - callers that
 * need to bail out fast during a known-bad network period should check
 * isCircuitOpen() themselves first, before calling this.
 */
export async function acquireRateLimitToken(): Promise<void> {
  for (;;) {
    refill();
    if (tokens >= 1) {
      tokens -= 1;
      return;
    }
    const deficit = 1 - tokens;
    const waitMs = Math.ceil((deficit / REFILL_PER_SEC) * 1000);
    await new Promise((r) => setTimeout(r, Math.max(waitMs, 10)));
  }
}
