export interface FilterConfig {
  maxTxCount: number;        // e.g. 5 -> "under 5 transactions"
  maxWalletAgeMin: number | null; // e.g. 60 -> wallet first seen < 60 min ago
  minBuySol: number | null;
  maxBuySol: number | null;
  requireCexFunded: boolean; // only alert if funded directly from labeled CEX
  minSolBalancePct: number | null; // reserved for future: buy as % of pool
  maxAlertsPerMin: number; // safety valve against alert floods
}

export const DEFAULT_FILTERS: FilterConfig = {
  maxTxCount: 5,
  maxWalletAgeMin: 60,
  minBuySol: null,
  maxBuySol: null,
  requireCexFunded: true,
  minSolBalancePct: null,
  maxAlertsPerMin: 20,
};

export interface MatchInput {
  txCount: number;
  walletAgeMin: number | null;
  buySol: number;
  cexLabel: string | null;
}

export function matchesFilters(input: MatchInput, cfg: FilterConfig): boolean {
  if (input.txCount >= cfg.maxTxCount) return false;
  if (cfg.maxWalletAgeMin != null && input.walletAgeMin != null) {
    if (input.walletAgeMin > cfg.maxWalletAgeMin) return false;
  }
  if (cfg.minBuySol != null && input.buySol < cfg.minBuySol) return false;
  if (cfg.maxBuySol != null && input.buySol > cfg.maxBuySol) return false;
  if (cfg.requireCexFunded && !input.cexLabel) return false;
  return true;
}
