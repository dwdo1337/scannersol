import TelegramBot from 'node-telegram-bot-api';
import { TELEGRAM_BOT_TOKEN } from './config.js';
import { loadFilters, saveFilters } from './configStore.js';
import { DEFAULT_FILTERS, FilterConfig } from './filters.js';
import { getFailedSamples } from './webhookServer.js';
import { TELEGRAM_CHAT_ID } from './config.js';
import { approveUser, revokeUser, listUsers, registerPending } from './userStore.js';

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
const FRESHNESS_FIELDS: (keyof FilterConfig)[] = ['maxTxCount', 'minWalletAgeMin', 'maxWalletAgeMin'];
const BUY_FIELDS: (keyof FilterConfig)[] = ['minBuySol', 'maxBuySol', 'minBuyRank', 'minPoolImpactPct', 'maxPoolImpactPct'];
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
  minWalletAgeMin: 'Min wallet age (min)',
  maxWalletAgeMin: 'Max wallet age (min)',
  minBuySol: 'Min buy (SOL)',
  maxBuySol: 'Max buy (SOL)',
  minBuyRank: 'Max buy rank (1st..Nth buyer)',
  minPoolImpactPct: 'Min buy size (% of pool)',
  maxPoolImpactPct: 'Max buy size (% of pool)',
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

const FIELD_DESC: Record<string, string> = {
  maxTxCount: 'Reject wallets with this many or more total transactions - keeps only wallets with very little on-chain history.',
  minWalletAgeMin: 'Wallet must be at least this old. Filters out same-block/same-minute noise that is usually a bug or a bot, not a real fresh buyer.',
  maxWalletAgeMin: 'Wallet must have been first seen more recently than this. Lower = stricter "brand new" requirement.',
  minBuySol: 'Ignore buys smaller than this many SOL - cuts out dust transactions.',
  maxBuySol: 'Ignore buys larger than this many SOL - optional ceiling if you only want small/medium buys.',
  minBuyRank: 'Only alert if the wallet is among the first N buyers of the token (1 = first buyer ever).',
  minPoolImpactPct: 'Buy size as a % of pool liquidity depth (USD value of the buy vs current pool liquidity). Must be at least this % - filters out insignificant buys.',
  maxPoolImpactPct: 'Buy size as a % of pool liquidity depth. Must be under this % - filters out buys so large they are probably the dev/insider or will move price too much to matter.',
  minMinutesSinceFunding: 'Wallet must have been funded at least this many minutes before the buy.',
  maxMinutesSinceFunding: 'Wallet must have been funded within this many minutes of the buy - tight windows read as "funded specifically to make this trade".',
  maxTopHolderPct: 'Reject the token if its top 10 holders control more than this % of supply - high concentration = easy rug.',
  maxDevHolderPct: 'Reject the token if the single largest holder (usually the deployer) controls more than this % of supply.',
  minLiquidityUsd: 'Reject the token if its liquidity pool is worth less than this in USD - thin liquidity means big slippage and easy manipulation.',
  minTokenAgeSec: 'Token must have existed for at least this many seconds before the buy.',
  maxTokenAgeSec: 'Token must be no older than this many seconds - keeps you focused on brand-new launches.',
  requireMintRevoked: 'When on, only alert if the token creator has permanently given up the ability to mint new supply (mint authority revoked).',
  requireFreezeRevoked: 'When on, only alert if the token creator has permanently given up the ability to freeze wallets/transfers (freeze authority revoked).',
  minClusterSize: 'Only alert if at least this many other fresh wallets funded by the same source bought the same token - a sign of coordinated, non-organic buying.',
  clusterWindowMin: 'Time window (minutes) used to group buys into the same "cluster" for the check above.',
  minScore: 'Composite 0-100 score combining freshness, funding, safety and cluster signals. Set a floor here instead of tuning every field individually.',
  maxAlertsPerMin: 'Hard cap on how many alerts the bot will send per minute, regardless of how many matches it finds - protects you from a spam flood during a busy period.',
};

function fieldDescBlock(fields: (keyof FilterConfig)[]): string {
  return fields.map((f) => `• <b>${FIELD_LABEL[f] ?? f}</b> — ${FIELD_DESC[f] ?? 'no description yet'}`).join('\n');
}

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

// Single-admin gate: only the account whose chat ID matches TELEGRAM_CHAT_ID
// (i.e. Sir) may open the config menu or mutate filters. Everyone else is
// a future whitelisted/paying user once that system exists - for now they
// get a plain, non-informative decline so the bot doesn't look "broken",
// it looks intentionally closed.
function isAdmin(chatId: number): boolean {
  return String(chatId) === TELEGRAM_CHAT_ID;
}

const NOT_OPEN_TEXT = 'This bot is not open to the public yet. Check back soon.';

