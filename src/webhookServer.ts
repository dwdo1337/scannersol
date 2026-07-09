// Helius Enhanced Webhook receiver. Replaces the WSS-firehose approach
// (feed.ts / parseSwap.ts) - Helius does the filtering server-side by
// program ID and transaction type, so we only ever receive transactions
// that are already-parsed swaps, not the full chain-wide firehose. This
// removes the entire rate-limiter/concurrency problem we were fighting
// with the WSS approach, since we're no longer calling the Enhanced
// Transactions API ourselves per swap - Helius already did that work
// before it ever reaches us.
import express from 'express';
import { handleSwap } from './pipeline.js';
import { bumpSeen, bumpDropped, bumpExtractFailed } from './bot.js';

const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET ?? '';
const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;

// Same reasoning as the old WSS path: freshness/funding lookups still cost
// real Helius RPC calls, so still cap how many we run concurrently and
// drop the rest rather than queue forever.
const MAX_CONCURRENT_LOOKUPS = 6;
let activeLookups = 0;

// Log the raw shape of the first few webhook deliveries so we can confirm
// field names match what Helius actually sends (nativeInput/tokenOutputs
// etc. can vary slightly by tx type) - remove/lower this once confirmed.
let rawLogsRemaining = 3;

// In-memory ring buffer of raw payloads that failed extraction, so we can
// inspect real shapes via Telegram (/rawsample) without Render dashboard
// log access. Capped small - this is diagnostic only, not persisted.
const failedSamples: any[] = [];
const MAX_FAILED_SAMPLES = 5;

export function getFailedSamples() {
  return failedSamples;
}

function extractSwap(tx: any): { signature: string; buyer: string; mint: string; solIn: number } | null {
  try {
    const signature: string | undefined = tx.signature;
    const swapEvent = tx.events?.swap;
    if (!signature || !swapEvent) return null;

    const buyer: string | undefined = tx.feePayer ?? swapEvent.tokenOutputs?.[0]?.userAccount;
    const mint: string | undefined = swapEvent.tokenOutputs?.[0]?.mint;
    const lamportsIn: number | undefined = swapEvent.nativeInput?.amount
      ? Number(swapEvent.nativeInput.amount)
      : undefined;

    if (!buyer || !mint || lamportsIn == null) return null;

    return { signature, buyer, mint, solIn: lamportsIn / 1e9 };
  } catch {
    return null;
  }
}

export function startWebhookServer() {
  const app = express();
  app.use(express.json({ limit: '5mb' }));

  app.get('/health', (_req, res) => res.status(200).send('ok'));

  app.post(`/webhook/${WEBHOOK_SECRET}`, (req, res) => {
    // Ack immediately - Helius expects a fast 200, don't make it wait on
    // our downstream processing (which can include real API calls).
    res.status(200).send('ok');

    const events = Array.isArray(req.body) ? req.body : [req.body];

    if (rawLogsRemaining > 0) {
      rawLogsRemaining--;
      console.log('[webhook raw sample]', JSON.stringify(events[0]).slice(0, 2000));
    }

    for (const tx of events) {
      bumpSeen();
      const swap = extractSwap(tx);
      if (!swap) {
        bumpExtractFailed();
        if (failedSamples.length < MAX_FAILED_SAMPLES) {
          failedSamples.push(tx);
        }
        continue;
      }

      if (activeLookups >= MAX_CONCURRENT_LOOKUPS) {
        bumpDropped();
        continue;
      }
      activeLookups++;
      handleSwap(swap)
        .catch((err) => console.error('[pipeline error]', swap.signature, err))
        .finally(() => {
          activeLookups--;
        });
    }
  });

  app.listen(PORT, () => {
    console.log(`[webhook] listening on port ${PORT}, path /webhook/<secret>`);
  });
}
