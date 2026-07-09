import { TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID } from './config.js';

export async function sendAlert(text: string) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.log('[telegram:disabled]', text);
    return;
  }
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
    });
  } catch (err) {
    console.error('[telegram] send failed', err);
  }
}

export function formatAlert(params: {
  wallet: string;
  mint: string | null;
  txCount: number;
  walletAgeMin: number | null;
  buySol: number;
  cexLabel: string | null;
}) {
  const age = params.walletAgeMin != null ? `${Math.round(params.walletAgeMin)}m` : 'unknown';
  const funded = params.cexLabel ?? 'unresolved';
  return (
    `🐣 <b>Fresh wallet buy</b>\n` +
    `Wallet: <code>${params.wallet}</code>\n` +
    `Mint: <code>${params.mint ?? 'unknown'}</code>\n` +
    `Tx count: ${params.txCount} | Age: ${age}\n` +
    `Buy: ${params.buySol.toFixed(3)} SOL\n` +
    `Funded by: ${funded}`
  );
}
