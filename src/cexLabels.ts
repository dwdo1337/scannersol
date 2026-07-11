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

// Static fallback table: addresses independently confirmed via a live
// Helius identity lookup (not just taken on faith from the supplied list).
// Checked first, before cache/API - zero quota cost, zero latency, and
// immune to the key-exhaustion issue entirely for these addresses.
//
// Excluded from the originally supplied 23-address list:
// - 8 came back "unknown" to Helius (unverifiable, not necessarily wrong,
//   just not confirmable right now): 9WzDXwBbmkg8ZTbNMqUxvQRAyrZDsGYdLVL9zYtAWWM,
//   13VagdYbCRMSBSbmz4UivPpS9SwmTTRiPtMkjoEHRm8v, MTCEM5YJJSYGW2RCXYXGE4SXLSPUUEJKQAWG2GUX6CNN
//   (also all-uppercase, which real base58 addresses essentially never are by
//   chance), enC1zkqfU5X4x84LMKSzcRdsSSiF7M1Nt7ovm62jRXr7, 16ZL8yLyXv3V3L3z9ofR1ovFLziyXaN1DPq4yffMAZ9c,
//   1743nDTMZisPgBCYSAgkUn1kVG7MePc9rvMEjoRNf4ip, 1P6bgxZi42kYYV545c3RSp7NJLUgASDpMP1ifXJazVR1,
//   1qnJN7FViy3HZaxZK9tGAA71zxHSBeUweirKqCaox4t8.
// - DRpbCBMxVnDK7maPM5tGv6MvB3v1sRMC86PZ8okm21hy resolves to a Binance
//   *staking validator identity*, not an exchange deposit wallet - wrong
//   category for funding-source detection, would misclassify validator
//   activity as a CEX cash-out.
// - H8sMJSCQxfKiFTCfDR3DUMLPwcRbM61LGFJ8N4dK3WjS was supplied labeled
//   "Kraken Hot Wallet" but Helius confidently resolves it to "Coinbase Hot
//   Wallet 12" - trusting Helius's named, live result over the unlabeled
//   source list here.
const STATIC_CEX_WALLETS: Record<string, string> = {
  '5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9': 'Binance',
  'Amf2mf2Ciap5wYAEKDtGoQHfHPWaKbyFYhutMK46hTRF': 'Binance',
  '2ojv9BAiHUrvsm9gxDe7fJSzbNZSJcxZvf8dqmWGHG8S': 'Binance',
  'G9RCBaYb8aBRxoe8QBC2ucGrVqjuZFysRhY8d56cnNT1': 'Binance',
  'HXsKP7wrBWaQ8T2Vtjry3Nj3oUgwYcqq9vrHDM12G664': 'Binance',
  'Edbef6Xi35u6iYEmeGAFmThCZrgj6MxzYAgAmZFYPmFF': 'Binance',
  '3gd3dqgtJ4jWfBfLYTX67DALFetjc5iS72sCgRhCkW2u': 'Binance',
  '3yFwqXBfZY4jBVUafQ1YEXw189y2dN3V5KQq9uzBDy1E': 'Binance',
  '6QJzieMYfp7yr3EdrePaQoG3Ghxs2wM98xSLRu8Xh56U': 'Binance',
  'GBrURzmtWujJRTA3Bkvo7ZgWuZYLMMwPCwre7BejJXnK': 'Binance',
  '6oCa9Tz8VXVp63WiFyruE5PD6yXz3pCsv6oGzUGvg9TP': 'Binance',
  'GK35nWN6ZHSGZrRTf8kTQd8RkFCighChPEb41XwSFVAC': 'Binance',
  '2AQdpHJ2JpcEgPiATUXjQxA8QmafFegfQwSLWSprPicm': 'Coinbase',
  'H8sMJSCQxfKiFTCfDR3DUMLPwcRbM61LGFJ8N4dK3WjS': 'Coinbase',
};
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
  const staticLabel = STATIC_CEX_WALLETS[address];
  if (staticLabel) return { label: staticLabel, resolved: true };

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