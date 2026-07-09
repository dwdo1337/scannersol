import { rpcCall } from './rpcPool.js';
import { lookupCexLabel } from './cexLabels.js';

export interface FundingInfo {
  fundedBy: string | null;      // address that sent the first inbound SOL
  fundedAt: number | null;      // unix seconds
  cexLabel: string | null;      // e.g. "Binance", null if unknown/not CEX
  amountSol: number | null;
  cexResolved: boolean;         // false = CEX lookup hit a transient failure, result should NOT be persisted as confirmed
}

/**
 * Looks at a wallet's earliest visible transactions (oldest page from the
 * freshness check) and finds the first inbound native SOL transfer.
 * Reuses the same signature list so we don't double-fetch.
 */
export async function resolveFunding(
  address: string,
  oldestSignatures: string[],
): Promise<FundingInfo> {
  // walk from oldest signature forward, stop at first inbound SOL transfer
  for (const sig of oldestSignatures) {
    const tx = await rpcCall<any>('getTransaction', [
      sig,
      { maxSupportedTransactionVersion: 0 },
    ]);
    if (!tx) continue;

    const pre = tx.meta?.preBalances;
    const post = tx.meta?.postBalances;
    const keys = tx.transaction?.message?.accountKeys?.map((k: any) =>
      typeof k === 'string' ? k : k.pubkey,
    );
    if (!pre || !post || !keys) continue;

    const idx = keys.indexOf(address);
    if (idx === -1) continue;

    const delta = (post[idx] - pre[idx]) / 1e9;
    if (delta > 0) {
      // find who lost SOL in the same tx (the sender)
      const senderIdx = pre.findIndex((bal: number, i: number) => i !== idx && post[i] < bal);
      const sender = senderIdx >= 0 ? keys[senderIdx] : null;
      const lookup = sender ? await lookupCexLabel(sender) : { label: null, resolved: true };
      return {
        fundedBy: sender,
        fundedAt: tx.blockTime ?? null,
        cexLabel: lookup.label,
        amountSol: delta,
        cexResolved: lookup.resolved,
      };
    }
  }

  return { fundedBy: null, fundedAt: null, cexLabel: null, amountSol: null, cexResolved: true };
}
