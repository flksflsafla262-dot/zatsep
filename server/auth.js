import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { get, all, run } from './db.js';
import { now, rid, sha256, fail } from './util.js';

const scrypt = promisify(crypto.scrypt);
const SESSION_DAYS = 30;
export const OWNER_NAME = 'Пользователь';
export const OWNER_DEFAULT_PASS = '12345678';

export async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const N = 16384, r = 8, p = 1;
  const h = await scrypt(pw, salt, 64, { N, r, p, maxmem: 64 * 1024 * 1024 });
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64')}$${h.toString('base64')}`;
}
export async function verifyPassword(pw, stored) {
  try {
    const [alg, N, r, p, salt, hash] = String(stored).split('$');
    if (alg !== 'scrypt') return false;
    const want = Buffer.from(hash, 'base64');
    const got = await scrypt(pw, Buffer.from(salt, 'base64'), want.length, { N: +N, r: +r, p: +p, maxmem: 64 * 1024 * 1024 });
    return crypto.timingSafeEqual(want, got);
  } catch { return false; }
}

/** Режим без входа (по умолчанию): все, кто открыл сайт, работают как владелец. REQUIRE_LOGIN=1 возвращает аккаунты. */
export const OPEN = process.env.REQUIRE_LOGIN !== '1';

export async function ensureOwner() {
  const has = get("SELECT id FROM users WHERE role='owner'");
  if (has) { if (OPEN && has.must_change) run('UPDATE users SET must_change=0 WHERE id=?', has.id); return false; }
  run('INSERT INTO users(username,pass,role,must_change,created_at) VALUES(?,?,?,?,?)',
    OWNER_NAME, await hashPassword(OWNER_DEFAULT_PASS), 'owner', OPEN ? 0 : 1, now());
  return true;
}

export function validatePassword(pw) {
  if (typeof pw !== 'string' || pw.length < 8) fail(400, 'weak_password', 'Пароль должен быть не короче 8 символов');
  if (pw.length > 200) fail(400, 'weak_password', 'Слишком длинный пароль');
}
export function validateUsername(name) {
  const n = String(name || '').trim();
  if (n.length < 2 || n.length > 32) fail(400, 'bad_username', 'Имя — от 2 до 32 символов');
  if (/[\u0000-\u001f<>\\/]/.test(n)) fail(400, 'bad_username', 'В имени есть недопустимые символы');
  return n;
}

// ── сессии ──
export function createSession(userId, ua) {
  const token = rid(32);
  const t = now();
  run('INSERT INTO sessions(id,user_id,created_at,expires_at,ua) VALUES(?,?,?,?,?)',
    sha256(token), userId, t, t + SESSION_DAYS * 864e5, String(ua || '').slice(0, 200));
  return token;
}
export function destroySession(token) { if (token) run('DELETE FROM sessions WHERE id=?', sha256(token)); }
export function destroyAllSessions(userId) { run('DELETE FROM sessions WHERE user_id=?', userId); }

export function parseCookies(h) {
  const out = {};
  for (const part of String(h || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) { try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* skip */ } }
  }
  return out;
}

export function userFromRequest(req) {
  if (OPEN) return get("SELECT * FROM users WHERE role='owner' ORDER BY id LIMIT 1");
  const token = parseCookies(req.headers.cookie).sid;
  if (!token) return null;
  const row = get(`SELECT u.*, s.expires_at AS s_exp FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.id=?`, sha256(token));
  if (!row) return null;
  if (row.s_exp < now()) { destroySession(token); return null; }
  const t = now();
  if (!row.last_seen || t - row.last_seen > 60000) {
    run('UPDATE users SET last_seen=? WHERE id=?', t, row.id);
    // продлеваем сессию (скользящее окно)
    run('UPDATE sessions SET expires_at=? WHERE id=?', t + SESSION_DAYS * 864e5, sha256(token));
  }
  return row;
}

export function cookieHeader(token, secure, maxAgeSec = SESSION_DAYS * 86400) {
  return `sid=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secure ? '; Secure' : ''}`;
}

// ── защита от перебора ──
const attempts = new Map(); // key -> {n, until, last}
const keyOf = (ip, name) => `${ip}|${String(name).toLowerCase()}`;
export function checkLock(ip, name) {
  for (const k of [keyOf(ip, name), `${ip}|*`]) {
    const a = attempts.get(k);
    if (a && a.until > now()) {
      const sec = Math.ceil((a.until - now()) / 1000);
      fail(429, 'locked', `Слишком много попыток. Подожди ${sec > 90 ? Math.ceil(sec / 60) + ' мин.' : sec + ' с.'}`);
    }
  }
}
export function registerFail(ip, name) {
  for (const [k, limit] of [[keyOf(ip, name), 5], [`${ip}|*`, 20]]) {
    const a = attempts.get(k) || { n: 0, until: 0, last: 0 };
    if (now() - a.last > 3600e3) a.n = 0;
    a.n++; a.last = now();
    if (a.n >= limit) { a.until = now() + Math.min(15 * 60e3, 15e3 * 2 ** Math.min(a.n - limit, 6)); }
    attempts.set(k, a);
  }
}
export function registerOk(ip, name) {
  attempts.delete(keyOf(ip, name));
  const a = attempts.get(`${ip}|*`);
  if (a && a.until < now()) a.n = Math.max(0, a.n - 1);
}
setInterval(() => { for (const [k, a] of attempts) if (now() - a.last > 3600e3) attempts.delete(k); }, 600e3).unref();

// ── Origin-проверка (CSRF) ──
export function originOk(req) {
  const origin = req.headers.origin;
  const host = req.headers.host;
  if (!origin) {
    const sfs = req.headers['sec-fetch-site'];
    return !sfs || sfs === 'same-origin' || sfs === 'none';
  }
  try { return new URL(origin).host === host; } catch { return false; }
}

export function publicUser(u, extra = {}) {
  return {
    id: u.id, username: u.username, role: u.role, avatar: !!u.avatar,
    mustChange: !!u.must_change, quotaGB: u.quota_gb, quotaDay: u.quota_day,
    createdAt: u.created_at, lastSeen: u.last_seen, ...extra,
  };
}
export const listUsers = () => all('SELECT * FROM users ORDER BY id');
