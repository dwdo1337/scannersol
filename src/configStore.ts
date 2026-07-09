import db from './db.js';
import { DEFAULT_FILTERS, FilterConfig } from './filters.js';

const KEY = 'active_filters';

const getStmt = db.prepare('SELECT value FROM config WHERE key = ?');
const setStmt = db.prepare(
  'INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
);

export function loadFilters(): FilterConfig {
  const row = getStmt.get(KEY) as { value: string } | undefined;
  if (!row) return { ...DEFAULT_FILTERS };
  try {
    return { ...DEFAULT_FILTERS, ...JSON.parse(row.value) };
  } catch {
    return { ...DEFAULT_FILTERS };
  }
}

export function saveFilters(cfg: FilterConfig) {
  setStmt.run(KEY, JSON.stringify(cfg));
}
