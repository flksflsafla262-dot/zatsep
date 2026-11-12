import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DATA_DIR, DEFAULT_SETTINGS } from './config.js';
import { ensureDir, safeJson } from './util.js';

export const db = new DatabaseSync(path.join(DATA_DIR, 'zatsep.sqlite'));
db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');

db.exec(`
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  pass TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'friend',
  avatar INTEGER NOT NULL DEFAULT 0,
  must_change INTEGER NOT NULL DEFAULT 0,
  quota_gb REAL,
  quota_day INTEGER,
  created_at INTEGER NOT NULL,
  last_seen INTEGER
);
CREATE TABLE IF NOT EXISTS sessions(
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  ua TEXT
);
CREATE TABLE IF NOT EXISTS invites(
  code TEXT PRIMARY KEY,
  created_by INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_by INTEGER,
  used_at INTEGER
);
CREATE TABLE IF NOT EXISTS jobs(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  shared INTEGER NOT NULL DEFAULT 0,
  kind TEXT NOT NULL,
  url TEXT,
  opts TEXT,
  dedupe TEXT,
  status TEXT NOT NULL,
  progress REAL NOT NULL DEFAULT 0,
  speed REAL,
  eta REAL,
  title TEXT,
  uploader TEXT,
  album TEXT,
  duration REAL,
  thumb_url TEXT,
  has_thumb INTEGER NOT NULL DEFAULT 0,
  site TEXT,
  media TEXT,
  file TEXT,
  ext TEXT,
  size INTEGER NOT NULL DEFAULT 0,
  vcodec TEXT,
  acodec TEXT,
  width INTEGER,
  height INTEGER,
  compat TEXT NOT NULL DEFAULT 'none',
  compat_file TEXT,
  err_code TEXT,
  err_msg TEXT,
  log TEXT,
  meta TEXT,
  pos REAL NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS jobs_user ON jobs(user_id, created_at);
CREATE INDEX IF NOT EXISTS jobs_status ON jobs(status);
CREATE INDEX IF NOT EXISTS jobs_dedupe ON jobs(dedupe);
CREATE TABLE IF NOT EXISTS shares(
  token TEXT PRIMARY KEY,
  job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS playlists(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS playlist_items(
  playlist_id INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
  job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  pos INTEGER NOT NULL,
  PRIMARY KEY(playlist_id, job_id)
);
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT);
`);

const cache = new Map();
const stmt = (sql) => {
  let s = cache.get(sql);
  if (!s) { s = db.prepare(sql); cache.set(sql, s); }
  return s;
};
export const get = (sql, ...p) => stmt(sql).get(...p);
export const all = (sql, ...p) => stmt(sql).all(...p);
export const run = (sql, ...p) => stmt(sql).run(...p);
export function tx(fn) {
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
}

// ── настройки ──
export function getSettings() {
  const out = { ...DEFAULT_SETTINGS };
  for (const r of all('SELECT key,value FROM settings')) {
    if (r.key in out) out[r.key] = safeJson(r.value, out[r.key]);
  }
  return out;
}
export function setSetting(key, value) {
  if (!(key in DEFAULT_SETTINGS)) return;
  run('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', key, JSON.stringify(value));
}
export function filesRoot() {
  const s = getSettings().storageDir;
  return ensureDir(path.resolve(s || path.join(DATA_DIR, 'files')));
}
