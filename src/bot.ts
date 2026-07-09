import TelegramBot from 'node-telegram-bot-api';
import { TELEGRAM_BOT_TOKEN } from './config.js';
import { loadFilters, saveFilters } from './configStore.js';
import { DEFAULT_FILTERS, FilterConfig } from './filters.js';
import { getFailedSamples } from './webhookServer.js';

let bot: TelegramBot | null = null;
let stats = {
  seen: 0,
  matched: 0,
  dropped: 0,
  extractFailed: 0,
  freshPassed: 0,
  fundingChecked: 0,
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

setInterval(() => {
  const uptimeMin = Math.round((Date.now() - stats.startedAt) / 60000);
  console.log(
    `[stats] uptime=${uptimeMin}m seen=${stats.seen} dropped=${stats.dropped} ` +
      `extractFailed=${stats.extractFailed} freshPassed=${stats.freshPassed} ` +
      `fundingChecked=${stats.fundingChecked} matched=${stats.matched}`,
  );
}, 30000);

// ---- field metadata for the editable filters menu ----
const NUMERIC_FIELDS: (keyof FilterConfig)[] = [
  'maxTxCount',
  'maxWalletAgeMin',
  'minBuySol',
  'maxBuySol',
  'minMinutesSinceFunding',
  'maxMinutesSinceFunding',
  'minSolBalancePct',
  'maxAlertsPerMin',
];

const FIELD_LABEL: Record<string, string> = {
  maxTxCount: 'Max tx count',
  maxWalletAgeMin: 'Max wallet age (min)',
  minBuySol: 'Min buy (SOL)',
  maxBuySol: 'Max buy (SOL)',
  minMinutesSinceFunding: 'Min mins since funding',
  maxMinutesSinceFunding: 'Max mins since funding',
  minSolBalancePct: 'Min pool balance %',
  maxAlertsPerMin: 'Max alerts/min',
};

const KNOWN_EXCHANGES = ['Binance', 'Coinbase', 'OKX', 'Bybit', 'Kraken', 'KuCoin', 'Gate.io', 'MEXC'];

// name -> partial filter values. Timing window is the core "insider setup"
// signal; tighter presets narrow that window and shrink the wallet-age cap.
const PRESETS: Record<string, Partial<FilterConfig>> = {
  conservative: {
    maxTxCount: 3,
    maxWalletAgeMin: 30,
    minBuySol: 0.1,
    maxBuySol: null,
    minMinutesSinceFunding: null,
    maxMinutesSinceFunding: 15,
  },
  balanced: {
    maxTxCount: 5,
    maxWalletAgeMin: 60,
    minBuySol: 0.05,
    maxBuySol: null,
    minMinutesSinceFunding: null,
    maxMinutesSinceFunding: 30,
  },
  aggressive: {
    maxTxCount: 10,
    maxWalletAgeMin: 180,
    minBuySol: 0.02,
    maxBuySol: null,
    minMinutesSinceFunding: null,
    maxMinutesSinceFunding: 120,
  },
};

// chatId -> field currently awaiting a typed value, plus the menu message
// to edit back to once the value lands. Lets tapping a button prompt for
// input instead of requiring a full /setfilters <field> <value> command.
const awaitingInput = new Map<number, { field: keyof FilterConfig; menuMessageId: number }>();

function fmtVal(v: number | string | null): string {
  return v === null || v === undefined ? 'off' : String(v);
}

function mainText(): string {
  return (
    '<b>freshieTG</b>\n' +
    'Fresh Solana wallet tracker — watches DEX activity chain-wide and ' +
    'alerts on freshly-funded wallets buying in.\n\n' +
    'Pick a menu below.'
  );
}

function mainKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: '⚙️ Filters', callback_data: 'menu_filters' },
        { text: '📊 Status', callback_data: 'menu_status' },
      ],
      [{ text: '❓ Help', callback_data: 'menu_help' }],
    ],
  };
}

function filtersText(cfg: FilterConfig): string {
  const src = cfg.allowedFundingSources?.length ? cfg.allowedFundingSources.join(', ') : 'any';
  return (
    `<b>⚙️ Alert Filters</b>\n` +
    `Funding sources: <b>${src}</b>\n\n` +
    `Tap a field to change its value.`
  );
}

