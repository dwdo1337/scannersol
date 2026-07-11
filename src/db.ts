import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const db = new DatabaseSync(path.join(__dirname, '..', 'freshie.db'));

db.exec('PRAGMA journal_mode = WAL;');

db.exec(`
  CREATE TABLE IF NOT EXISTS wallets_cache (
    address TEXT PRIMARY KEY,
    first_seen INTEGER,
    tx_count INTEGER,
    funded_by TEXT,
    funded_label TEXT,
    funded_resolved INTEGER NOT NULL DEFAULT 1,
    last_checked INTEGER NOT NULL
  );
`);

// Migration: older DBs won't have funded_resolved yet.
try {
  db.exec(`ALTER TABLE wallets_cache ADD COLUMN funded_resolved INTEGER NOT NULL DEFAULT 1;`);
} catch {
  // column already exists, ignore
}

// Migration: older DBs won't have funded_at yet - needed for the
// funding-window filters (minMinutesSinceFunding / maxMinutesSinceFunding).
try {
  db.exec(`ALTER TABLE wallets_cache ADD COLUMN funded_at INTEGER;`);
} catch {
  // column already exists, ignore
}

db.exec(`

  CREATE TABLE IF NOT EXISTS alerts_sent (
    wallet TEXT NOT NULL,
    mint TEXT,
    sent_at INTEGER NOT NULL,
    PRIMARY KEY (wallet, mint)
  );

  CREATE TABLE IF NOT EXISTS config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS users (
    chat_id TEXT PRIMARY KEY,
    status TEXT NOT NULL DEFAULT 'pending',
    tier TEXT,
    expires_at INTEGER,
    referred_by TEXT,
    created_at INTEGER NOT NULL
  );
`);

export default db;
