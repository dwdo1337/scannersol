import TelegramBot from 'node-telegram-bot-api';
import { TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID } from './config.js';
import { loadFilters, saveFilters } from './configStore.js';
import { DEFAULT_FILTERS, FilterConfig } from './filters.js';
import { getFailedSamples } from './webhookServer.js';

let bot: TelegramBot | null = null;
let stats = {
  seen: 0,
  matched: 0,
  dropped: 0,
  extractFailed: 0,   // webhook payload didn't yield a usable buyer/mint/solIn
  freshPassed: 0,     // passed the cheap tx-count freshness pre-filter
  fundingChecked: 0,  // reached the funding/CEX lookup stage
  startedAt: Date.now(),
};

export function getStats() {
  return stats;
}
export function bumpSeen() {
  stats.seen++;
}
export function bumpDropped() {
  stats.dropped++;
}
export function bumpExtractFailed() {
  stats.extractFailed++;
}
export function bumpFreshPassed() {
  stats.freshPassed++;
}
export function bumpFundingChecked() {
  stats.fundingChecked++;
}
export function bumpMatched() {
  stats.matched++;
}

// Periodic throughput log so we can see the pipeline is alive without needing Telegram.
setInterval(() => {
  const uptimeMin = Math.round((Date.now() - stats.startedAt) / 60000);
  console.log(
    `[stats] uptime=${uptimeMin}m seen=${stats.seen} dropped=${stats.dropped} ` +
      `extractFailed=${stats.extractFailed} freshPassed=${stats.freshPassed} ` +
      `fundingChecked=${stats.fundingChecked} matched=${stats.matched}`,
  );
}, 30000);

// simple numeric/bool field setters exposed via /setfilters key value
const SETTABLE: (keyof FilterConfig)[] = [
  'maxTxCount',
  'maxWalletAgeMin',
  'minBuySol',
  'maxBuySol',
  'requireCexFunded',
  'minSolBalancePct',
  'maxAlertsPerMin',
];

export function startBot() {
  if (!TELEGRAM_BOT_TOKEN) {
    console.log('[telegram] no bot token set, skipping bot command listener');
    return null;
  }
  bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });

  const COMMAND_MENU = [
    { command: 'help', description: 'List all commands' },
    { command: 'status', description: 'Pipeline stats and uptime' },
    { command: 'getfilters', description: 'Show current alert filters' },
    { command: 'setfilters', description: 'Set a filter: /setfilters <field> <value>' },
    { command: 'resetfilters', description: 'Reset all filters to defaults' },
  ];
  bot.setMyCommands(COMMAND_MENU).catch((err) =>
    console.error('[telegram] failed to register command menu:', err),
  );

  const HELP_TEXT =
    '<b>Available commands</b>\n\n' +
    '/status — uptime and pipeline stats (swaps seen, dropped, matched, etc.)\n' +
    '/getfilters — show the active alert filters as JSON\n' +
    '/setfilters &lt;field&gt; &lt;value&gt; — update one filter\n' +
    `   fields: ${SETTABLE.join(', ')}\n` +
    '   use "null" to clear a numeric filter, e.g. /setfilters minBuySol null\n' +
    '/resetfilters — restore all filters to their defaults\n' +
    '/help — show this message';

  bot.onText(/\/help|\/start/, (msg) => {
    bot!.sendMessage(msg.chat.id, HELP_TEXT, { parse_mode: 'HTML' });
  });

  bot.onText(/\/resetfilters/, (msg) => {
    saveFilters({ ...DEFAULT_FILTERS });
    bot!.sendMessage(msg.chat.id, 'Filters reset to defaults.');
  });

  bot.onText(/\/status/, (msg) => {
    const uptimeMin = Math.round((Date.now() - stats.startedAt) / 60000);
    bot!.sendMessage(
      msg.chat.id,
      `Uptime: ${uptimeMin}m\n` +
        `Swaps seen: ${stats.seen}\n` +
        `Dropped (over capacity): ${stats.dropped}\n` +
        `Extract failed (bad payload): ${stats.extractFailed}\n` +
        `Passed freshness filter: ${stats.freshPassed}\n` +
        `Reached funding check: ${stats.fundingChecked}\n` +
        `Alerts matched: ${stats.matched}`,
    );
  });

  bot.onText(/\/getfilters/, (msg) => {
    const cfg = loadFilters();
    bot!.sendMessage(msg.chat.id, `<pre>${JSON.stringify(cfg, null, 2)}</pre>`, {
      parse_mode: 'HTML',
    });
  });

  bot.onText(/\/rawsample/, (msg) => {
    const samples = getFailedSamples();
    if (samples.length === 0) {
      bot!.sendMessage(msg.chat.id, 'No failed samples captured yet.');
      return;
    }
    const dump = JSON.stringify(samples[0], null, 2).slice(0, 3500);
    bot!.sendMessage(msg.chat.id, `<pre>${dump}</pre>`, { parse_mode: 'HTML' });
  });

  bot.onText(/\/rawshape/, (msg) => {
    const samples = getFailedSamples();
    if (samples.length === 0) {
      bot!.sendMessage(msg.chat.id, 'No failed samples captured yet.');
      return;
    }
    const tx = samples[0];
    const shape = {
      topLevelKeys: Object.keys(tx),
      type: tx.type,
      feePayer: tx.feePayer,
      events: tx.events,
      tokenTransfers: tx.tokenTransfers,
      nativeTransfers: tx.nativeTransfers,
    };
    const dump = JSON.stringify(shape, null, 2).slice(0, 3500);
    bot!.sendMessage(msg.chat.id, `<pre>${dump}</pre>`, { parse_mode: 'HTML' });
  });

  bot.onText(/\/setfilters (\w+) (\S+)/, (msg, match) => {
    const key = match?.[1] as keyof FilterConfig;
    const raw = match?.[2];
    if (!key || !SETTABLE.includes(key)) {
      bot!.sendMessage(
        msg.chat.id,
        `Unknown field. Valid: ${SETTABLE.join(', ')}`,
      );
      return;
    }
    const cfg = loadFilters();
    let value: any;
    if (raw === 'null') value = null;
    else if (raw === 'true' || raw === 'false') value = raw === 'true';
    else value = Number(raw);

    (cfg as any)[key] = value;
    saveFilters(cfg);
    bot!.sendMessage(msg.chat.id, `Set ${key} = ${value}`);
  });

  console.log('[telegram] bot commands active: /status /getfilters /setfilters <field> <value>');
  return bot;
}
