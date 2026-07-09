import db from './db.js';

export interface CachedWallet {
  address: string;
  first_seen: number | null;
  tx_count: number | null;
  funded_by: string | null;
  funded_label: string | null;
  funded_at: number | null; // unix seconds - when the wallet received its first inbound SOL
  funded_resolved: number; // 0/1 - was the CEX/funding lookup actually resolved (not a transient failure)
  last_checked: number;
}

const CACHE_TTL_MS = 10 * 60 * 1000; // re-check a wallet after 10 min

const getStmt = db.prepare('SELECT * FROM wallets_cache WHERE address = ?');
const upsertStmt = db.prepare(`
  INSERT INTO wallets_cache (address, first_seen, tx_count, funded_by, funded_label, funded_at, funded_resolved, last_checked)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(address) DO UPDATE SET
    first_seen = excluded.first_seen,
    tx_count = excluded.tx_count,
    funded_by = excluded.funded_by,
    funded_label = excluded.funded_label,
    funded_at = excluded.funded_at,
    funded_resolved = excluded.funded_resolved,
    last_checked = excluded.last_checked
`);

export function getCachedWallet(address: string): CachedWallet | null {
  const row = getStmt.get(address) as CachedWallet | undefined;
  if (!row) return null;
  if (Date.now() - row.last_checked > CACHE_TTL_MS) return null; // stale, force recheck
  return row;
}

export function saveWalletCache(w: Omit<CachedWallet, 'last_checked'>) {
  upsertStmt.run(
    w.address,
    w.first_seen,
    w.tx_count,
    w.funded_by,
    w.funded_label,
    w.funded_at,
    w.funded_resolved,
    Date.now(),
  );
}
