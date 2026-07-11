import 'dotenv/config';

// Reads HELIUS_KEY_1, HELIUS_KEY_2, ... up to HELIUS_KEY_20 (generous
// ceiling - env vars that don't exist are filtered out below). Adding a
// 5th/6th/etc key going forward is just "add the env var on Render", no
// code change needed, unlike the old fixed 1-4 list.
const ALL_KEYS = Array.from({ length: 20 }, (_, i) => process.env[`HELIUS_KEY_${i + 1}`])
  .filter((k): k is string => !!k);

if (ALL_KEYS.length === 0) {
  throw new Error('No Helius keys found in .env (HELIUS_KEY_1..4)');
}

// keys 1 and 2 got burned through Helius quota during testing (WSS
// experiments before switching to webhooks). FEED_KEYS is unused now that
// ingestion is webhook-based, kept only for feed.ts's WSS fallback path.
export const FEED_KEYS = ALL_KEYS.slice(0, 2);

// enrichment (freshness/funding RPC calls) needs to round-robin across ALL
// four keys - restricting it to just the exhausted 1/2 pair here was the
// actual bug behind All Helius keys failed in production.
export const ENRICHMENT_KEYS = ALL_KEYS;

export function wssUrl(key: string) {
  return `wss://mainnet.helius-rpc.com/?api-key=${key}`;
}

export function rpcUrl(key: string) {
  return `https://mainnet.helius-rpc.com/?api-key=${key}`;
}

export const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? '';
export const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID ?? '';
