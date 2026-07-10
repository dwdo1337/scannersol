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

// ---- field metadata, grouped like a real product's Settings screen
// (freshness / funding / token safety / cluster) instead of one flat list ----
const FRESHNESS_FIELDS: (keyof FilterConfig)[] = ['maxTxCount', 'maxWalletAgeMin'];
const BUY_FIELDS: (keyof FilterConfig)[] = ['minBuySol', 'maxBuySol', 'minBuyRank'];
const FUNDING_FIELDS: (keyof FilterConfig)[] = ['minMinutesSinceFunding', 'maxMinutesSinceFunding'];
const SAFETY_NUMERIC_FIELDS: (keyof FilterConfig)[] = [
  'maxTopHolderPct',
  'maxDevHolderPct',
  'minLiquidityUsd',
  'minTokenAgeSec',
  'maxTokenAgeSec',
];
const SAFETY_BOOL_FIELDS: (keyof FilterConfig)[] = ['requireMintRevoked', 'requireFreezeRevoked'];
const CLUSTER_FIELDS: (keyof FilterConfig)[] = ['minClusterSize', 'clusterWindowMin'];
const SCORE_FIELDS: (keyof FilterConfig)[] = ['minScore'];

const NUMERIC_FIELDS: (keyof FilterConfig)[] = [
  ...FRESHNESS_FIELDS,
  ...BUY_FIELDS,
  ...FUNDING_FIELDS,
  ...SAFETY_NUMERIC_FIELDS,
  ...CLUSTER_FIELDS,
  ...SCORE_FIELDS,
  'maxAlertsPerMin',
];

const FIELD_LABEL: Record<string, string> = {
  maxTxCount: 'Max tx count',
  maxWalletAgeMin: 'Max wallet age (min)',
  minBuySol: 'Min buy (SOL)',
  maxBuySol: 'Max buy (SOL)',
  minBuyRank: 'Max buy rank (1st..Nth buyer)',
  minMinutesSinceFunding: 'Min mins since funding',
  maxMinutesSinceFunding: 'Max mins since funding',
  maxTopHolderPct: 'Max top-10 holder %',
  maxDevHolderPct: 'Max largest-holder %',
  minLiquidityUsd: 'Min liquidity (USD)',
  minTokenAgeSec: 'Min token age (sec)',
  maxTokenAgeSec: 'Max token age (sec)',
  requireMintRevoked: 'Require mint revoked',
  requireFreezeRevoked: 'Require freeze revoked',
  minClusterSize: 'Min cluster size (sybil)',
  clusterWindowMin: 'Cluster window (min)',
  minScore: 'Min composite score',
  maxAlertsPerMin: 'Max alerts/min',
};

const KNOWN_EXCHANGES = ['Binance', 'Coinbase', 'OKX', 'Bybit', 'Kraken', 'KuCoin', 'Gate.io', 'MEXC'];

// name -> partial filter values. Timing window is the core "insider setup"
// signal; presets also now tune token safety and score floors, not just
// wallet freshness, so "aggressive" doesn't mean "no rug filter at all".
const PRESETS: Record<string, Partial<FilterConfig>> = {
  conservative: {
    maxTxCount: 3,
    maxWalletAgeMin: 30,
    minBuySol: 0.1,
    maxBuySol: null,
    maxMinutesSinceFunding: 15,
    requireMintRevoked: true,
    requireFreezeRevoked: true,
    maxTopHolderPct: 25,
    minLiquidityUsd: 10000,
    minScore: 65,
  },
  balanced: {
    maxTxCount: 5,
    maxWalletAgeMin: 60,
    minBuySol: 0.05,
    maxBuySol: null,
    maxMinutesSinceFunding: 30,
    requireMintRevoked: true,
    requireFreezeRevoked: false,
    maxTopHolderPct: 40,
    minLiquidityUsd: 5000,
    minScore: 45,
  },
  aggressive: {
    maxTxCount: 10,
    maxWalletAgeMin: 180,
    minBuySol: 0.02,
    maxBuySol: null,
    maxMinutesSinceFunding: 120,
    requireMintRevoked: false,
    requireFreezeRevoked: false,
    maxTopHolderPct: null,
    minLiquidityUsd: null,
    minScore: null,
  },
};

