import db from './db.js';
import { DEFAULT_FILTERS, FilterConfig } from './filters.js';

const KEY = 'active_filters';

const getStmt = db.prepare('SELECT value FROM config WHERE key = ?');
const setStmt = db.prepare(
  'INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
);

// --- Local SQLite is still written on every save as a same-process cache
// warm-start, but it lives on Render's ephemeral disk and does NOT survive
// a redeploy. Upstash Redis (REST API, free tier) is the durable copy.
// Reads never hit the network - pipeline.ts calls loadFilters() per swap,
// so this stays an in-memory cache refreshed only at startup and on save.

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const redisEnabled = Boolean(UPSTASH_URL && UPSTASH_TOKEN);

function readLocal(): FilterConfig {
  const row = getStmt.get(KEY) as { value: string } | undefined;
  if (!row) return { ...DEFAULT_FILTERS };
  try {
    return { ...DEFAULT_FILTERS, ...JSON.parse(row.value) };
  } catch {
    return { ...DEFAULT_FILTERS };
  }
}

function writeLocal(cfg: FilterConfig) {
  setStmt.run(KEY, JSON.stringify(cfg));
}

let cache: FilterConfig = readLocal();

async function redisGet(): Promise<FilterConfig | null> {
  if (!redisEnabled) return null;
  try {
    const res = await fetch(`${UPSTASH_URL}/get/${KEY}`, {
      headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
    });
    if (!res.ok) throw new Error(`Upstash GET ${res.status}`);
    const body = (await res.json()) as { result: string | null };
    if (!body.result) return null;
    return { ...DEFAULT_FILTERS, ...JSON.parse(body.result) };
  } catch (err) {
    console.error('[configStore] Upstash GET failed, falling back to local cache:', err);
    return null;
  }
}

async function redisSet(cfg: FilterConfig): Promise<void> {
  if (!redisEnabled) return;
  try {
    const res = await fetch(`${UPSTASH_URL}/set/${KEY}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${UPSTASH_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(JSON.stringify(cfg)),
    });
    if (!res.ok) throw new Error(`Upstash SET ${res.status}`);
  } catch (err) {
    console.error('[configStore] Upstash SET failed, config only persisted locally for now:', err);
  }
}

/** Call once at startup, before the pipeline/bot begin reading filters. */
export async function initFilters(): Promise<void> {
  if (!redisEnabled) {
    console.log('[configStore] UPSTASH_REDIS_REST_URL/TOKEN not set - filter config will NOT survive redeploys.');
    return;
  }
  const remote = await redisGet();
  if (remote) {
    cache = remote;
    writeLocal(remote);
    console.log('[configStore] Loaded filter config from Upstash Redis.');
  } else {
    await redisSet(cache);
    console.log('[configStore] No config in Upstash yet - seeded from local/default.');
  }
}

export function loadFilters(): FilterConfig {
  return cache;
}

export function saveFilters(cfg: FilterConfig) {
  cache = cfg;
  writeLocal(cfg);
  void redisSet(cfg);
}
