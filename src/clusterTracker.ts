// Lightweight in-memory tracking for two signals that need "recent buys
// across all wallets", not per-wallet state:
//   1. Cluster/sybil detection: same funder feeding multiple distinct fresh
//      wallets that all buy the SAME mint within a short window.
//   2. Buy rank: is this the 1st/5th/50th distinct wallet to buy this mint
//      at all (since we started watching it).
// Both are process-local and reset on restart, which is fine - they're
// about "right now" momentum, not durable history.

interface ClusterEntry {
  wallet: string;
  fundedBy: string;
  ts: number;
}

const clusterByMint = new Map<string, ClusterEntry[]>();
const buyersByMint = new Map<string, Set<string>>();

const PRUNE_AFTER_MS = 30 * 60 * 1000;

function prune(entries: ClusterEntry[], windowMs: number): ClusterEntry[] {
  const cutoff = Date.now() - windowMs;
  return entries.filter((e) => e.ts >= cutoff);
}

/**
 * Records this buy and returns how many DISTINCT wallets funded by the same
 * source have bought this same mint within clusterWindowMin. Includes the
 * current wallet in the count (so a solo buy returns 1).
 */
export function recordAndGetClusterSize(
  mint: string,
  wallet: string,
  fundedBy: string | null,
  clusterWindowMin: number,
): number {
  if (!fundedBy) return 1; // can't cluster on unknown funding source

  const windowMs = clusterWindowMin * 60 * 1000;
  let entries = clusterByMint.get(mint) ?? [];
  entries = prune(entries, windowMs);
  entries.push({ wallet, fundedBy, ts: Date.now() });
  clusterByMint.set(mint, entries);

  const distinctWallets = new Set(
    entries.filter((e) => e.fundedBy === fundedBy).map((e) => e.wallet),
  );
  return distinctWallets.size;
}

/** Records this wallet as a buyer of mint and returns its 1-based buy rank. */
export function recordAndGetBuyRank(mint: string, wallet: string): number {
  let buyers = buyersByMint.get(mint);
  if (!buyers) {
    buyers = new Set();
    buyersByMint.set(mint, buyers);
  }
  if (!buyers.has(wallet)) buyers.add(wallet);
  return buyers.size;
}

// Periodic cleanup so both maps don't grow unbounded over a long uptime.
setInterval(() => {
  const cutoff = Date.now() - PRUNE_AFTER_MS;
  for (const [mint, entries] of clusterByMint) {
    const kept = entries.filter((e) => e.ts >= cutoff);
    if (kept.length === 0) clusterByMint.delete(mint);
    else clusterByMint.set(mint, kept);
  }
  if (buyersByMint.size > 5000) {
    const oldestKeys = Array.from(buyersByMint.keys()).slice(0, 1000);
    for (const k of oldestKeys) buyersByMint.delete(k);
  }
}, 5 * 60 * 1000);