const awaitingInput = new Map<number, { field: keyof FilterConfig; menuMessageId: number }>();

function fmtVal(v: number | string | boolean | null): string {
  if (v === null || v === undefined) return 'off';
  if (typeof v === 'boolean') return v ? 'on' : 'off';
  return String(v);
}

function mainText(): string {
  return (
    '<b>freshieTG</b>\n' +
    'Fresh Solana wallet tracker — watches DEX activity chain-wide and ' +
    'alerts on freshly-funded wallets buying into safe-looking tokens.\n\n' +
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
  return (
    `<b>⚙️ Alert Rules</b>\n` +
    `Score gate: <b>${fmtVal(cfg.minScore)}</b> • Max alerts/min: <b>${cfg.maxAlertsPerMin}</b>\n\n` +
    `Pick a category to tune, or jump to a preset.`
  );
}

function filtersKeyboard() {
  return {
    inline_keyboard: [
      [{ text: '🧊 Freshness ›', callback_data: 'menu_freshness' }, { text: '🐋 Buy signal ›', callback_data: 'menu_buy' }],
      [{ text: '💰 Funding ›', callback_data: 'menu_funding' }, { text: '🏦 Funding sources ›', callback_data: 'menu_fundingsrc' }],
      [{ text: '🪙 Token safety ›', callback_data: 'menu_safety' }, { text: '🕸 Cluster ›', callback_data: 'menu_cluster' }],
      [{ text: '🚦 Score gate ›', callback_data: 'menu_score' }],
      [{ text: '🎚 Presets ›', callback_data: 'menu_presets' }],
      [
        { text: '↩️ Reset all', callback_data: 'confirm_reset' },
        { text: '‹ Back', callback_data: 'menu_main' },
      ],
    ],
  };
}

// Generic category submenu builder: title, description, numeric fields to
// show as toggle-to-edit buttons, plus optional boolean fields rendered as
// on/off toggles (immediate flip, no typed input needed).
function categoryKeyboard(cfg: FilterConfig, numericFields: (keyof FilterConfig)[], boolFields: (keyof FilterConfig)[] = []) {
  const rows: any[] = [];
  for (let i = 0; i < numericFields.length; i += 2) {
    rows.push(
      numericFields.slice(i, i + 2).map((f) => ({
        text: `${FIELD_LABEL[f]}: ${fmtVal(cfg[f] as any)}`,
        callback_data: `edit_${f}`,
      })),
    );
  }
  for (const f of boolFields) {
    rows.push([{ text: `${FIELD_LABEL[f]}: ${fmtVal(cfg[f] as any)}`, callback_data: `bool_toggle_${f}` }]);
  }
  rows.push([{ text: '‹ Back to filters', callback_data: 'menu_filters' }]);
  return { inline_keyboard: rows };
}

function categoryText(title: string, desc: string): string {
  return `<b>${title}</b>\n${desc}`;
}

function fundingSrcText(cfg: FilterConfig): string {
  const src = cfg.allowedFundingSources?.length ? cfg.allowedFundingSources.join(', ') : 'any';
  return `<b>🏦 Funding Sources</b>\nOnly alert on wallets funded from these exchanges. Tap to toggle.\n\nCurrently: <b>${src}</b>`;
}

function fundingSrcKeyboard(cfg: FilterConfig) {
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
    '🐢 <b>Conservative</b> — tight window, requires revoked mint/freeze, low top-holder %, score ≥65\n' +
    '⚖️ <b>Balanced</b> — moderate window, requires revoked mint, score ≥45\n' +
    '🚀 <b>Aggressive</b> — wide window, no safety requirements, catches more, noisier'
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
  'field lets you type a new number directly; boolean fields and funding ' +
  'sources toggle on tap.\n\n' +
  '<b>Commands (for scripting):</b>\n' +
  '/status — pipeline stats\n' +
  '/getfilters — current filters\n' +
  '/setfilters &lt;field&gt; &lt;value&gt; — set one filter, "null"/"off" clears it\n' +
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
    if (data === 'menu_filters') return edit(filtersText(loadFilters()), filtersKeyboard());
    if (data === 'menu_status') return edit(statusText(), backKeyboard());
    if (data === 'menu_help') return edit(HELP_TEXT, backKeyboard());

    if (data === 'menu_freshness')
      return edit(
        categoryText('🧊 Freshness', 'How new the wallet itself needs to be.'),
        categoryKeyboard(loadFilters(), FRESHNESS_FIELDS),
      );
    if (data === 'menu_buy')
      return edit(
        categoryText('🐋 Buy signal', 'Size and rank of the buy itself.'),
        categoryKeyboard(loadFilters(), BUY_FIELDS),
      );
    if (data === 'menu_funding')
      return edit(
        categoryText('💰 Funding window', 'Time between the wallet being funded and this buy — tight windows read as "cashed in specifically for this".'),
        categoryKeyboard(loadFilters(), FUNDING_FIELDS),
      );
    if (data === 'menu_fundingsrc') return edit(fundingSrcText(loadFilters()), fundingSrcKeyboard(loadFilters()));
    if (data === 'menu_safety')
      return edit(
        categoryText('🪙 Token safety', 'Rug-resistance checks on the token being bought, not the wallet.'),
        categoryKeyboard(loadFilters(), SAFETY_NUMERIC_FIELDS, SAFETY_BOOL_FIELDS),
      );
    if (data === 'menu_cluster')
      return edit(
        categoryText('🕸 Cluster / sybil', 'Flags coordinated buying: same funder feeding multiple fresh wallets into one token.'),
        categoryKeyboard(loadFilters(), CLUSTER_FIELDS),
      );
    if (data === 'menu_score')
      return edit(
        categoryText('🚦 Composite score', 'One 0-100 number combining freshness+funding+safety+cluster. Set a floor instead of tuning every field.'),
        categoryKeyboard(loadFilters(), SCORE_FIELDS),
      );
    if (data === 'menu_presets') return edit(presetsText(), presetsKeyboard());

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
      return edit(filtersText(loadFilters()), filtersKeyboard());
    }

    if (data.startsWith('preset_')) {
      const name = data.slice('preset_'.length);
      const preset = PRESETS[name];
      if (preset) saveFilters({ ...loadFilters(), ...preset });
      return edit(filtersText(loadFilters()), filtersKeyboard());
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
      return edit(fundingSrcText(cfg), fundingSrcKeyboard(cfg));
    }
    if (data === 'fund_clear') {
      const cfg = loadFilters();
      cfg.allowedFundingSources = null;
      saveFilters(cfg);
      return edit(fundingSrcText(cfg), fundingSrcKeyboard(cfg));
    }

    if (data.startsWith('bool_toggle_')) {
      const field = data.slice('bool_toggle_'.length) as keyof FilterConfig;
      const cfg = loadFilters();
      (cfg as any)[field] = !(cfg as any)[field];
      saveFilters(cfg);
      // Re-render whichever category owns this field so the toggle is visible immediately.
      if (SAFETY_BOOL_FIELDS.includes(field)) {
        return edit(
          categoryText('🪙 Token safety', 'Rug-resistance checks on the token being bought, not the wallet.'),
          categoryKeyboard(cfg, SAFETY_NUMERIC_FIELDS, SAFETY_BOOL_FIELDS),
        );
      }
      return edit(filtersText(cfg), filtersKeyboard());
    }

    if (data.startsWith('edit_')) {
      const field = data.slice('edit_'.length) as keyof FilterConfig;
      if (!NUMERIC_FIELDS.includes(field)) return;
      awaitingInput.set(chatId, { field, menuMessageId: messageId });
      const label = FIELD_LABEL[field] ?? field;
      const cfg = loadFilters();
      return bot!
        .sendMessage(
          chatId,
          `Send a new value for <b>${label}</b> (current: ${fmtVal(cfg[field] as any)}).\n` +
            `Send <code>off</code> or <code>null</code> to clear it.`,
          { parse_mode: 'HTML' },
        )
        .catch(() => {});
    }
  });

  // Typed replies for numeric field edits opened via the inline "edit_" buttons above.
  bot.on('message', (msg) => {
    const chatId = msg.chat.id;
    const pending = awaitingInput.get(chatId);
    if (!pending || !msg.text) return;
    if (msg.text.startsWith('/')) return; // let onText handlers deal with commands

    awaitingInput.delete(chatId);
    const raw = msg.text.trim().toLowerCase();
    const cfg = loadFilters();

    if (raw === 'off' || raw === 'null' || raw === 'none') {
      (cfg as any)[pending.field] = null;
    } else {
      const num = Number(msg.text.trim());
      if (Number.isNaN(num)) {
        bot!.sendMessage(chatId, `That is not a number, Sir — value left unchanged.`).catch(() => {});
        return;
      }
      (cfg as any)[pending.field] = num;
    }
    saveFilters(cfg);

    bot!
      .sendMessage(chatId, `<b>${FIELD_LABEL[pending.field]}</b> set to <b>${fmtVal((cfg as any)[pending.field])}</b>.`, {
        parse_mode: 'HTML',
      })
      .catch(() => {});

    // Refresh the original menu message in place, if it's still the same one.
    bot!
      .editMessageText(filtersText(cfg), {
        chat_id: chatId,
        message_id: pending.menuMessageId,
        parse_mode: 'HTML',
        reply_markup: filtersKeyboard(),
      })
      .catch(() => {});
  });

  bot.onText(/\/status/, (msg) => {
    bot!.sendMessage(msg.chat.id, statusText(), { parse_mode: 'HTML' });
  });

  bot.onText(/\/getfilters/, (msg) => {
    const cfg = loadFilters();
    const lines = (Object.keys(FIELD_LABEL) as (keyof FilterConfig)[])
      .map((f) => `${FIELD_LABEL[f]}: <b>${fmtVal(cfg[f] as any)}</b>`)
      .join('\n');
    const src = cfg.allowedFundingSources?.length ? cfg.allowedFundingSources.join(', ') : 'any';
    bot!.sendMessage(msg.chat.id, `<b>Current filters</b>\n${lines}\nFunding sources: <b>${src}</b>`, {
      parse_mode: 'HTML',
    });
  });

  bot.onText(/\/setfilters (\S+) (\S+)/, (msg, match) => {
    if (!match) return;
    const field = match[1] as keyof FilterConfig;
    const valueRaw = match[2].toLowerCase();
    if (!NUMERIC_FIELDS.includes(field) && !SAFETY_BOOL_FIELDS.includes(field)) {
      bot!.sendMessage(msg.chat.id, `Unknown field: ${match[1]}`);
      return;
    }
    const cfg = loadFilters();
    if (SAFETY_BOOL_FIELDS.includes(field)) {
      (cfg as any)[field] = valueRaw === 'true' || valueRaw === 'on' || valueRaw === '1';
    } else if (valueRaw === 'off' || valueRaw === 'null' || valueRaw === 'none') {
      (cfg as any)[field] = null;
    } else {
      const num = Number(valueRaw);
      if (Number.isNaN(num)) {
        bot!.sendMessage(msg.chat.id, `Not a number: ${match[2]}`);
        return;
      }
      (cfg as any)[field] = num;
    }
    saveFilters(cfg);
    bot!.sendMessage(msg.chat.id, `${FIELD_LABEL[field] ?? field} set to ${fmtVal((cfg as any)[field])}.`);
  });

  bot.onText(/\/setfunding (.+)/, (msg, match) => {
    if (!match) return;
    const list = match[1]
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const cfg = loadFilters();
    cfg.allowedFundingSources = list.length ? list : null;
    saveFilters(cfg);
    bot!.sendMessage(msg.chat.id, `Funding sources set to: ${list.length ? list.join(', ') : 'any'}`);
  });

  bot.onText(/\/resetfunding/, (msg) => {
    const cfg = loadFilters();
    cfg.allowedFundingSources = null;
    saveFilters(cfg);
    bot!.sendMessage(msg.chat.id, 'Funding source restriction cleared.');
  });

  bot.onText(/\/resetfilters/, (msg) => {
    saveFilters({ ...DEFAULT_FILTERS });
    bot!.sendMessage(msg.chat.id, 'Filters reset to defaults.');
  });

  console.log('[telegram] bot polling started');
  return bot;
}

export function getBot() {
  return bot;
}