function fmtVal(v: number | string | boolean | null): string {
  if (v === null || v === undefined) return 'off';
  if (typeof v === 'boolean') return v ? 'on' : 'off';
  return String(v);
}

// BOLT-style traffic-light dot for on/off state, so a toggle reads at a
// glance without parsing text - green means "requirement active", red
// means "not required". Used on the button label itself.
function dot(v: boolean): string {
  return v ? '🟢' : '🔴';
}

function mainText(): string {
  return (
    '<b>freshieTG</b>\n' +
    'Fresh Solana wallet tracker — watches DEX activity chain-wide and ' +
    'alerts on freshly-funded wallets buying into safe-looking tokens.\n\n' +
    '• <b>⚙️ Filters</b> — tune exactly which buys trigger an alert\n' +
    '• <b>📊 Status</b> — pipeline uptime and live counters\n' +
    '• <b>🎚 Presets</b> — one-tap starting points (conservative/balanced/aggressive)\n' +
    '• <b>🚦 Score gate</b> — set the single composite-score floor for alerts\n' +
    '• <b>❓ Help</b> — command reference\n\n' +
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
      [
        { text: '🎚 Presets', callback_data: 'menu_presets' },
        { text: '🚦 Score gate', callback_data: 'menu_score' },
      ],
      [{ text: '❓ Help', callback_data: 'menu_help' }],
    ],
  };
}

function filtersText(cfg: FilterConfig): string {
  return (
    `<b>⚙️ Alert Rules</b>\n` +
    `Score gate: <b>${fmtVal(cfg.minScore)}</b> • Max alerts/min: <b>${cfg.maxAlertsPerMin}</b>\n\n` +
    `• <b>🧊 Freshness</b> — how new the wallet itself needs to be\n` +
    `• <b>🐋 Buy signal</b> — size and rank of the buy itself\n` +
    `• <b>💰 Funding</b> — timing between wallet funding and the buy\n` +
    `• <b>🏦 Funding sources</b> — restrict to specific exchanges\n` +
    `• <b>🪙 Token safety</b> — rug-resistance checks on the token\n` +
    `• <b>🕸 Cluster</b> — coordinated/sybil buying detection\n` +
    `• <b>🚦 Score gate</b> — single composite-score floor\n\n` +
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
    rows.push([{ text: `${dot(Boolean(cfg[f]))} ${FIELD_LABEL[f]}`, callback_data: `bool_toggle_${f}` }]);
  }
  rows.push([{ text: '‹ Back to filters', callback_data: 'menu_filters' }]);
  return { inline_keyboard: rows };
}

