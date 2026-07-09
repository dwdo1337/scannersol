import TelegramBot from 'node-telegram-bot-api';
import { TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID } from './config.js';
import { loadFilters, saveFilters } from './configStore.js';
import { FilterConfig } from './filters.js';

let bot: TelegramBot | null = null;
let stats = { seen: 0, matched: 0, dropped: 0, startedAt: Date.now() };

export function getStats() {
  return stats;
}
export function bumpSeen() {
  stats.seen++;
}
export function bumpDropped() {
  stats.dropped++;
}
export function bumpMatched() {

  stats.matched++;
}

// Periodic throughput log so we can see the pipeline is alive without needing Telegram.
setInterval(() => {
  const uptimeMin = Math.round((Date.now() - stats.startedAt) / 60000);
  console.log(`[stats] uptime=${uptimeMin}m seen=${stats.seen} dropped=${stats.dropped} matched=${stats.matched}`);
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

  bot.onText(/\/status/, (msg) => {
    const uptimeMin = Math.round((Date.now() - stats.startedAt) / 60000);
    bot!.sendMessage(
      msg.chat.id,
      `Uptime: ${uptimeMin}m\nSwaps seen: ${stats.seen}\nDropped (over capacity): ${stats.dropped}\nAlerts matched: ${stats.matched}`,
    );
  });

  bot.onText(/\/getfilters/, (msg) => {
    const cfg = loadFilters();
    bot!.sendMessage(msg.chat.id, `<pre>${JSON.stringify(cfg, null, 2)}</pre>`, {
      parse_mode: 'HTML',
    });
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
