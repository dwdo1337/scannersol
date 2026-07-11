// Whitelist/paywall foundation. Mirrors configStore.ts's durability
// pattern: SQLite is a same-process warm-start cache (does NOT survive a
// Render redeploy - ephemeral disk), Upstash Redis (REST API, free tier)
// is the actual durable copy. Each user is stored under its own Redis key
// plus a set index, since (unlike filters) this is a dynamic collection
// rather than one blob.
import db from './db.js';

export type UserStatus = 'pending' | 'active' | 'revoked';

export interface WhitelistUser {
  chatId: string;
  status: UserStatus;
  tier: string | null;
  expiresAt: number | null; // unix seconds, null = no expiry
  referredBy: string | null;
  createdAt: number;
}

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const redisEnabled = Boolean(UPSTASH_URL && UPSTASH_TOKEN);
const INDEX_KEY = 'users:index';

const cache = new Map<string, WhitelistUser>();

const upsertStmt = db.prepare(`
  INSERT INTO users (chat_id, status, tier, expires_at, referred_by, created_at)
  VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT(chat_id) DO UPDATE SET
    status = excluded.status,
    tier = excluded.tier,
    expires_at = excluded.expires_at,
    referred_by = excluded.referred_by
`);
const allLocalStmt = db.prepare('SELECT * FROM users');

function rowToUser(row: any): WhitelistUser {
  return {
    chatId: row.chat_id,
    status: row.status,
    tier: row.tier,
    expiresAt: row.expires_at,
    referredBy: row.referred_by,
    createdAt: row.created_at,
  };
}

function writeLocal(u: WhitelistUser) {
  upsertStmt.run(u.chatId, u.status, u.tier, u.expiresAt, u.referredBy, u.createdAt);
}

async function redisFetch(path: string, init?: RequestInit): Promise<any> {
  const res = await fetch(`${UPSTASH_URL}/${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${UPSTASH_TOKEN}`, ...(init?.headers ?? {}) },
  });
  if (!res.ok) throw new Error(`Upstash ${path} -> ${res.status}`);
  return res.json();
}

async function redisSetUser(u: WhitelistUser): Promise<void> {
  if (!redisEnabled) return;
  try {
    await redisFetch(`set/user:${u.chatId}`, { method: 'POST', body: JSON.stringify(u) });
    await redisFetch(`sadd/${INDEX_KEY}/${u.chatId}`, { method: 'POST' });
  } catch (err) {
    console.error('[userStore] Upstash write failed, user only persisted locally for now:', err);
  }
}

async function redisLoadAll(): Promise<WhitelistUser[]> {
  if (!redisEnabled) return [];
  try {
    const idx = (await redisFetch(`smembers/${INDEX_KEY}`)) as { result: string[] };
    const ids = idx.result ?? [];
    const users: WhitelistUser[] = [];
    for (const id of ids) {
      const r = (await redisFetch(`get/user:${id}`)) as { result: string | null };
      if (r.result) users.push(JSON.parse(r.result));
    }
    return users;
  } catch (err) {
    console.error('[userStore] Upstash load failed, falling back to local cache:', err);
    return [];
  }
}

/** Call once at startup, before the bot begins handling messages. */
export async function initUsers(): Promise<void> {
  for (const row of allLocalStmt.all()) cache.set((row as any).chat_id, rowToUser(row));

  if (!redisEnabled) {
    console.log('[userStore] UPSTASH not set - whitelist will NOT survive redeploys.');
    return;
  }
  const remote = await redisLoadAll();
  if (remote.length > 0) {
    for (const u of remote) {
      cache.set(u.chatId, u);
      writeLocal(u);
    }
    console.log(`[userStore] Loaded ${remote.length} whitelist user(s) from Upstash Redis.`);
  } else {
    console.log('[userStore] No whitelist users in Upstash yet.');
  }
}

export function getUser(chatId: string): WhitelistUser | null {
  return cache.get(chatId) ?? null;
}

export function listUsers(): WhitelistUser[] {
  return [...cache.values()].sort((a, b) => b.createdAt - a.createdAt);
}

export function isWhitelisted(chatId: string): boolean {
  const u = cache.get(chatId);
  if (!u || u.status !== 'active') return false;
  if (u.expiresAt != null && u.expiresAt < Date.now() / 1000) return false;
  return true;
}

/** Approve or extend a user. daysValid=null means no expiry. */
export function approveUser(chatId: string, daysValid: number | null, tier: string | null = null): WhitelistUser {
  const existing = cache.get(chatId);
  const u: WhitelistUser = {
    chatId,
    status: 'active',
    tier: tier ?? existing?.tier ?? null,
    expiresAt: daysValid != null ? Math.floor(Date.now() / 1000) + daysValid * 86400 : null,
    referredBy: existing?.referredBy ?? null,
    createdAt: existing?.createdAt ?? Math.floor(Date.now() / 1000),
  };
  cache.set(chatId, u);
  writeLocal(u);
  void redisSetUser(u);
  return u;
}

export function revokeUser(chatId: string): WhitelistUser | null {
  const existing = cache.get(chatId);
  if (!existing) return null;
  const u: WhitelistUser = { ...existing, status: 'revoked' };
  cache.set(chatId, u);
  writeLocal(u);
  void redisSetUser(u);
  return u;
}

/** Register a pending (not-yet-approved) user, e.g. on first /start, so
 * referral chains and future approval have something to attach to. */
export function registerPending(chatId: string, referredBy: string | null = null): WhitelistUser {
  if (cache.has(chatId)) return cache.get(chatId)!;
  const u: WhitelistUser = {
    chatId,
    status: 'pending',
    tier: null,
    expiresAt: null,
    referredBy,
    createdAt: Math.floor(Date.now() / 1000),
  };
  cache.set(chatId, u);
  writeLocal(u);
  void redisSetUser(u);
  return u;
}
