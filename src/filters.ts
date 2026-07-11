export interface FilterConfig {
  // ---- wallet freshness ----
  maxTxCount: number;        // e.g. 5 -> "under 5 transactions"
  minWalletAgeMin: number | null; // e.g. 1 -> wallet must be at least 1 min old (filters out same-block noise)
  maxWalletAgeMin: number | null; // e.g. 60 -> wallet first seen < 60 min ago

  // ---- buy signal ----
  minBuySol: number | null;
  maxBuySol: number | null;
  minBuyRank: number | null; // only alert if buyer is among first N buyers of the token
  maxPoolImpactPct: number | null; // buy size as % of pool depth

  // ---- funding trail ----
  allowedFundingSources: string[] | null;
  minMinutesSinceFunding: number | null;
  maxMinutesSinceFunding: number | null;
  minSolBalancePct: number | null;

  // ---- token-side safety ----
  requireMintRevoked: boolean;
  requireFreezeRevoked: boolean;
  maxTopHolderPct: number | null;
  maxDevHolderPct: number | null;
  minLiquidityUsd: number | null;
  minTokenAgeSec: number | null;
  maxTokenAgeSec: number | null;

  // ---- cluster / sybil detection ----
  minClusterSize: number | null;
  clusterWindowMin: number;

  // ---- composite score gate ----
  minScore: number | null;

  maxAlertsPerMin: number;
}

export const DEFAULT_FILTERS: FilterConfig = {
  maxTxCount: 5,
  minWalletAgeMin: null,
  maxWalletAgeMin: 60,
  minBuySol: null,
  maxBuySol: null,
  minBuyRank: null,
  maxPoolImpactPct: null,
  allowedFundingSources: null,
  minMinutesSinceFunding: null,
  maxMinutesSinceFunding: null,
  minSolBalancePct: null,
  requireMintRevoked: false,
  requireFreezeRevoked: false,
  maxTopHolderPct: null,
  maxDevHolderPct: null,
  minLiquidityUsd: null,
  minTokenAgeSec: null,
  maxTokenAgeSec: null,
  minClusterSize: null,
  clusterWindowMin: 10,
  minScore: null,
  maxAlertsPerMin: 20,
};

export interface MatchInput {
  txCount: number;
  walletAgeMin: number | null;
  buySol: number;
  cexLabel: string | null;
  fundedAt: number | null;
  buyRank: number | null;
  poolImpactPct: number | null;
  mintRevoked: boolean | null;
  freezeRevoked: boolean | null;
  topHolderPct: number | null;
  devHolderPct: number | null;
  liquidityUsd: number | null;
  tokenAgeSec: number | null;
  clusterSize: number | null;
  score: number;
}

export function matchesFilters(input: MatchInput, cfg: FilterConfig): boolean {
  if (input.txCount >= cfg.maxTxCount) return false;
  if (cfg.minWalletAgeMin != null && input.walletAgeMin != null) {
    if (input.walletAgeMin < cfg.minWalletAgeMin) return false;
  }
  if (cfg.maxWalletAgeMin != null && input.walletAgeMin != null) {
    if (input.walletAgeMin > cfg.maxWalletAgeMin) return false;
  }
  if (cfg.minBuySol != null && input.buySol < cfg.minBuySol) return false;
  if (cfg.maxBuySol != null && input.buySol > cfg.maxBuySol) return false;

  if (cfg.minBuyRank != null) {
    if (input.buyRank == null || input.buyRank > cfg.minBuyRank) return false;
  }
  if (cfg.maxPoolImpactPct != null) {
    if (input.poolImpactPct == null || input.poolImpactPct > cfg.maxPoolImpactPct) return false;
  }

  if (cfg.allowedFundingSources && cfg.allowedFundingSources.length > 0) {
    if (!input.cexLabel) return false;
    const label = input.cexLabel.toLowerCase();
    const allowed = cfg.allowedFundingSources.some((s) => label.includes(s.toLowerCase()));
    if (!allowed) return false;
  }

  if (cfg.minMinutesSinceFunding != null || cfg.maxMinutesSinceFunding != null) {
    if (input.fundedAt == null) return false;
    const minutesSinceFunding = (Date.now() / 1000 - input.fundedAt) / 60;
    if (cfg.minMinutesSinceFunding != null && minutesSinceFunding < cfg.minMinutesSinceFunding) return false;
    if (cfg.maxMinutesSinceFunding != null && minutesSinceFunding > cfg.maxMinutesSinceFunding) return false;
  }

  if (cfg.requireMintRevoked && input.mintRevoked !== true) return false;
  if (cfg.requireFreezeRevoked && input.freezeRevoked !== true) return false;
  if (cfg.maxTopHolderPct != null) {
    if (input.topHolderPct == null || input.topHolderPct > cfg.maxTopHolderPct) return false;
  }
  if (cfg.maxDevHolderPct != null) {
    if (input.devHolderPct == null || input.devHolderPct > cfg.maxDevHolderPct) return false;
  }
  if (cfg.minLiquidityUsd != null) {
    if (input.liquidityUsd == null || input.liquidityUsd < cfg.minLiquidityUsd) return false;
  }
  if (cfg.minTokenAgeSec != null) {
    if (input.tokenAgeSec == null || input.tokenAgeSec < cfg.minTokenAgeSec) return false;
  }
  if (cfg.maxTokenAgeSec != null) {
    if (input.tokenAgeSec == null || input.tokenAgeSec > cfg.maxTokenAgeSec) return false;
  }

  if (cfg.minClusterSize != null) {
    if (input.clusterSize == null || input.clusterSize < cfg.minClusterSize) return false;
  }

  if (cfg.minScore != null && input.score < cfg.minScore) return false;

  return true;
}
