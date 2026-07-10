import { TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID } from './config.js';
import { ScoreBreakdown } from './scoring.js';
import { TokenSafety } from './tokenSafety.js';

export async function sendAlert(payload: { text: string; mint: string | null }) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.log('[telegram:disabled]', payload.text);
    return;
  }
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  const keyboard = payload.mint
    ? {
        inline_keyboard: [
          [
            { text: '📈 Chart', url: `https://dexscreener.com/solana/${payload.mint}` },
            { text: '⚡ Photon', url: `https://photon-sol.tinyastro.io/en/lp/${payload.mint}` },
          ],
          [{ text: '🔍 Solscan (mint)', url: `https://solscan.io/token/${payload.mint}` }],
        ],
      }
    : undefined;
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: payload.text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        reply_markup: keyboard,
      }),
    });
  } catch (err) {
    console.error('[telegram] send failed', err);
  }
}

function scoreEmoji(score: number): string {
  if (score >= 75) return '🟢';
  if (score >= 50) return '🟡';
  return '🔴';
}

function boolIcon(v: boolean | null): string {
  if (v === true) return '✅';
  if (v === false) return '❌';
  return '❔';
}

function fmtUsd(n: number | null): string {
  if (n == null) return 'unknown';
  if (n >= 1000) return `$${(n / 1000).toFixed(1)}k`;
  return `$${n.toFixed(0)}`;
}

function fmtAge(sec: number | null): string {
  if (sec == null) return 'unknown';
  if (sec < 60) return `${Math.round(sec)}s`;
  if (sec < 3600) return `${Math.round(sec / 60)}m`;
  return `${Math.round(sec / 3600)}h`;
}

export function formatAlert(params: {
  wallet: string;
  mint: string | null;
  txCount: number;
  walletAgeMin: number | null;
  buySol: number;
  cexLabel: string | null;
  fundedAt: number | null;
  buyRank: number | null;
  clusterSize: number | null;
  score: ScoreBreakdown;
  safety: TokenSafety;
}): { text: string; mint: string | null } {
  const age = params.walletAgeMin != null ? `${Math.round(params.walletAgeMin)}m` : 'unknown';
  const funded = params.cexLabel ?? 'unresolved';
  const fundedAgo =
    params.fundedAt != null ? `${Math.round((Date.now() / 1000 - params.fundedAt) / 60)}m ago` : 'unknown';
  const s = params.safety;

  const lines = [
    `🆕 <b>FRESH BUY</b>  •  Score: ${scoreEmoji(params.score.total)} ${params.score.total}/100`,
    '━━━━━━━━━━━━━━━━━━━━',
    `Wallet <code>${params.wallet.slice(0, 4)}…${params.wallet.slice(-4)}</code> (age ${age}, ${params.txCount} tx)`,
    `funded by ${funded} • ${fundedAgo} • buy ${params.buySol.toFixed(3)} SOL`,
    '',
    `Token: <code>${params.mint ?? 'unknown'}</code>`,
    `Liquidity: ${fmtUsd(s.liquidityUsd)} • Age: ${fmtAge(s.tokenAgeSec)}`,
    `Mint revoked: ${boolIcon(s.mintRevoked)} • Freeze revoked: ${boolIcon(s.freezeRevoked)}`,
    `Top10 holders: ${s.topHolderPct != null ? s.topHolderPct.toFixed(1) + '%' : 'unknown'} • ` +
      `Largest holder: ${s.devHolderPct != null ? s.devHolderPct.toFixed(1) + '%' : 'unknown'}`,
    `Buy rank: #${params.buyRank ?? '?'}`,
  ];

  if (params.clusterSize != null && params.clusterSize > 1) {
    lines.push('', `⚠️ ${params.clusterSize} fresh wallets from the same funder bought this token recently`);
  }

  return { text: lines.join('\n'), mint: params.mint };
}
