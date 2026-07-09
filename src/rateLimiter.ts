// Simple token-bucket rate limiter shared across all Helius callers
// (rpcCall, parseSwapTx, cexLabels) so we self-throttle instead of bursting
// past Helius's own rate limits and generating 429s under heavy chain-wide
// swap volume. This runs in-process.
//
// Was hardcoded to 8 req/sec TOTAL regardless of key count - this was the
// real bottleneck once extraction started working: with ~3900 swaps/min
// candidates and only 8 rps of enrichment budget, well over 90% got
// dropped by the concurrency cap before ever reaching a freshness check,
// even though plenty of Helius quota was sitting unused across the other
// 3 keys. Helius's free/dev tier is roughly ~10 req/sec PER KEY, so the
// budget should scale with ENRICHMENT_KEYS.length, not be a flat constant.
import { ENRICHMENT_KEYS } from './config.js';

const PER_KEY_RPS = 8; // conservative vs Helius's ~10 rps/key free-tier limit
const MAX_TOKENS = PER_KEY_RPS * ENRICHMENT_KEYS.length; // burst allowance
const REFILL_PER_SEC = PER_KEY_RPS * ENRICHMENT_KEYS.length; // steady-state, whole pool

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
