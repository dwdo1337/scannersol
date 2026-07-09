import { rpcCall } from './rpcPool.js';

export interface FreshnessResult {
  address: string;
  txCount: number;
  firstSeen: number | null; // unix seconds, oldest tx we could see
  isFresh: boolean;
  oldestFirstSignatures: string[]; // signatures ordered oldest -> newest, for funding lookup
}

/**
 * Cheap freshness check: pulls up to `sampleLimit` signatures for a wallet.
 * If the returned count is below maxTxCount, we treat it as "fresh enough"
 * to justify the more expensive funding-source lookup later.
 * We deliberately do NOT page back further - if a wallet has more history
 * than sampleLimit, it's not fresh, and we don't care how much more it has.
 */
export async function checkFreshness(
  address: string,
  maxTxCount: number,
  sampleLimit = 30,
): Promise<FreshnessResult> {
  const sigs = await rpcCall<any[]>('getSignaturesForAddress', [
    address,
    { limit: sampleLimit },
  ]);

  const txCount = sigs.length;
  const oldest = sigs.length > 0 ? sigs[sigs.length - 1] : null;
  const firstSeen = oldest?.blockTime ?? null;
  // Helius returns newest-first; reverse so oldest is first for funding walk
  const oldestFirstSignatures = sigs.map((s) => s.signature).reverse();

  return {
    address,
    txCount,
    firstSeen,
    isFresh: txCount < maxTxCount,
    oldestFirstSignatures,
  };
}
