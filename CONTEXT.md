# freshieTG — Fresh Wallet Chain-Wide Scanner

## Goal
Telegram bot that watches Solana buys chain-wide (Pump.fun + PumpSwap) and
alerts when a buy matches user-defined "freshness" filters (tx count,
wallet age, buy size, CEX-funded origin). Not a per-token tracker — a
global firehose + filter engine, fully tunable live via Telegram commands.

## CURRENT ARCHITECTURE (as of 2026-07-09) — READ THIS FIRST
This pivoted significantly from the original WSS-firehose design. Do NOT
assume the "Build order" section below reflects current reality — see
Status log for what's actually true today.

- **Ingestion: Helius Enhanced Webhooks, not WSS.** The original plan (WSS
  logsSubscribe + call Enhanced Transactions API ourselves per swap) hit a
  hard wall: even narrowed to Pump.fun+PumpSwap, raw WSS threw ~450-560
  swaps/sec at us, but Helius rate-limited enrichment calls to ~8/sec,
  causing an infinite silent queue (zero errors, zero output, just endless
  backlog). Switched to Helius Enhanced Webhooks instead — Helius does the
  parsing/filtering server-side by program ID + tx type, and pushes
  already-decoded swap events to our own HTTP endpoint. This eliminates the
  firehose problem entirely: we only ever receive real swaps on our two
  target programs, pre-parsed.
- **Deployed on Render** (not run locally). Repo: pushed to GitHub at
  https://github.com/dwdo1337/scannersol.git, `render.yaml` defines a free
  web service (`freshietg`), auto-builds via `npm install && npm run
  build`, starts via `npm start`. Live URL: https://scannersol.onrender.com
  (confirmed healthy via GET /health -> "ok").
- **Storage: node:sqlite (built-in), not better-sqlite3.** better-sqlite3
  needed a native rebuild that hung/stalled repeatedly on this Windows
  machine. Switched to Node's built-in `node:sqlite` (DatabaseSync) —
  zero native compilation, same schema/behavior.
- **Webhook receiver**: src/webhookServer.ts, Express app, POST
  `/webhook/<WEBHOOK_SECRET>`, acks 200 immediately then processes async.
  GET /health for uptime checks.
