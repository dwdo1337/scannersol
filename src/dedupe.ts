import db from './db.js';

const DEDUPE_WINDOW_MS = 30 * 60 * 1000; // don't re-alert same wallet+mint within 30 min

const checkStmt = db.prepare(
  'SELECT sent_at FROM alerts_sent WHERE wallet = ? AND mint IS ?',
);
const insertStmt = db.prepare(
  'INSERT OR REPLACE INTO alerts_sent (wallet, mint, sent_at) VALUES (?, ?, ?)',
);

export function alreadyAlerted(wallet: string, mint: string | null): boolean {
  const row = checkStmt.get(wallet, mint) as { sent_at: number } | undefined;
  if (!row) return false;
  return Date.now() - row.sent_at < DEDUPE_WINDOW_MS;
}

export function markAlerted(wallet: string, mint: string | null) {
  insertStmt.run(wallet, mint, Date.now());
}