function filtersKeyboard(cfg: FilterConfig) {
  const b = (field: keyof FilterConfig) => ({
    text: `${FIELD_LABEL[field]}: ${fmtVal(cfg[field] as any)}`,
    callback_data: `edit_${field}`,
  });
  return {
    inline_keyboard: [
      [b('maxTxCount'), b('maxWalletAgeMin')],
      [b('minBuySol'), b('maxBuySol')],
      [b('minMinutesSinceFunding'), b('maxMinutesSinceFunding')],
      [b('minSolBalancePct'), b('maxAlertsPerMin')],
      [{ text: '🏦 Funding sources ›', callback_data: 'menu_funding' }],
      [{ text: '🎚 Presets ›', callback_data: 'menu_presets' }],
      [
        { text: '↩️ Reset all', callback_data: 'confirm_reset' },
        { text: '‹ Back', callback_data: 'menu_main' },
      ],
    ],
  };
}

function fundingText(cfg: FilterConfig): string {
  const src = cfg.allowedFundingSources?.length ? cfg.allowedFundingSources.join(', ') : 'any';
  return (
    `<b>🏦 Funding Sources</b>\n` +
    `Only alert on wallets funded from these exchanges. Tap to toggle.\n\n` +
    `Currently: <b>${src}</b>`
  );
}

function fundingKeyboard(cfg: FilterConfig) {
  const selected = new Set((cfg.allowedFundingSources ?? []).map((s) => s.toLowerCase()));
  const rows: any[] = [];
  for (let i = 0; i < KNOWN_EXCHANGES.length; i += 2) {
    rows.push(
      KNOWN_EXCHANGES.slice(i, i + 2).map((ex) => ({
        text: `${selected.has(ex.toLowerCase()) ? '✅' : '▫️'} ${ex}`,
        callback_data: `fund_toggle_${ex}`,
      })),
    );
  }
  rows.push([{ text: 'Clear (accept any source)', callback_data: 'fund_clear' }]);
  rows.push([{ text: '‹ Back to filters', callback_data: 'menu_filters' }]);
  return { inline_keyboard: rows };
}

function presetsText(): string {
  return (
    '<b>🎚 Presets</b>\n' +
    'Quick-apply a starting point, then fine-tune from Filters.\n\n' +
    '🐢 <b>Conservative</b> — tight window (≤15m since funding), fewer alerts\n' +
    '⚖️ <b>Balanced</b> — ≤30m since funding, moderate volume\n' +
    '🚀 <b>Aggressive</b> — ≤2h since funding, catches more, noisier'
  );
}

function presetsKeyboard() {
  return {
    inline_keyboard: [
      [{ text: '🐢 Conservative', callback_data: 'preset_conservative' }],
      [{ text: '⚖️ Balanced', callback_data: 'preset_balanced' }],
      [{ text: '🚀 Aggressive', callback_data: 'preset_aggressive' }],
      [{ text: '‹ Back', callback_data: 'menu_filters' }],
    ],
  };
}

function statusText(): string {
  const uptimeMin = Math.round((Date.now() - stats.startedAt) / 60000);
  return (
    `<b>📊 Status</b>\n\n` +
    `Uptime: ${uptimeMin}m\n` +
    `Swaps seen: ${stats.seen}\n` +
    `Dropped (over capacity): ${stats.dropped}\n` +
    `Extract failed: ${stats.extractFailed}\n` +
    `Passed freshness filter: ${stats.freshPassed}\n` +
    `Reached funding check: ${stats.fundingChecked}\n` +
    `Alerts matched: ${stats.matched}`
  );
}

function backKeyboard(target = 'menu_main') {
  return { inline_keyboard: [[{ text: '‹ Back', callback_data: target }]] };
}

const HELP_TEXT =
  '<b>❓ Help</b>\n\n' +
  'Use the buttons — /start brings up the menu any time. Tapping a filter ' +
  'field lets you type a new number directly; tapping a funding source ' +
  'toggles it on/off.\n\n' +
  '<b>Commands (for scripting):</b>\n' +
  '/status — pipeline stats\n' +
  '/getfilters — current filters\n' +
  '/setfilters &lt;field&gt; &lt;value&gt; — set one filter, "null" clears it\n' +
  '/setfunding &lt;list&gt; — comma-separated exchanges, e.g. Binance,OKX\n' +
  '/resetfunding — clear funding restriction\n' +
  '/resetfilters — restore defaults';

