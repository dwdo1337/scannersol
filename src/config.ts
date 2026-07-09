import 'dotenv/config';

const ALL_KEYS = [
  process.env.HELIUS_KEY_1,
  process.env.HELIUS_KEY_2,
  process.env.HELIUS_KEY_3,
  process.env.HELIUS_KEY_4,
].filter((k): k is string => !!k);

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
