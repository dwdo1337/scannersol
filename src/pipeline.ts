// Core "is this swap worth alerting on" pipeline. Extracted out of index.ts
// so both the webhook receiver (Render, production) and, if ever needed
// again, the raw WSS feed (feed.ts, local fallback) can share the exact
// same freshness/funding/filter/alert logic.
import { checkFreshness } from './freshness.js';
import { resolveFunding } from './funding.js';
import { matchesFilters, MatchInput } from './filters.js';
import { sendAlert, formatAlert } from './telegram.js';
import { loadFilters } from './configStore.js';
import { getCachedWallet, saveWalletCache } from './walletCache.js';
import { alreadyAlerted, markAlerted } from './dedupe.js';
import { allowAlert } from './rateLimit.js';
import { bumpMatched, bumpFreshPassed, bumpFundingChecked } from './bot.js';
import { getTokenSafety } from './tokenSafety.js';
import { recordAndGetClusterSize, recordAndGetBuyRank } from './clusterTracker.js';
import { computeScore } from './scoring.js';

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
      txCount = cached.tx_count ?? 0;
      firstSeen = cached.first_seen;
    } else {
      const fresh = await checkFreshness(swap.buyer, cfg.maxTxCount);
      txCount = fresh.txCount;
      firstSeen = fresh.firstSeen;
      oldestSigs = fresh.oldestFirstSignatures;
    }

    if (txCount >= cfg.maxTxCount) return; // not fresh, skip expensive lookups
    bumpFreshPassed();

    const nowSec = Date.now() / 1000;
    const walletAgeMin = firstSeen != null ? (nowSec - firstSeen) / 60 : null;

    let cexLabel = cached?.funded_label ?? null;
    let fundedBy = cached?.funded_by ?? null;
    let fundedAt = cached?.funded_at ?? null;

    const needsFundingLookup = !cached || cached.funded_resolved === 0;
    bumpFundingChecked();

    if (needsFundingLookup) {
      const funding = await resolveFunding(swap.buyer, oldestSigs);
      cexLabel = funding.cexLabel;
      fundedBy = funding.fundedBy;
      fundedAt = funding.fundedAt;
      saveWalletCache({
        address: swap.buyer,
        first_seen: firstSeen,
        tx_count: txCount,
        funded_by: fundedBy,
        funded_label: cexLabel,
        funded_at: fundedAt,
        funded_resolved: funding.cexResolved ? 1 : 0,
      });
    }

    // ---- token-side safety (mint/freeze authority, holders, liquidity) ----
    const safety = await getTokenSafety(swap.mint);

    // ---- cluster / buy-rank momentum signals ----
    const clusterSize = recordAndGetClusterSize(swap.mint, swap.buyer, fundedBy, cfg.clusterWindowMin);
    const buyRank = recordAndGetBuyRank(swap.mint, swap.buyer);

    const scoreInput: Omit<MatchInput, 'score'> = {
      txCount,
      walletAgeMin,
      buySol: swap.solIn,
      cexLabel,
      fundedAt,
      buyRank,
      poolImpactPct:
        safety.liquidityUsd != null && safety.liquidityUsd > 0 && safety.solPriceUsd != null
          ? ((swap.solIn * safety.solPriceUsd) / safety.liquidityUsd) * 100
          : null, // buy size (USD) as % of pool liquidity depth at check time
      mintRevoked: safety.mintRevoked,
      freezeRevoked: safety.freezeRevoked,
      topHolderPct: safety.topHolderPct,
      devHolderPct: safety.devHolderPct,
      liquidityUsd: safety.liquidityUsd,
      tokenAgeSec: safety.tokenAgeSec,
      clusterSize,
    };
    const scoreBreakdown = computeScore(scoreInput);
    const matchInput: MatchInput = { ...scoreInput, score: scoreBreakdown.total };

    const isMatch = matchesFilters(matchInput, cfg);

    console.log(
      `[check] ${swap.buyer.slice(0, 6)}.. tx=${txCount} age=${walletAgeMin?.toFixed(0)}m ` +
        `buy=${swap.solIn.toFixed(3)}SOL cex=${cexLabel ?? 'none'} score=${scoreBreakdown.total} ` +
        `cluster=${clusterSize} rank=${buyRank} match=${isMatch}`,
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
        fundedAt,
        buyRank,
        clusterSize,
        score: scoreBreakdown,
        safety,
      }),
    );
  } finally {
    inFlight.delete(swap.buyer);
  }
}
