import { ENRICHMENT_KEYS } from './config.js';
import { enhancedApiBreaker } from './rpcPool.js';
import { acquireRateLimitToken } from './rateLimiter.js';

export interface ParsedSwap {
  signature: string;
  buyer: string;        // wallet that signed the swap (fee payer)
  mint: string | null;  // token mint received (the "buy" side)
  solIn: number;         // SOL spent (native, in SOL not lamports)
  tokensOut: number;     // amount of `mint` received
  timestamp: number | null;
}

let cursor = 0;

// Runs on every incoming signature from the feed, which can be many per
// second on a busy market. Uses api.helius.xyz (Enhanced Transactions API) -
// a different endpoint from rpcCall's mainnet.helius-rpc.com, with its own
// circuit breaker since the two have failed independently in practice.
//
// Retries across the whole key pool on a 429, same as rpcCall - this used
// to try exactly one key and give up, so under real chain-wide swap volume
// (which genuinely rate-limits individual keys - confirmed directly: 3/6
// rapid calls on one key came back 429) it was tripping the breaker
// constantly even though the endpoint itself was healthy the whole time.
export async function parseSwapTx(signature: string): Promise<ParsedSwap | null> {
  if (enhancedApiBreaker.isOpen()) return null;

  let lastStatus: number | null = null;

  for (let i = 0; i < ENRICHMENT_KEYS.length; i++) {
    const key = ENRICHMENT_KEYS[(cursor + i) % ENRICHMENT_KEYS.length];

    let res: Response;
    try {
      await acquireRateLimitToken();
      res = await fetch(`https://api.helius.xyz/v0/transactions?api-key=${key}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transactions: [signature] }),
      });
    } catch {
      continue; // network error on this key - try next key before giving up
    }

    if (res.status === 429) {
      lastStatus = 429;
      continue; // this key is rate limited - try next key
    }
    if (!res.ok) {
      lastStatus = res.status;
      continue;
    }

    // success
    cursor = (cursor + i + 1) % ENRICHMENT_KEYS.length;
    enhancedApiBreaker.recordSuccess();

    let arr: any[];
    try {
      arr = await res.json();
    } catch {
      return null;
    }

    const tx = arr?.[0];
    if (!tx) return null;

    const buyer: string | undefined = tx.feePayer;
    if (!buyer) return null;

    const nativeTransfers: any[] = tx.nativeTransfers ?? [];
    const tokenTransfers: any[] = tx.tokenTransfers ?? [];

    // SOL out of buyer's wallet (what they spent)
    const solOutByBuyer = nativeTransfers
      .filter((t) => t.fromUserAccount === buyer)
      .reduce((sum, t) => sum + (t.amount ?? 0), 0) / 1e9;

    // token that flowed INTO the buyer's wallet = the thing they bought
    const tokenIn = tokenTransfers.find((t) => t.toUserAccount === buyer);
    if (!tokenIn || solOutByBuyer <= 0) return null; // not a buy we care about

    return {
      signature,
      buyer,
      mint: tokenIn.mint ?? null,
      solIn: solOutByBuyer,
      tokensOut: tokenIn.tokenAmount ?? 0,
      timestamp: tx.timestamp ?? null,
    };
  }

  // every key failed for this one signature - only NOW does it count
  // against the breaker, same threshold semantics as rpcCall
  enhancedApiBreaker.recordFailure();
  return null;
}
