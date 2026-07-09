# freshieTG — Fresh Wallet Chain-Wide Scanner

## Goal
Telegram bot that watches ALL Solana DEX buys chain-wide (not one token) and
alerts when a buy matches user-defined "freshness" filters. Not a per-token
tracker — a global firehose + filter engine.

## Core pipeline
1. WSS subscribe to swap logs on major DEX program IDs (Pump.fun, PumpSwap,
   Raydium AMM v4/CPMM, Meteora DBC/DLMM) via Helius — catches every buy tx
   on-chain in real time.
2. Parse each tx: buyer wallet, mint, SOL in, tokens out, pool reserves
   before/after (for % bought calc).
3. Cheap pre-filter: getSignaturesForAddress(buyer, limit~10) — reject if
   tx count exceeds max threshold BEFORE doing anything expensive.
4. For wallets passing step 3: resolve funding source (first inbound SOL
   transfer) + check against CEX label list / Helius wallet identity API.
5. Run full metric set (below) against user config.
6. If match -> Telegram alert with wallet, metrics, buy link.

## Storage
SQLite. Tables: wallets_cache (address, first_seen, tx_count, funded_by,
funded_label, last_checked), alerts_sent (dedupe), config (active filter set).

## Full metric/filter catalogue (all configurable, toggle any combo)

### Wallet age / history
- max total tx count (lifetime) — "under N transactions"
- wallet age in minutes/hours/days since first-ever tx
- first-ever token buy (never bought any SPL token before this one)
- max SOL balance (fresh wallets are usually thin)

### Funding source
- funded directly from a labeled CEX (Binance/Coinbase/Kraken/OKX/Bybit/etc)
- funded from a wallet that funded N other wallets recently (sybil/insider
  cluster — same funder feeding multiple "fresh" buyers)
- funding amount close to buy amount (funded just enough to make this buy)
- time gap between funding tx and buy tx (funded <X min before buying =
  "just woke up to ape this")

### Buy behavior
- buy size as % of pool liquidity at time of buy
- buy size as % of circulating/total supply
- absolute SOL amount spent (min/max range)
- buy rank (1st/5th/50th buyer of this specific token, if useful later)
- slippage tolerance used (high slippage = urgency/bot-like)

### Token-side context (optional, secondary)
- token age (how new is the token itself — pairs with wallet freshness)
- token liquidity size (avoid picking up dead/illiquid pools)
- exclude known dev/insider wallets if token has public info

### Meta / noise filters
- exclude wallets that already triggered an alert in last X min (dedupe)
- exclude known MEV/bot/router addresses
- max alerts per minute (rate limit for your own sanity)

## Data sources
- Helius WSS logsSubscribe — real-time swap detection (primary feed)
- Helius getSignaturesForAddress — cheap tx-count/age pre-filter
- Helius parsed transaction API — decode swap + funding transfers
- Helius wallet identity / batch-identity API — CEX/entity labels
  (https://api.helius.xyz/v1/wallet/{address}/identity)
- Static fallback CEX address list (Binance/Coinbase/Kraken hot wallets)
  cached locally in case identity API misses one

## Stack
TypeScript + Node. Reasons: best Helius SDK support, reuse patterns from
STBAE (wallet.ts Helius pipeline) and solwatch-v2 (tx parsing approach).
node-telegram-bot-api or grammy for delivery. better-sqlite3 for storage.

## Build order
1. WSS listener + raw swap parser (no filters yet, just log everything)
2. SQLite wallet cache + cheap freshness pre-filter
3. Funding-source resolver + CEX labeling
4. Filter engine reading a config object (all metrics above as toggles)
5. Telegram bot: /setfilters, /status, alert formatting
6. Tune thresholds against live data, add rate limiting

## Status log
- [done] research + architecture decided
- [done] 4 Helius keys pooled: 2 dedicated to parallel WSS feed (dedupe by
  signature, 5min TTL), all 4 in round-robin enrichment pool with 429
  fallback (src/rpcPool.ts)
- [done] phase 1 scaffold: src/config.ts, src/rpcPool.ts, src/freshness.ts
  (cheap tx-count pre-filter, no deep paging), src/feed.ts (dual WSS,
  watches Raydium v4/CPMM + Pump.fun + PumpSwap), src/index.ts (test wiring)
- [done] phase 2: src/parseSwap.ts (Helius Enhanced Tx API decode -> buyer,
  mint, solIn, tokensOut), src/funding.ts (walks oldest signatures to find
  first inbound SOL transfer + sender), src/cexLabels.ts (static label map
  - PLACEHOLDER addresses, need real verified Solscan-labeled hot wallets
  before relying on requireCexFunded), src/filters.ts (FilterConfig +
  matchesFilters, all metrics toggleable), src/telegram.ts (sendAlert +
  formatAlert, no-ops with console log if bot token/chat id not in .env)
- [done] full pipeline wired in index.ts: feed -> parseSwapTx -> freshness
  pre-filter -> resolveFunding -> matchesFilters -> telegram/log. Verified
  running live against real chain swaps (typecheck clean, ran ~30s, saw
  real buyer wallets scored with tx count/age/buy size/funding, no crashes,
  transient fetch ECONNRESET on getTransaction handled gracefully by
  existing try/catch + continues fine)
- [next] SQLite persistence (wallets_cache, alerts_sent dedupe, config
  table) - currently everything is in-memory/hardcoded DEFAULT_FILTERS
- [next] REPLACE placeholder CEX addresses in cexLabels.ts with verified
  ones (Helius wallet identity API or a maintained Solscan label export)
- [next] Telegram bot commands (/setfilters, /status) instead of hardcoded
  DEFAULT_FILTERS - currently TELEGRAM_BOT_TOKEN/CHAT_ID must be in .env
- [next] rate limiting / max alerts per min, sybil-cluster detection
  (same funder feeding multiple fresh wallets)
- keys live in .env (gitignored), never printed in chat
