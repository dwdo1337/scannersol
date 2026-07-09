export interface FilterConfig {
  maxTxCount: number;        // e.g. 5 -> "under 5 transactions"
  maxWalletAgeMin: number | null; // e.g. 60 -> wallet first seen < 60 min ago
  minBuySol: number | null;
  maxBuySol: number | null;
  // Comma-separated exchange labels to accept, e.g. "Binance,OKX,Bybit".
  // Empty/null = any CEX-funded wallet is accepted (old requireCexFunded=true
  // behaviour). Set to a literal "none" sentinel via /resetfunding to accept
  // wallets regardless of funding source, including unresolved ones.
  allowedFundingSources: string[] | null;
  // Funding->first-buy timing window, in minutes. This is the core
  // "insider setup" signal: a wallet funded 10 minutes before a snipe-timed
  // buy reads very differently from one funded three days prior.
  minMinutesSinceFunding: number | null;
  maxMinutesSinceFunding: number | null;
  minSolBalancePct: number | null; // reserved for future: buy as % of pool
  maxAlertsPerMin: number; // safety valve against alert floods
}

export const DEFAULT_FILTERS: FilterConfig = {
  maxTxCount: 5,
  maxWalletAgeMin: 60,
  minBuySol: null,
  maxBuySol: null,
  allowedFundingSources: null,
  minMinutesSinceFunding: null,
  maxMinutesSinceFunding: null,
  minSolBalancePct: null,
  maxAlertsPerMin: 20,
};

export interface MatchInput {
  txCount: number;
  walletAgeMin: number | null;
  buySol: number;
  cexLabel: string | null;
  fundedAt: number | null; // unix seconds
}

export function matchesFilters(input: MatchInput, cfg: FilterConfig): boolean {
  if (input.txCount >= cfg.maxTxCount) return false;
  if (cfg.maxWalletAgeMin != null && input.walletAgeMin != null) {
    if (input.walletAgeMin > cfg.maxWalletAgeMin) return false;
  }
  if (cfg.minBuySol != null && input.buySol < cfg.minBuySol) return false;
  if (cfg.maxBuySol != null && input.buySol > cfg.maxBuySol) return false;

  if (cfg.allowedFundingSources && cfg.allowedFundingSources.length > 0) {
    if (!input.cexLabel) return false; // unresolved/non-CEX funding, and a source list was required
    const label = input.cexLabel.toLowerCase();
    const allowed = cfg.allowedFundingSources.some((s) => label.includes(s.toLowerCase()));
    if (!allowed) return false;
  }

  if (cfg.minMinutesSinceFunding != null || cfg.maxMinutesSinceFunding != null) {
    if (input.fundedAt == null) return false; // funding time unknown, can't evaluate the window
    const minutesSinceFunding = (Date.now() / 1000 - input.fundedAt) / 60;
    if (cfg.minMinutesSinceFunding != null && minutesSinceFunding < cfg.minMinutesSinceFunding) return false;
    if (cfg.maxMinutesSinceFunding != null && minutesSinceFunding > cfg.maxMinutesSinceFunding) return false;
  }

  return true;
}
