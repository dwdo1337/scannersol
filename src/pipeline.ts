// Core "is this swap worth alerting on" pipeline. Extracted out of index.ts
// so both the webhook receiver (Render, production) and, if ever needed
// again, the raw WSS feed (feed.ts, local fallback) can share the exact
// same freshness/funding/filter/alert logic.
import { checkFreshness } from './freshness.js';
import { resolveFunding } from './funding.js';
import { matchesFilters } from './filters.js';
import { sendAlert, formatAlert } from './telegram.js';
import { loadFilters } from './configStore.js';
import { getCachedWallet, saveWalletCache } from './walletCache.js';
import { alreadyAlerted, markAlerted } from './dedupe.js';
import { allowAlert } from './rateLimit.js';
import { bumpMatched } from './bot.js';

export interface SwapEvent {
  signature: string;
  buyer: string;
  mint: string;
  solIn: number;
}

const inFlight = new Set<string>();

export async function handleSwap(swap: SwapEvent) {
  if (inFlight.has(swap.buyer)) return;
  inFlight.add(swap.buyer);

  try {
    const cfg = loadFilters(); // re-read each time so /setfilters takes effect live
    const cached = getCachedWallet(swap.buyer);

    let txCount: number;
    let firstSeen: number | null;
    let oldestSigs: string[] = [];

    if (cached && cached.funded_resolved !== 0) {
      // fully trustworthy cache hit - freshness AND funding both settled
      txCount = cached.tx_count ?? 0;
      firstSeen = cached.first_seen;
    } else {
      // either no cache entry, or funding lookup was left unresolved last
      // time (transient failure) - re-derive freshness so we have
      // oldestSigs to retry the funding lookup with.
      const fresh = await checkFreshness(swap.buyer, cfg.maxTxCount);
      txCount = fresh.txCount;
      firstSeen = fresh.firstSeen;
      oldestSigs = fresh.oldestFirstSignatures;
    }

    if (txCount >= cfg.maxTxCount) return; // not fresh, skip expensive funding lookup

    const nowSec = Date.now() / 1000;
    const walletAgeMin = firstSeen != null ? (nowSec - firstSeen) / 60 : null;

    let cexLabel = cached?.funded_label ?? null;
    let fundedBy = cached?.funded_by ?? null;

    // Re-run the funding/CEX lookup if we have no cache entry, OR if the
    // cached entry's funding lookup was never actually resolved (e.g. it
    // hit a 429 last time) - otherwise a transient failure gets baked in
    // as a permanent false negative for the rest of the cache TTL.
    const needsFundingLookup = !cached || cached.funded_resolved === 0;

    if (needsFundingLookup) {
      const funding = await resolveFunding(swap.buyer, oldestSigs);
      cexLabel = funding.cexLabel;
      fundedBy = funding.fundedBy;
      saveWalletCache({
        address: swap.buyer,
        first_seen: firstSeen,
        tx_count: txCount,
        funded_by: fundedBy,
        funded_label: cexLabel,
        funded_resolved: funding.cexResolved ? 1 : 0,
      });
    }

    const isMatch = matchesFilters(
      { txCount, walletAgeMin, buySol: swap.solIn, cexLabel },
      cfg,
    );

    console.log(
      `[check] ${swap.buyer.slice(0, 6)}.. tx=${txCount} age=${walletAgeMin?.toFixed(0)}m ` +
        `buy=${swap.solIn.toFixed(3)}SOL cex=${cexLabel ?? 'none'} match=${isMatch}`,
    );

    if (!isMatch) return;
    bumpMatched();

    if (alreadyAlerted(swap.buyer, swap.mint)) return;
    if (!allowAlert(cfg.maxAlertsPerMin)) {
      console.log('[rate-limit] alert suppressed, over cap');
      return;
    }

    markAlerted(swap.buyer, swap.mint);
    await sendAlert(
      formatAlert({
        wallet: swap.buyer,
        mint: swap.mint,
        txCount,
        walletAgeMin,
        buySol: swap.solIn,
        cexLabel,
      }),
    );
  } finally {
    inFlight.delete(swap.buyer);
  }
}
