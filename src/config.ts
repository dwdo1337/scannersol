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

// keys 1 and 2 got burned through connection-rate limits during testing -
// using 3 and 4 until 1/2 quota resets. Revert to slice(0, 2) once they do.
export const FEED_KEYS = ALL_KEYS.slice(0, 2);

// same reasoning - keep enrichment off the burned keys for now too
export const ENRICHMENT_KEYS = ALL_KEYS.slice(0, 2);

export function wssUrl(key: string) {
  return `wss://mainnet.helius-rpc.com/?api-key=${key}`;
}

export function rpcUrl(key: string) {
  return `https://mainnet.helius-rpc.com/?api-key=${key}`;
}

export const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? '';
export const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID ?? '';