- **Webhook registration**: scripts/registerWebhook.mjs — one-off script,
  run manually with the live Render URL as arg. Registers a Helius
  "enhanced" webhook, type SWAP, on Pump.fun (6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P)
  + PumpSwap (pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA).
  **Already registered** as of 2026-07-09: webhookID
  7e5aedad-1318-44a7-9234-fd1371719921, pointed at
  https://scannersol.onrender.com/webhook/7997275b7982436a816e6948b1452617,
  active:true. Re-running the script again will register a SECOND webhook
  (Helius doesn't dedupe) — if ever re-registering, delete the old
  webhookID first via Helius's API/dashboard.
- **feed.ts (raw WSS) is now dead code / fallback only** — kept in the repo
  in case webhooks ever need a local fallback, but NOT used in production.
  Same for parseSwap.ts (Enhanced Transactions API single-tx decode) —
  webhooks arrive pre-parsed now, so this path isn't in the live flow.
  `pipeline.ts` is the shared core logic both paths would use.

## Core pipeline (webhookServer.ts -> pipeline.ts)
1. Helius webhook POST hits `/webhook/<secret>` with pre-parsed SWAP events
   (buyer/mint/solIn extracted in webhookServer.ts's extractSwap()).
2. Bounded concurrency gate: max 6 concurrent enrichment lookups; anything
   over that is dropped (not queued) — bumpDropped() stat tracks this.
3. pipeline.ts handleSwap(): cheap freshness pre-filter
   (getSignaturesForAddress, reject if tx count >= maxTxCount) before any
   expensive lookup.
4. For wallets passing freshness: resolve funding source (first inbound
   SOL transfer + walk to sender) + Helius wallet-identity API for
   CEX/entity labels (cached in-memory 6h TTL, see cexLabels.ts).
5. matchesFilters() against live-loaded FilterConfig (SQLite-backed,
   editable via Telegram).
6. If match: dedupe check (30 min window per wallet+mint) + rate limit
   (maxAlertsPerMin, default 20) -> Telegram alert.

## Storage (node:sqlite, freshie.db in project root)
- wallets_cache: address, first_seen, tx_count, funded_by, funded_label,
  funded_resolved (0/1 - was CEX lookup actually resolved vs transient
  failure, so a 429 doesn't get baked in as a permanent false negative),
  last_checked. 10 min cache TTL.
- alerts_sent: wallet+mint dedupe, 30 min window.
- config: key/value store for live FilterConfig (persisted across
  restarts, editable via /setfilters).

## Telegram bot (src/bot.ts, node-telegram-bot-api, polling mode)
- /status — uptime, swaps seen, matched, dropped
- /getfilters — dump current FilterConfig as JSON
- /setfilters <field> <value> — live-edit any filter field, persists to
  SQLite immediately, takes effect on the next swap (pipeline.ts reloads
  config every call, no restart needed)
- Settable fields: maxTxCount, maxWalletAgeMin, minBuySol, maxBuySol,
  requireCexFunded, minSolBalancePct, maxAlertsPerMin

## Full metric/filter catalogue (design reference — not all wired yet)
### Implemented in filters.ts / matchesFilters():
- maxTxCount, maxWalletAgeMin, minBuySol, maxBuySol, requireCexFunded,
  maxAlertsPerMin
### Designed but NOT yet wired into matchesFilters() (future):
- minSolBalancePct (field exists in FilterConfig, not used in matching yet)
- sybil-cluster detection (same funder feeding multiple fresh wallets)
- buy rank (1st/5th/50th buyer of a specific token)
- token-side context (token age, liquidity size, dev/insider wallet excl.)
- first-ever-token-purchase check
- funding-amount-vs-buy-amount proximity, funding-to-buy time gap

## Known past bugs (fixed, keep for reference — don't reintroduce)
1. **Silent infinite queue (WSS era)**: unbounded queueing behind an 8/sec
   rate limiter with 450+/sec inflow = seen count climbing, matched=0,
   zero errors, zero [check] lines. Fixed by dropping excess instead of
   queueing (bounded concurrency gate). This class of bug produces NO
   error output — if [check] lines ever stop appearing while seen keeps
   climbing, suspect this exact pattern again.
2. **Reconnect storm (WSS era)**: fixed 3s reconnect delay hammered
   Helius's WSS connection-rate limit -> perpetual 429 on handshake, looked
   like "network flakiness" but was self-inflicted. Fixed with exponential
   backoff (3s->6s->12s->24s->cap 30s). Moot now since webhooks replaced
   WSS, but the backoff logic is still in feed.ts as a reference/fallback.
3. **ENRICHMENT_KEYS accidentally scoped to exhausted keys**: a global
   find-replace during the keys-1/2-exhausted fix (switching feed to use
   keys 3/4) accidentally also changed ENRICHMENT_KEYS from all 4 keys
   down to just 2 — coincidentally the SAME exhausted pair — causing "all
   Helius keys failed" in production even after adding valid new keys.
   Root-caused and fixed 2026-07-09, committed + pushed
   (commit 5f39bb3). **Always grep for all usages of a keys array after
   any find-replace touching key selection.**
4. **Helius key rotation**: original keys 1 & 2 got quota-exhausted during
   WSS testing/restarts (confirmed by user checking Helius dashboard).
   Original keys 3 & 4 returned 401 (were invalid/placeholder). User
   supplied two NEW real keys which are now in .env as HELIUS_KEY_3
   (d12eeeaa-fd68-45ff-a55b-c932377b4a54) and HELIUS_KEY_4
   (1bf5e4bd-2858-4985-a5ba-2479c16f6a27). Keys 1/2 still in .env too
   (ad6eeb95..., 9e1a445d...) — status unknown, may still be
   quota-exhausted, ENRICHMENT_KEYS round-robins across all 4 regardless
   so this self-heals as keys individually recover.
5. **CEX label list**: originally a hand-written static address list
   (unverifiable placeholders — flagged as a real accuracy risk). Replaced
   entirely with live Helius wallet-identity API lookups
   (api.helius.xyz/v1/wallet/{address}/identity), cached 6h in-memory.
   Static list removed.
6. **better-sqlite3 native build hung** on this Windows machine (silent,
   very long npm rebuild with no output, never confirmed to finish).
   Replaced with node:sqlite (Node's built-in, no native compilation).
7. **IPv6/Cloudflare route issue**: this host's IPv6 path to
   api.helius.xyz (Cloudflare-fronted) is broken while IPv4 works; Node's
   fetch sometimes raced into the dead IPv6 path -> ETIMEDOUT. Fixed with
   `dns.setDefaultResultOrder('ipv4first')` at the top of index.ts.
8. **extractSwap() used the wrong field (root cause of 0 matches after
   webhook went live)**: original code read `tx.events?.swap`, but for
   Pump.fun/PumpSwap transactions Helius returns `events: {}` (empty) —
   this field is populated for some program types but not these two.
   99.4% of webhook deliveries were silently dropped as "extract failed"
   because of this. Confirmed via a real payload dump (/rawshape
   Telegram command, added specifically to debug this without Render
   dashboard log access): the actual SOL leg of a Pump.fun/PumpSwap trade
   comes through as a **tokenTransfer with mint =
   So11111111111111111111111111111111111111112 (wrapped SOL)**, not a
   plain native transfer and not events.swap.nativeInput. Fixed by
   rewriting extractSwap() to: buyer = tx.feePayer; tokenIn = the
   tokenTransfer where toUserAccount===buyer and mint !== WSOL; solIn =
   the tokenTransfer where fromUserAccount===buyer and mint === WSOL
   (tokenAmount is already human-readable, no /1e9 needed - Helius
   pre-applies decimals). Falls back to nativeTransfers if no wrapped-SOL
   leg is found. Committed 2026-07-09 (commit 3dddd24). **If extraction
   ever silently breaks again, check /rawshape FIRST before assuming the
   filter logic is broken** - this exact failure mode (extractFailed count
   climbing, freshPassed/matched stuck at 0) has now happened once and
   cost significant debugging time assuming the bug was downstream.

## Data sources
- Helius Enhanced Webhooks — primary ingestion (SWAP type, Pump.fun +
  PumpSwap program IDs)
- Helius getSignaturesForAddress — cheap tx-count/age pre-filter
- Helius getTransaction — funding-source walk (find first inbound SOL
  transfer + sender)
- Helius wallet-identity API — CEX/entity labels, live lookup + 6h cache

## Stack
TypeScript + Node, deployed on Render (free tier). express (webhook
server), node-telegram-bot-api (bot, polling mode), node:sqlite (storage,
built-in — no native deps). dotenv for env vars.

## Status log (chronological, most recent last)
- [done] Original research across 5 reference repos (all single/few-wallet
  trackers, not chain-wide scanners — nothing directly reusable
  architecturally, confirmed on second look too)
- [done] Phase 1-2 WSS scaffold built and proven working locally (feed.ts,
  parseSwap.ts, funding.ts, filters.ts, telegram.ts) — this code still
  exists but is NOT the production path anymore
- [done] SQLite persistence, dedupe, rate limiting, Telegram bot commands
  added on top of WSS design
- [done] Hit real production-breaking bugs at scale (silent infinite
  queue, reconnect storm) — root-caused and fixed, see "Known past bugs"
- [done] **Architecture pivot**: abandoned WSS-firehose entirely, moved to
  Helius Enhanced Webhooks (webhookServer.ts, pipeline.ts). This is the
  actual production design now.
- [done] Moved off better-sqlite3 (native build hell on this machine) onto
  node:sqlite
- [done] Repo pushed to GitHub (dwdo1337/scannersol), deployed to Render
  as a free web service (render.yaml)
- [done] Found and fixed the ENRICHMENT_KEYS-scoped-to-exhausted-keys bug
  (commit 5f39bb3, pushed 2026-07-09)
- [done] Confirmed Render deploy live and healthy: GET
  https://scannersol.onrender.com/health -> "ok"
- [done] Registered the Helius webhook against the live Render URL for the
  first time ever (webhookID 7e5aedad-1318-44a7-9234-fd1371719921) —
  **this had never been done before this session**, meaning no swap data
  had ever reached production prior to now, regardless of what earlier
  bot.log / bot_out.log files show (those were from local WSS test runs)
- [next] Confirm live alerts actually flowing: ask user to run /status in
  Telegram (bot runs in polling mode, reachable independent of webhook
  traffic) and watch for seen/matched counts climbing
- [done] Root-caused and fixed the extractSwap() bug (see "Known past
  bugs" #8) — 99.4% of webhook deliveries were being silently dropped.
  Fix pushed 2026-07-09 (commit 3dddd24). Awaiting Render redeploy +
  fresh /status check to confirm freshPassed/matched start climbing.
- [next] If freshPassed still stays near 0 after this fix, check whether
  maxTxCount=5 default is simply too strict for real Pump.fun traffic
  (most buys may go through bot/router wallets with long histories, not
  literally brand-new wallets) - consider loosening default or accepting
  that fresh (<5 tx) wallets are a genuinely small % of volume
- [next] Wire minSolBalancePct into matchesFilters() (field exists,
  unused)
- [next] Sybil-cluster detection (same funder -> multiple fresh wallets)
- [next] Consider deleting/checking old bot.log, bot.err.log, bot_out.log,
  bot_err.log files locally — they're from dead local WSS test runs and
  could confuse future debugging if mistaken for production logs
- keys live in .env (gitignored) AND in Render's env var dashboard
  (render.yaml declares them sync:false, meaning Render prompts for them
  in its UI — confirm they were actually entered there, since a value only
  existing in local .env does NOT reach the deployed service)
