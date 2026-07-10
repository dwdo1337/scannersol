// Composite 0-100 "signal strength" score, so a user can gate on one
// number (minScore) instead of memorizing every sub-field. Modeled loosely
// on the multi-point safety-score pattern used by sniper/safety bots
// (mint/freeze/holder-concentration/LP checks), but weighted toward what
// this bot is actually about: is this a genuinely fresh, well-funded,
// non-coordinated buy into a token that isn't an obvious rug.
import { MatchInput } from './filters.js';

export interface ScoreBreakdown {
  total: number; // 0-100
  freshness: number; // 0-25
  funding: number;   // 0-20
  tokenSafety: number; // 0-40
  cluster: number; // 0-15 (penalty already applied, this is the post-penalty contribution)
}

export function computeScore(input: Omit<MatchInput, 'score'>): ScoreBreakdown {
  // Freshness (0-25): fewer tx + younger wallet = higher
  let freshness = 0;
  freshness += Math.max(0, 15 - input.txCount * 3); // 0 tx -> 15, 5+ tx -> 0
  if (input.walletAgeMin != null) {
    freshness += input.walletAgeMin <= 10 ? 10 : input.walletAgeMin <= 60 ? 5 : 0;
  }
  freshness = Math.min(25, freshness);

  // Funding (0-20): CEX-funded and recently funded scores higher (classic
  // "cashed in specifically to make this buy" pattern)
  let funding = 0;
  if (input.cexLabel) funding += 10;
  if (input.fundedAt != null) {
    const minsSince = (Date.now() / 1000 - input.fundedAt) / 60;
    funding += minsSince <= 15 ? 10 : minsSince <= 60 ? 5 : 0;
  }
  funding = Math.min(20, funding);

  // Token safety (0-40): the biggest single bucket - a fresh wallet buying
  // an obvious rug is not a good signal no matter how clean the wallet is.
  let tokenSafety = 0;
  if (input.mintRevoked === true) tokenSafety += 10;
  if (input.freezeRevoked === true) tokenSafety += 10;
  if (input.topHolderPct != null) {
    tokenSafety += input.topHolderPct <= 20 ? 10 : input.topHolderPct <= 40 ? 5 : 0;
  }
  if (input.liquidityUsd != null) {
    tokenSafety += input.liquidityUsd >= 20000 ? 10 : input.liquidityUsd >= 5000 ? 5 : 0;
  }
  tokenSafety = Math.min(40, tokenSafety);

  // Cluster (0-15): a solo fresh buy is worth more than one lost in a
  // wash-trading/sybil swarm - this is a penalty, not a bonus.
  let cluster = 15;
  if (input.clusterSize != null && input.clusterSize > 1) {
    cluster = Math.max(0, 15 - (input.clusterSize - 1) * 5);
  }

  const total = Math.round(freshness + funding + tokenSafety + cluster);
  return { total, freshness, funding, tokenSafety, cluster };
}
