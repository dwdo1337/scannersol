import WebSocket from 'ws';
import { FEED_KEYS, wssUrl } from './config.js';

// Narrowed to Pump.fun bonding-curve + PumpSwap (migrated pools) only.
// Fresh-wallet-gets-CEX-funded-then-snipes is overwhelmingly a bonding-curve
// pattern - mature Raydium pools are mostly established traders and were
// generating ~560 swaps/sec chain-wide, far beyond what per-swap Helius
// enrichment calls can sustain. This cuts volume ~10-20x with no loss of
// the signal we actually care about.
const DEX_PROGRAM_IDS = [
  '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P', // Pump.fun
  'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA', // PumpSwap
].filter(Boolean);

type SwapLogHandler = (signature: string, keyIndex: number) => void;

const seenSignatures = new Set<string>();
const SEEN_TTL_MS = 5 * 60 * 1000;

function markSeen(sig: string) {
  if (seenSignatures.has(sig)) return false;
  seenSignatures.add(sig);
  setTimeout(() => seenSignatures.delete(sig), SEEN_TTL_MS);
  return true;
}

// Reconnect backoff state per feed slot. A fixed 3s reconnect delay was
// hammering Helius's WSS connection-rate limit during any rough patch -
// each 429 triggered an immediate retry, which triggered another 429, in a
// tight self-inflicted loop that looked like a network outage but wasn't.
// Exponential backoff (capped at 30s) gives the limit window time to clear.
const reconnectAttempts: number[] = [0, 0];
const BASE_DELAY_MS = 3000;
const MAX_DELAY_MS = 30000;

function connectFeed(key: string, keyIndex: number, onSwap: SwapLogHandler) {
  const ws = new WebSocket(wssUrl(key));
  let pingInterval: NodeJS.Timeout | null = null;

  ws.on('open', () => {
    console.log(`[feed ${keyIndex}] connected`);
    reconnectAttempts[keyIndex] = 0;
    let id = 1;
    for (const programId of DEX_PROGRAM_IDS) {
      ws.send(
        JSON.stringify({
          jsonrpc: '2.0',
          id: id++,
          method: 'logsSubscribe',
          params: [{ mentions: [programId] }, { commitment: 'confirmed' }],
        }),
      );
    }
    // keepalive ping - Helius WSS times out after 10 min idle.
    // Cleared on close below - previously this leaked one interval per
    // reconnect, which piles up fast during network flapping (we've seen
    // dozens of reconnects in a couple minutes during a bad network patch).
    pingInterval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.ping();
    }, 60_000);
  });

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      const sig = msg?.params?.result?.value?.signature;
      if (!sig) return;
      if (markSeen(sig)) onSwap(sig, keyIndex); // only fire once even if both feeds catch it
    } catch {
      // ignore malformed frames
    }
  });

  ws.on('close', () => {
    if (pingInterval) clearInterval(pingInterval);
    const attempt = reconnectAttempts[keyIndex]++;
    const delay = Math.min(BASE_DELAY_MS * Math.pow(2, attempt), MAX_DELAY_MS);
    console.log(`[feed ${keyIndex}] disconnected, reconnecting in ${Math.round(delay / 1000)}s (attempt ${attempt + 1})`);
    setTimeout(() => connectFeed(key, keyIndex, onSwap), delay);
  });

  ws.on('error', (err) => console.error(`[feed ${keyIndex}] error`, err.message));
}

export function startFeed(onSwap: SwapLogHandler) {
  FEED_KEYS.forEach((key, i) => connectFeed(key, i, onSwap));
}
