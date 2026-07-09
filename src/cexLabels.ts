import { ENRICHMENT_KEYS } from './config.js';
import { enhancedApiBreaker } from './rpcPool.js';
import { acquireRateLimitToken } from './rateLimiter.js';

// In-memory cache so we don't re-query identity for the same address repeatedly.
// TTL is generous since exchange hot wallet labels rarely change.
const cache = new Map<string, { label: string | null; expires: number }>();
const TTL_MS = 6 * 60 * 60 * 1000; // 6h

export interface CexLookupResult {
  label: string | null;
  resolved: boolean; // false = transient failure (rate limit, network, non-ok), caller should NOT treat as confirmed
}

let cursor = 0;
function nextKey() {
  const key = ENRICHMENT_KEYS[cursor % ENRICHMENT_KEYS.length];
  cursor++;
  return key;
}

/**
 * Looks up whether an address belongs to a known entity (CEX, protocol, etc)
 * via Helius's wallet identity API - a maintained, continuously-updated
 * label database (12,500+ labels as of their docs), rather than a static
 * hardcoded address list that would go stale and can't be verified here.
 * Returns the entity/category name if it's a recognized CEX, else null.
 * Shares api.helius.xyz's circuit breaker and the global rate limiter with
 * parseSwapTx, since they're the same underlying Helius service.
 */
export async function lookupCexLabel(address: string): Promise<CexLookupResult> {
  const hit = cache.get(address);
  if (hit && hit.expires > Date.now()) return { label: hit.label, resolved: true };

  if (enhancedApiBreaker.isOpen()) return { label: null, resolved: false };

  try {
    const key = nextKey();
    await acquireRateLimitToken();
    const res = await fetch(
      `https://api.helius.xyz/v1/wallet/${address}/identity?api-key=${key}`,
    );
    if (res.status === 404) {
      enhancedApiBreaker.recordSuccess();
      cache.set(address, { label: null, expires: Date.now() + TTL_MS });
      return { label: null, resolved: true };
    }
    if (!res.ok) {
      // transient failure (e.g. 429 rate limit) - do NOT cache, do NOT treat as confirmed negative
      enhancedApiBreaker.recordFailure();
      return { label: null, resolved: false };
    }
    enhancedApiBreaker.recordSuccess();

    const data: any = await res.json();
    const category: string | undefined = data?.category;
    const name: string | undefined = data?.name;
    const isCex = category?.toLowerCase().includes('cex') || category?.toLowerCase().includes('exchange');
    const label = isCex ? (name ?? category ?? 'CEX') : null;

    cache.set(address, { label, expires: Date.now() + TTL_MS });
    return { label, resolved: true };
  } catch {
    enhancedApiBreaker.recordFailure();
    return { label: null, resolved: false }; // don't cache network errors
  }
}