export function startBot() {
  if (!TELEGRAM_BOT_TOKEN) {
    console.log('[telegram] no bot token set, skipping bot command listener');
    return null;
  }
  bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });

  bot
    .setMyCommands([
      { command: 'start', description: 'Open the menu' },
      { command: 'help', description: 'List all commands' },
      { command: 'status', description: 'Pipeline stats and uptime' },
      { command: 'getfilters', description: 'Show current alert filters' },
      { command: 'setfilters', description: 'Set a filter: /setfilters <field> <value>' },
      { command: 'setfunding', description: 'Allowed CEX sources: /setfunding Binance,OKX' },
      { command: 'resetfunding', description: 'Clear funding-source restriction' },
      { command: 'resetfilters', description: 'Reset all filters to defaults' },
    ])
    .catch((err) => console.error('[telegram] failed to register command menu:', err));

  bot.onText(/\/start/, (msg) => {
    bot!.sendMessage(msg.chat.id, mainText(), { parse_mode: 'HTML', reply_markup: mainKeyboard() });
  });

  bot.onText(/\/help/, (msg) => {
    bot!.sendMessage(msg.chat.id, HELP_TEXT, { parse_mode: 'HTML' });
  });

  bot.on('callback_query', async (query) => {
    const chatId = query.message?.chat.id;
    const messageId = query.message?.message_id;
    if (!chatId || !messageId) return;
    bot!.answerCallbackQuery(query.id).catch(() => {});
    const data = query.data ?? '';
    if (!data.startsWith('edit_')) awaitingInput.delete(chatId);


    const edit = (text: string, keyboard: any) =>
      bot!
        .editMessageText(text, { chat_id: chatId, message_id: messageId, parse_mode: 'HTML', reply_markup: keyboard })
        .catch(() => {});

    if (data === 'menu_main') return edit(mainText(), mainKeyboard());
    if (data === 'menu_filters') return edit(filtersText(loadFilters()), filtersKeyboard(loadFilters()));
    if (data === 'menu_funding') return edit(fundingText(loadFilters()), fundingKeyboard(loadFilters()));
    if (data === 'menu_presets') return edit(presetsText(), presetsKeyboard());
    if (data === 'menu_status') return edit(statusText(), backKeyboard());
    if (data === 'menu_help') return edit(HELP_TEXT, backKeyboard());

    if (data === 'confirm_reset') {
      return edit('Reset all filters to defaults?', {
        inline_keyboard: [
          [
            { text: '✅ Yes, reset', callback_data: 'reset_yes' },
            { text: '❌ Cancel', callback_data: 'menu_filters' },
          ],
        ],
      });
    }
    if (data === 'reset_yes') {
      saveFilters({ ...DEFAULT_FILTERS });
      return edit(filtersText(loadFilters()), filtersKeyboard(loadFilters()));
    }

    if (data.startsWith('preset_')) {
      const name = data.slice('preset_'.length);
      const preset = PRESETS[name];
      if (preset) saveFilters({ ...loadFilters(), ...preset });
      return edit(filtersText(loadFilters()), filtersKeyboard(loadFilters()));
    }

    if (data.startsWith('fund_toggle_')) {
      const ex = data.slice('fund_toggle_'.length);
      const cfg = loadFilters();
      const current = cfg.allowedFundingSources ?? [];
      const has = current.some((s) => s.toLowerCase() === ex.toLowerCase());
      cfg.allowedFundingSources = has
        ? current.filter((s) => s.toLowerCase() !== ex.toLowerCase())
        : [...current, ex];
      if (cfg.allowedFundingSources.length === 0) cfg.allowedFundingSources = null;
      saveFilters(cfg);
      return edit(fundingText(cfg), fundingKeyboard(cfg));
    }
    if (data === 'fund_clear') {
      const cfg = loadFilters();
      cfg.allowedFundingSources = null;
      saveFilters(cfg);
      return edit(fundingText(cfg), fundingKeyboard(cfg));
    }

    if (data.startsWith('edit_')) {
      const field = data.slice('edit_'.length) as keyof FilterConfig;
      if (!NUMERIC_FIELDS.includes(field)) return;
      awaitingInput.set(chatId, { field, menuMessageId: messageId });
      const cfg = loadFilters();
      return edit(
        `<b>${FIELD_LABEL[field]}</b>\nCurrent: ${fmtVal(cfg[field] as any)}\n\n` +
          `Reply with a new number, or "off" to clear it.`,
        { inline_keyboard: [[{ text: '‹ Cancel', callback_data: 'menu_filters' }]] },
      );
    }
  });

  // Captures the typed reply after tapping a filter field. Runs for every
  // message, so it must ignore anything that isn't a pending numeric edit
  // (slash commands are handled separately by onText below).
  bot.on('message', (msg) => {
    if (!msg.text || msg.text.startsWith('/')) return;
    const pending = awaitingInput.get(msg.chat.id);
    if (!pending) return;
    awaitingInput.delete(msg.chat.id);

    const raw = msg.text.trim();
    let value: number | null;
    if (raw.toLowerCase() === 'off' || raw.toLowerCase() === 'null') {
      value = null;
    } else {
      const n = Number(raw);
      if (Number.isNaN(n)) {
        bot!.sendMessage(msg.chat.id, `"${raw}" isn't a number. Try again from the menu.`);
        return;
      }
      value = n;
    }

    const cfg = loadFilters();
    (cfg as any)[pending.field] = value;
    saveFilters(cfg);

    bot!
      .editMessageText(filtersText(cfg), {
        chat_id: msg.chat.id,
        message_id: pending.menuMessageId,
        parse_mode: 'HTML',
        reply_markup: filtersKeyboard(cfg),
      })
      .catch(() => {});
  });

  bot.onText(/\/setfunding (.+)/, (msg, match) => {
    const raw = match?.[1]?.trim();
    const cfg = loadFilters();
    cfg.allowedFundingSources =
      !raw || raw.toLowerCase() === 'none' ? null : raw.split(',').map((s) => s.trim()).filter(Boolean);
    saveFilters(cfg);
    bot!.sendMessage(msg.chat.id, `Allowed funding sources: ${cfg.allowedFundingSources?.join(', ') ?? 'any'}`);
  });

  bot.onText(/\/resetfunding/, (msg) => {
    const cfg = loadFilters();
    cfg.allowedFundingSources = null;
    saveFilters(cfg);
    bot!.sendMessage(msg.chat.id, 'Funding-source restriction cleared.');
  });

  bot.onText(/\/resetfilters/, (msg) => {
    saveFilters({ ...DEFAULT_FILTERS });
    bot!.sendMessage(msg.chat.id, 'Filters reset to defaults.');
  });

  bot.onText(/\/status/, (msg) => {
    bot!.sendMessage(msg.chat.id, statusText(), { parse_mode: 'HTML' });
  });

  bot.onText(/\/getfilters/, (msg) => {
    bot!.sendMessage(msg.chat.id, filtersText(loadFilters()), { parse_mode: 'HTML' });
  });

  bot.onText(/\/setfilters (\w+) (\S+)/, (msg, match) => {
    const key = match?.[1] as keyof FilterConfig;
    const raw = match?.[2];
    if (!key || !NUMERIC_FIELDS.includes(key)) {
      bot!.sendMessage(msg.chat.id, `Unknown field. Valid: ${NUMERIC_FIELDS.join(', ')}`);
      return;
    }
    const cfg = loadFilters();
    let value: any;
    if (raw === 'null' || raw === 'off') value = null;
    else value = Number(raw);
    (cfg as any)[key] = value;
    saveFilters(cfg);
    bot!.sendMessage(msg.chat.id, `Set ${key} = ${value}`);
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
    bot!.sendMessage(msg.chat.id, `<pre>${JSON.stringify(shape, null, 2).slice(0, 3500)}</pre>`, {
      parse_mode: 'HTML',
    });
  });

  console.log('[telegram] bot menu active: /start for buttons, /help for commands');
  return bot;
}