function categoryText(title: string, desc: string, fields: (keyof FilterConfig)[] = [], boolFields: (keyof FilterConfig)[] = []): string {
  const descBlock = fieldDescBlock([...fields, ...boolFields]);
  return `<b>${title}</b>\n${desc}${descBlock ? '\n\n' + descBlock : ''}`;
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
        text: `${dot(selected.has(ex.toLowerCase()))} ${ex}`,
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
      { command: 'approve', description: 'Whitelist a user: /approve <chat_id> [days]' },
      { command: 'revoke', description: 'Remove a user: /revoke <chat_id>' },
      { command: 'listusers', description: 'Show whitelist' },
    ])
    .catch((err) => console.error('[telegram] failed to register command menu:', err));

  bot.onText(/\/start(?:\s+(\S+))?/, (msg, match) => {
    if (!isAdmin(msg.chat.id)) {
      // Track who has tried the bot, and the referral code they came in
      // with if any (deep-link payload after /start), so the whitelist
      // and future referral rewards have a real record to work from.
      const refPayload = match?.[1]?.startsWith('ref_') ? match[1].slice('ref_'.length) : null;
      registerPending(String(msg.chat.id), refPayload);
      bot!.sendMessage(msg.chat.id, NOT_OPEN_TEXT).catch(() => {});
      return;
    }
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
    if (!isAdmin(chatId)) return;
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
        categoryText('🧊 Freshness', 'How new the wallet itself needs to be.', FRESHNESS_FIELDS),
        categoryKeyboard(loadFilters(), FRESHNESS_FIELDS),
      );
    if (data === 'menu_buy')
      return edit(
        categoryText('🐋 Buy signal', 'Size and rank of the buy itself.', BUY_FIELDS),
        categoryKeyboard(loadFilters(), BUY_FIELDS),
      );
    if (data === 'menu_funding')
      return edit(
        categoryText('💰 Funding window', 'Time between the wallet being funded and this buy — tight windows read as "cashed in specifically for this".', FUNDING_FIELDS),
        categoryKeyboard(loadFilters(), FUNDING_FIELDS),
      );
    if (data === 'menu_fundingsrc') return edit(fundingSrcText(loadFilters()), fundingSrcKeyboard(loadFilters()));
    if (data === 'menu_safety')
      return edit(
        categoryText('🪙 Token safety', 'Rug-resistance checks on the token being bought, not the wallet.', SAFETY_NUMERIC_FIELDS, SAFETY_BOOL_FIELDS),
        categoryKeyboard(loadFilters(), SAFETY_NUMERIC_FIELDS, SAFETY_BOOL_FIELDS),
      );
    if (data === 'menu_cluster')
      return edit(
        categoryText('🕸 Cluster / sybil', 'Flags coordinated buying: same funder feeding multiple fresh wallets into one token.', CLUSTER_FIELDS),
        categoryKeyboard(loadFilters(), CLUSTER_FIELDS),
      );
    if (data === 'menu_score')
      return edit(
        categoryText('🚦 Composite score', 'Optional single dial that replaces tuning every field by hand.', SCORE_FIELDS),
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
          categoryText('🪙 Token safety', 'Rug-resistance checks on the token being bought, not the wallet.', SAFETY_NUMERIC_FIELDS, SAFETY_BOOL_FIELDS),
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
    if (!isAdmin(chatId)) return;
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
    if (!isAdmin(msg.chat.id)) { bot!.sendMessage(msg.chat.id, NOT_OPEN_TEXT).catch(() => {}); return; }
    bot!.sendMessage(msg.chat.id, statusText(), { parse_mode: 'HTML' });
  });

  bot.onText(/\/getfilters/, (msg) => {
    if (!isAdmin(msg.chat.id)) { bot!.sendMessage(msg.chat.id, NOT_OPEN_TEXT).catch(() => {}); return; }
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
    if (!isAdmin(msg.chat.id)) { bot!.sendMessage(msg.chat.id, NOT_OPEN_TEXT).catch(() => {}); return; }
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
    if (!isAdmin(msg.chat.id)) { bot!.sendMessage(msg.chat.id, NOT_OPEN_TEXT).catch(() => {}); return; }
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
    if (!isAdmin(msg.chat.id)) { bot!.sendMessage(msg.chat.id, NOT_OPEN_TEXT).catch(() => {}); return; }
    const cfg = loadFilters();
    cfg.allowedFundingSources = null;
    saveFilters(cfg);
    bot!.sendMessage(msg.chat.id, 'Funding source restriction cleared.');
  });

  bot.onText(/\/resetfilters/, (msg) => {
    if (!isAdmin(msg.chat.id)) { bot!.sendMessage(msg.chat.id, NOT_OPEN_TEXT).catch(() => {}); return; }
    saveFilters({ ...DEFAULT_FILTERS });
    bot!.sendMessage(msg.chat.id, 'Filters reset to defaults.');
  });

  // ---- whitelist admin commands ----
  bot.onText(/\/approve (\S+)(?:\s+(\d+))?/, (msg, match) => {
    if (!isAdmin(msg.chat.id)) { bot!.sendMessage(msg.chat.id, NOT_OPEN_TEXT).catch(() => {}); return; }
    if (!match) return;
    const targetChatId = match[1];
    const days = match[2] ? Number(match[2]) : null;
    const u = approveUser(targetChatId, days);
    const expiry = u.expiresAt ? new Date(u.expiresAt * 1000).toISOString().slice(0, 10) : 'never';
    bot!.sendMessage(msg.chat.id, `Approved ${targetChatId} — expires: ${expiry}.`);
    bot!.sendMessage(targetChatId, "You're approved. Send /start to begin.").catch(() => {});
  });

  bot.onText(/\/revoke (\S+)/, (msg, match) => {
    if (!isAdmin(msg.chat.id)) { bot!.sendMessage(msg.chat.id, NOT_OPEN_TEXT).catch(() => {}); return; }
    if (!match) return;
    const u = revokeUser(match[1]);
    bot!.sendMessage(msg.chat.id, u ? `Revoked ${match[1]}.` : `No such user: ${match[1]}.`);
  });

  bot.onText(/\/listusers/, (msg) => {
    if (!isAdmin(msg.chat.id)) { bot!.sendMessage(msg.chat.id, NOT_OPEN_TEXT).catch(() => {}); return; }
    const users = listUsers();
    if (users.length === 0) {
      bot!.sendMessage(msg.chat.id, 'No whitelist entries yet.');
      return;
    }
    const lines = users
      .slice(0, 50)
      .map((u) => {
        const expiry = u.expiresAt ? new Date(u.expiresAt * 1000).toISOString().slice(0, 10) : 'no expiry';
        const ref = u.referredBy ? ` ref:${u.referredBy}` : '';
        return `${u.chatId} — ${u.status} (${expiry})${ref}`;
      })
      .join('\n');
    bot!.sendMessage(msg.chat.id, `<b>Whitelist (${users.length})</b>\n${lines}`, { parse_mode: 'HTML' });
  });

  console.log('[telegram] bot polling started');
  return bot;
}

export function getBot() {
  return bot;
}
