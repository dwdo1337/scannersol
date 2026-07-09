import { ENRICHMENT_KEYS, rpcUrl } from './config.js';
import { acquireRateLimitToken } from './rateLimiter.js';

let cursor = 0;

// --- Circuit breaker (per endpoint group) -----------------------------
// Helius is actually two independent services from our perspective:
//   - mainnet.helius-rpc.com (JSON-RPC, used by rpcCall here)
//   - api.helius.xyz (Enhanced Transactions + wallet identity, used by
//     parseSwapTx and cexLabels)
// We saw these fail independently - api.helius.xyz having a bad patch
// while mainnet.helius-rpc.com worked fine. A single shared breaker meant
// one endpoint being down permanently blocked calls to the other, healthy
// one. Each endpoint group gets its own breaker instance instead.
const TRIP_THRESHOLD = 3;
const COOLDOWN_MS = 20_000;

class Breaker {
  private consecutiveFailures = 0;
  private openUntil = 0;
  constructor(private readonly name: string) {}

  isOpen(): boolean {
    return Date.now() < this.openUntil;
  }

  recordSuccess(): void {
    this.consecutiveFailures = 0;
  }

  recordFailure(): void {
    this.consecutiveFailures++;
    if (this.consecutiveFailures >= TRIP_THRESHOLD && !this.isOpen()) {
      this.openUntil = Date.now() + COOLDOWN_MS;
      console.error(
        `[circuit breaker:${this.name}] tripped after ${this.consecutiveFailures} consecutive failures, ` +
          `pausing for ${COOLDOWN_MS / 1000}s`,
      );
      this.consecutiveFailures = 0;
    }
  }
}

const rpcBreaker = new Breaker('rpc');
export const enhancedApiBreaker = new Breaker('api-helius-xyz');

export function isCircuitOpen(): boolean {
  return rpcBreaker.isOpen();
}

export function recordSuccess(): void {
  rpcBreaker.recordSuccess();
}

export function recordFailure(): void {
  rpcBreaker.recordFailure();
}

/**
 * Calls a Helius JSON-RPC method, rotating through the key pool.
 * On 429 (rate limited) or network error, tries the next key.
 * If every key fails (e.g. a brief Helius/DNS routing blip affecting all
 * keys equally), waits briefly and retries the whole pool once more before
 * giving up - this is what a transient ConnectTimeoutError needs, since
 * key rotation alone can't fix a connectivity outage that isn't key-specific.
 */
export async function rpcCall<T = any>(method: string, params: any[]): Promise<T> {
  if (rpcBreaker.isOpen()) {
    throw new Error('circuit open (rpc): skipping RPC call, endpoint recently unreachable');
  }

  let lastErr: unknown;

  for (let attempt = 0; attempt < 2; attempt++) {
    for (let i = 0; i < ENRICHMENT_KEYS.length; i++) {
      const key = ENRICHMENT_KEYS[(cursor + i) % ENRICHMENT_KEYS.length];
      try {
        await acquireRateLimitToken();
        const res = await fetch(rpcUrl(key), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        });

        if (res.status === 429) {
          lastErr = new Error(`429 rate limited on key ending ...${key.slice(-4)}`);
          continue; // try next key
        }
        if (!res.ok) {
          lastErr = new Error(`HTTP ${res.status} on key ...${key.slice(-4)}`);
          continue;
        }

        const json: any = await res.json();
        if (json.error) {
          lastErr = new Error(json.error.message ?? 'RPC error');
          continue;
        }

        cursor = (cursor + i + 1) % ENRICHMENT_KEYS.length; // advance for next call
        rpcBreaker.recordSuccess();
        return json.result as T;
      } catch (err) {
        lastErr = err;
        continue;
      }
    }

    if (attempt === 0) {
      await new Promise((r) => setTimeout(r, 750)); // brief pause before retrying the whole pool
    }
  }

  rpcBreaker.recordFailure();
  throw new Error(`All Helius keys failed for ${method}: ${lastErr}`);
}
