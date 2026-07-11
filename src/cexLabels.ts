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

  // Retries across the whole key pool on a 429/network error before recording
  // a failure - same fix parseSwapTx already got. Without this, a single
  // exhausted key (very common - only 1 of 4 keys is currently under quota)
  // immediately counts as a failure against the *shared* enhancedApiBreaker,
  // which also gates parseSwapTx. Tripping it here silently stalls swap
  // parsing too, so no notifications fire at all - not just missing labels.
  let lastStatus: number | null = null;
  for (let i = 0; i < ENRICHMENT_KEYS.length; i++) {
    const key = nextKey();
    let res: Response;
    try {
      await acquireRateLimitToken();
      res = await fetch(
        `https://api.helius.xyz/v1/wallet/${address}/identity?api-key=${key}`,
      );
    } catch {
      continue; // network error on this key - try next key before giving up
    }

    if (res.status === 404) {
      enhancedApiBreaker.recordSuccess();
      cache.set(address, { label: null, expires: Date.now() + TTL_MS });
      return { label: null, resolved: true };
    }
    if (res.status === 429) {
      lastStatus = 429;
      continue; // this key is rate limited - try next key
    }
    if (!res.ok) {
      lastStatus = res.status;
      continue;
    }

    enhancedApiBreaker.recordSuccess();
    const data: any = await res.json();
    const category: string | undefined = data?.category;
    const name: string | undefined = data?.name;
    const isCex = category?.toLowerCase().includes('cex') || category?.toLowerCase().includes('exchange');
    const label = isCex ? (name ?? category ?? 'CEX') : null;

    cache.set(address, { label, expires: Date.now() + TTL_MS });
    return { label, resolved: true };
  }

  // every key failed for this address - only NOW does it count against the
  // shared breaker, same threshold semantics as parseSwapTx/rpcCall.
  enhancedApiBreaker.recordFailure();
  return { label: null, resolved: false }; // don't cache - transient (rate limit / network), not a confirmed negative
}