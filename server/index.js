import http from 'node:http';
import https from 'node:https';
import { spawnSync } from 'node:child_process';
// кириллица и рамки в консоли Windows (cmd/PowerShell) — переключаем кодовую страницу на UTF-8
if (process.platform === 'win32') { try { spawnSync('chcp 65001', { shell: true, stdio: 'ignore' }); } catch { /* ignore */ } }
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { PORT, HOST, USE_HTTPS, PUBLIC_DIR, UPLOAD_DIR, AVATAR_DIR, COOKIES_FILE, DATA_DIR, ROOT } from './config.js';
import { get, all, run, getSettings, setSetting, filesRoot } from './db.js';
import * as auth from './auth.js';
import { checkTools, tools, installHelp, updateYtdlp, scheduleAutoUpdate } from './tools.js';
import { probe } from './probe.js';
import * as dl from './downloader.js';
import { serveFile, streamZip } from './files.js';
import { addClient, emitUser, isOnline, onlineIds } from './events.js';
import { assertPublicUrl, safeRequest, readBody as readRes } from './ssrf.js';
import { srtToVtt } from './media.js';
import {
  HttpError, fail, now, rid, rmrf, ensureDir, exists, extractUrls, safeJson, mimeOf, extOf, sanitizeName, fmtBytes,
} from './util.js';

// ───────────────────────── маршрутизатор ─────────────────────────
const routes = [];
function route(method, pattern, opts, handler) {
  if (typeof opts === 'function') { handler = opts; opts = {}; }
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '/?$');
  routes.push({ method, re, keys, opts: { auth: true, ...opts }, handler });
}
const json = (res, status, obj, headers = {}) => {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(body), ...headers });
  res.end(body);
};
async function readBodyBuf(req, limit = 1e6) {
  const chunks = []; let n = 0;
  for await (const c of req) { n += c.length; if (n > limit) fail(413, 'too_big', 'Слишком большой запрос'); chunks.push(c); }
  return Buffer.concat(chunks);
}
async function readJson(req, limit = 1e6) {
  const b = await readBodyBuf(req, limit);
  if (!b.length) return {};
  try { return JSON.parse(b.toString('utf8')); } catch { fail(400, 'bad_json', 'Некорректный запрос'); }
}
const isSecure = (req) => !!req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https';
const clientIp = (req) => req.socket.remoteAddress || '?';
const need = (v, msg = 'Не найдено') => { if (!v) fail(404, 'not_found', msg); return v; };
const jobOf = (id) => need(dl.getJob(Number(id)), 'Загрузка не найдена');
const canRead = (u, j) => j.user_id === u.id || !!j.shared;
const canWrite = (u, j) => j.user_id === u.id || (j.shared && u.role === 'owner');

// ───────────────────────── аккаунты ─────────────────────────
route('POST', '/api/login', { auth: false }, async ({ req, res }) => {
  const { username, password } = await readJson(req);
  const ip = clientIp(req);
  auth.checkLock(ip, username || '');
  auth.registerFail(ip, username || ''); // считаем попытку заранее — параллельный перебор не проскочит; при успехе счётчик сбросится
  const user = get('SELECT * FROM users WHERE username=?', String(username || '').trim());
  const ok = user ? await auth.verifyPassword(String(password || ''), user.pass) : (await auth.verifyPassword('x', 'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$' + Buffer.alloc(64).toString('base64')), false);
  if (!ok) { fail(401, 'bad_credentials', 'Неверное имя или пароль'); }
  auth.registerOk(ip, username);
  const token = auth.createSession(user.id, req.headers['user-agent']);
  json(res, 200, { user: auth.publicUser(user) }, { 'set-cookie': auth.cookieHeader(token, isSecure(req)) });
});
route('POST', '/api/logout', { auth: false }, async ({ req, res }) => {
  auth.destroySession(auth.parseCookies(req.headers.cookie).sid);
  json(res, 200, { ok: true }, { 'set-cookie': auth.cookieHeader('', isSecure(req), 0) });
});
route('POST', '/api/logout-all', async ({ req, res, user }) => {
  auth.destroyAllSessions(user.id);
  json(res, 200, { ok: true }, { 'set-cookie': auth.cookieHeader('', isSecure(req), 0) });
});
route('GET', '/api/me', async ({ res, user }) => {
  const s = getSettings();
  json(res, 200, {
    user: auth.publicUser(user), limits: dl.limitsFor(user),
    defaults: { quality: s.defaultQuality, container: s.defaultContainer, audio: s.defaultAudio, shareHours: s.shareHours },
    tools: { ytdlp: tools.ytdlp.ok, ffmpeg: tools.ffmpeg.ok && tools.ffprobe.ok, gallerydl: tools.gallerydl.ok },
    secure: !!res.req.socket.encrypted, open: auth.OPEN,
  });
});
route('POST', '/api/password', async ({ req, res, user }) => {
  const { oldPassword, newPassword } = await readJson(req);
  if (!(await auth.verifyPassword(String(oldPassword || ''), user.pass))) fail(403, 'bad_credentials', 'Текущий пароль указан неверно');
  auth.validatePassword(newPassword);
  if (newPassword === oldPassword) fail(400, 'same', 'Новый пароль совпадает со старым');
  run('UPDATE users SET pass=?, must_change=0 WHERE id=?', await auth.hashPassword(newPassword), user.id);
  const cur = auth.parseCookies(res.req.headers.cookie).sid;
  const { sha256 } = await import('./util.js');
  run('DELETE FROM sessions WHERE user_id=? AND id<>?', user.id, sha256(cur));
  json(res, 200, { ok: true });
});
route('POST', '/api/profile', async ({ req, res, user }) => {
  const { username } = await readJson(req);
  const name = auth.validateUsername(username);
  const ex = get('SELECT id FROM users WHERE username=? AND id<>?', name, user.id);
  if (ex) fail(409, 'taken', 'Это имя уже занято');
  run('UPDATE users SET username=? WHERE id=?', name, user.id);
  json(res, 200, { user: auth.publicUser(get('SELECT * FROM users WHERE id=?', user.id)) });
});
const avatarFile = (id) => ['jpg', 'png', 'webp'].map((e) => path.join(AVATAR_DIR, `${id}.${e}`)).find(exists);
route('PUT', '/api/avatar', async ({ req, res, user }) => {
  const b = await readBodyBuf(req, 3e6);
  let ext = null;
  if (b[0] === 0xff && b[1] === 0xd8) ext = 'jpg';
  else if (b.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) ext = 'png';
  else if (b.slice(0, 4).toString() === 'RIFF' && b.slice(8, 12).toString() === 'WEBP') ext = 'webp';
  if (!ext) fail(400, 'bad_image', 'Нужна картинка JPG, PNG или WebP (до 3 МБ)');
  const old = avatarFile(user.id); if (old) rmrf(old);
  fs.writeFileSync(path.join(AVATAR_DIR, `${user.id}.${ext}`), b);
  run('UPDATE users SET avatar=? WHERE id=?', now(), user.id);
  json(res, 200, { ok: true, v: now() });
});
route('DELETE', '/api/avatar', async ({ res, user }) => {
  const old = avatarFile(user.id); if (old) rmrf(old);
  run('UPDATE users SET avatar=0 WHERE id=?', user.id);
  json(res, 200, { ok: true });
});
route('GET', '/api/avatar/:id', async ({ req, res, params }) => {
  const f = avatarFile(Number(params.id));
  if (!f) return json(res, 404, { error: 'not_found' });
  serveFile(req, res, f, { cache: 'private, max-age=300' });
});

// приглашения
route('GET', '/api/invite/:code', { auth: false }, async ({ res, params }) => {
  const inv = get('SELECT * FROM invites WHERE code=?', params.code);
  const valid = !!inv && !inv.used_by && inv.expires_at > now();
  json(res, 200, { valid, expiresAt: inv?.expires_at });
});
route('POST', '/api/register', { auth: false }, async ({ req, res }) => {
  const { code, username, password } = await readJson(req);
  auth.checkLock(clientIp(req), 'register');
  const inv = get('SELECT * FROM invites WHERE code=?', String(code || ''));
  if (!inv || inv.used_by || inv.expires_at < now()) { auth.registerFail(clientIp(req), 'register'); fail(400, 'bad_invite', 'Приглашение недействительно или уже использовано'); }
  const name = auth.validateUsername(username);
  auth.validatePassword(password);
  if (get('SELECT id FROM users WHERE username=?', name)) fail(409, 'taken', 'Это имя уже занято');
  const r = run('INSERT INTO users(username,pass,role,created_at) VALUES(?,?,?,?)', name, await auth.hashPassword(password), 'friend', now());
  const id = Number(r.lastInsertRowid);
  run('UPDATE invites SET used_by=?, used_at=? WHERE code=?', id, now(), inv.code);
  const token = auth.createSession(id, req.headers['user-agent']);
  json(res, 200, { user: auth.publicUser(get('SELECT * FROM users WHERE id=?', id)) }, { 'set-cookie': auth.cookieHeader(token, isSecure(req)) });
});
route('POST', '/api/invites', { owner: true }, async ({ res, user }) => {
  const code = rid(18);
  run('INSERT INTO invites(code,created_by,created_at,expires_at) VALUES(?,?,?,?)', code, user.id, now(), now() + 7 * 864e5);
  json(res, 200, { code, expiresAt: now() + 7 * 864e5 });
});
route('GET', '/api/invites', { owner: true }, async ({ res }) => {
  json(res, 200, { invites: all('SELECT i.*, u.username AS used_name FROM invites i LEFT JOIN users u ON u.id=i.used_by ORDER BY created_at DESC LIMIT 50').map((i) => ({ code: i.code, createdAt: i.created_at, expiresAt: i.expires_at, usedBy: i.used_name, usedAt: i.used_at })) });
});
route('DELETE', '/api/invites/:code', { owner: true }, async ({ res, params }) => { run('DELETE FROM invites WHERE code=?', params.code); json(res, 200, { ok: true }); });

route('GET', '/api/users', { owner: true }, async ({ res }) => {
  json(res, 200, {
    users: auth.listUsers().map((u) => ({
      ...auth.publicUser(u), online: isOnline(u.id), used: dl.usedBytes(u.id), jobs: get('SELECT COUNT(*) AS n FROM jobs WHERE user_id=?', u.id).n,
    })),
  });
});
route('PATCH', '/api/users/:id', { owner: true }, async ({ req, res, params }) => {
  const u = need(get('SELECT * FROM users WHERE id=?', Number(params.id)));
  const b = await readJson(req);
  const gb = b.quotaGB === '' || b.quotaGB == null ? null : Math.max(0, Number(b.quotaGB));
  const day = b.quotaDay === '' || b.quotaDay == null ? null : Math.max(0, Math.round(Number(b.quotaDay)));
  run('UPDATE users SET quota_gb=?, quota_day=? WHERE id=?', Number.isFinite(gb) ? gb : null, Number.isFinite(day) ? day : null, u.id);
  json(res, 200, { ok: true });
});
route('DELETE', '/api/users/:id', { owner: true }, async ({ res, params, user }) => {
  const u = need(get('SELECT * FROM users WHERE id=?', Number(params.id)));
  if (u.role === 'owner' || u.id === user.id) fail(400, 'forbidden', 'Владельца удалить нельзя');
  for (const j of all('SELECT * FROM jobs WHERE user_id=?', u.id)) dl.removeJob(j);
  rmrf(path.join(filesRoot(), String(u.id)));
  const af = avatarFile(u.id); if (af) rmrf(af);
  run('DELETE FROM users WHERE id=?', u.id);
  json(res, 200, { ok: true });
});

// ───────────────────────── настройки (владелец) ─────────────────────────
function cookieStatus() {
  try { const st = fs.statSync(COOKIES_FILE); const t = fs.readFileSync(COOKIES_FILE, 'utf8'); return { exists: true, size: st.size, mtime: st.mtimeMs, lines: t.split('\n').filter((l) => l && !l.startsWith('#')).length }; } catch { return { exists: false }; }
}
route('GET', '/api/settings', { owner: true }, async ({ res }) => {
  json(res, 200, { settings: getSettings(), cookies: cookieStatus(), tools, free: dl.freeBytes(), root: filesRoot(), platform: process.platform });
});
route('PUT', '/api/settings', { owner: true }, async ({ req, res }) => {
  const b = await readJson(req);
  const num = (k, min, max) => { if (k in b) { const n = Number(b[k]); if (!Number.isFinite(n) || n < min || n > max) fail(400, 'bad_value', `Неверное значение: ${k}`); setSetting(k, n); } };
  num('maxConcurrent', 1, 10); num('maxTotalGB', 0, 1e6); num('perUserGB', 0, 1e6); num('perUserPerDay', 0, 1e5); num('cleanupDays', 0, 3650); num('shareHours', 1, 24 * 365);
  const str = (k, max = 300) => { if (k in b) setSetting(k, String(b[k] ?? '').trim().slice(0, max)); };
  str('nameTemplate', 120); str('cookiesBrowser', 40);
  if ('proxy' in b) {
    const p = String(b.proxy || '').trim();
    if (p && !/^(https?|socks[45]h?):\/\/[^\s]+$/i.test(p)) fail(400, 'bad_value', 'Прокси укажи так: http://host:port или socks5://host:port');
    setSetting('proxy', p);
  }
  if ('defaultQuality' in b) setSetting('defaultQuality', String(b.defaultQuality).slice(0, 10));
  if ('defaultContainer' in b && ['mp4', 'mkv', 'webm'].includes(b.defaultContainer)) setSetting('defaultContainer', b.defaultContainer);
  if ('defaultAudio' in b && ['best', 'mp3', 'm4a', 'opus', 'flac', 'wav'].includes(b.defaultAudio)) setSetting('defaultAudio', b.defaultAudio);
  for (const k of ['autoUpdate', 'allowPrivate']) if (k in b) setSetting(k, !!b[k]);
  if ('storageDir' in b) {
    const d = String(b.storageDir || '').trim();
    if (d) { if (!path.isAbsolute(d)) fail(400, 'bad_value', 'Папка хранения должна быть абсолютным путём'); try { ensureDir(d); fs.accessSync(d, fs.constants.W_OK); } catch { fail(400, 'bad_value', 'В эту папку нельзя писать'); } }
    setSetting('storageDir', d);
  }
  dl.tick();
  json(res, 200, { settings: getSettings() });
});
route('POST', '/api/settings/cookies', { owner: true }, async ({ req, res }) => {
  const text = (await readBodyBuf(req, 3e6)).toString('utf8').replace(/\r\n/g, '\n');
  const ok = /^# (Netscape )?HTTP Cookie File/m.test(text) || text.split('\n').some((l) => l.split('\t').length >= 7);
  if (!ok) fail(400, 'bad_cookies', 'Это не похоже на cookies.txt в формате Netscape. Выгрузи файл расширением «Get cookies.txt LOCALLY».');
  fs.writeFileSync(COOKIES_FILE, text, { mode: 0o600 });
  json(res, 200, { cookies: cookieStatus() });
});
route('DELETE', '/api/settings/cookies', { owner: true }, async ({ res }) => { rmrf(COOKIES_FILE); json(res, 200, { cookies: cookieStatus() }); });
route('POST', '/api/tools/update', { owner: true }, async ({ res }) => { json(res, 200, await updateYtdlp('manual')); });
route('GET', '/api/tools', { owner: true }, async ({ res }) => { json(res, 200, { tools }); });

// ───────────────────────── разбор и загрузка ─────────────────────────
route('POST', '/api/probe', async ({ req, res }) => {
  const b = await readJson(req);
  const urls = extractUrls(b.text || b.url || '');
  if (!urls.length) fail(400, 'no_url', 'Не нашёл ссылку в тексте. Вставь адрес страницы с видео или музыкой.');
  if (urls.length > 1 && !b.single) return json(res, 200, { urls });
  const info = await probe(urls[0], { playlist: !!b.playlist });
  json(res, 200, { urls, info });
});
route('POST', '/api/jobs', async ({ req, res, user }) => {
  const b = await readJson(req, 3e6);
  json(res, 200, await dl.enqueue(user, { items: b.items, opts: b.opts, force: !!b.force, shared: !!b.shared }));
});
route('GET', '/api/jobs', async ({ res, user }) => {
  const rows = all('SELECT * FROM jobs WHERE user_id=? OR shared=1 ORDER BY created_at DESC, id DESC LIMIT 3000', user.id);
  json(res, 200, { jobs: rows.map(dl.jobDto) });
});
route('GET', '/api/jobs/:id/log', async ({ res, params, user }) => {
  const j = jobOf(params.id);
  if (j.user_id !== user.id && user.role !== 'owner') fail(403, 'forbidden', 'Нет доступа');
  json(res, 200, { log: j.log || '', url: j.url, code: j.err_code, message: j.err_msg });
});
for (const act of ['cancel', 'pause', 'resume', 'retry']) {
  route('POST', `/api/jobs/:id/${act}`, async ({ res, params, user }) => {
    const j = jobOf(params.id);
    if (!canWrite(user, j)) fail(403, 'forbidden', 'Нет доступа');
    ({ cancel: dl.cancelJob, pause: dl.pauseJob, resume: dl.resumeJob, retry: dl.retryJob })[act](j);
    json(res, 200, { job: dl.jobDto(dl.getJob(j.id)) });
  });
}
route('DELETE', '/api/jobs/:id', async ({ res, params, user }) => {
  const j = jobOf(params.id);
  if (!canWrite(user, j)) fail(403, 'forbidden', 'Нет доступа');
  dl.removeJob(j);
  json(res, 200, { ok: true });
});
route('POST', '/api/jobs/bulk', async ({ req, res, user }) => {
  const { action, ids } = await readJson(req);
  let n = 0;
  for (const id of (Array.isArray(ids) ? ids : []).slice(0, 500)) {
    const j = dl.getJob(Number(id));
    if (!j || !canWrite(user, j)) continue;
    if (action === 'delete') dl.removeJob(j); else if (action === 'cancel') dl.cancelJob(j); else if (action === 'retry') dl.retryJob(j); else continue;
    n++;
  }
  json(res, 200, { ok: true, n });
});
route('POST', '/api/jobs/reorder', async ({ req, res, user }) => { const { ids } = await readJson(req); dl.reorder(user.id, (ids || []).map(Number)); json(res, 200, { ok: true }); });
route('POST', '/api/jobs/:id/shared', { owner: true }, async ({ req, res, params, user }) => {
  const j = jobOf(params.id);
  if (j.user_id !== user.id) fail(403, 'forbidden', 'Только свои файлы');
  const { shared } = await readJson(req);
  run('UPDATE jobs SET shared=? WHERE id=?', shared ? 1 : 0, j.id);
  const r = dl.getJob(j.id);
  json(res, 200, { job: dl.jobDto(r) });
  const { emitAll } = await import('./events.js');
  emitAll('job-reload', {});
});
route('PATCH', '/api/jobs/:id', async ({ req, res, params, user }) => {
  const j = jobOf(params.id);
  if (!canWrite(user, j)) fail(403, 'forbidden', 'Нет доступа');
  const b = await readJson(req);
  const cl = (s) => String(s ?? '').slice(0, 250);
  run('UPDATE jobs SET title=COALESCE(?,title), uploader=COALESCE(?,uploader), album=COALESCE(?,album) WHERE id=?', 'title' in b ? cl(b.title) : null, 'uploader' in b ? cl(b.uploader) : null, 'album' in b ? cl(b.album) : null, j.id);
  const r = dl.getJob(j.id);
  json(res, 200, { job: dl.jobDto(r) });
  emitUser(j.user_id, 'job', dl.jobDto(r));
});
route('POST', '/api/jobs/:id/convert', async ({ req, res, params, user }) => {
  const j = jobOf(params.id);
  if (!canRead(user, j) || j.status !== 'done') fail(400, 'not_ready', 'Файл ещё не готов');
  const b = await readJson(req);
  json(res, 200, { job: await dl.enqueueConvert(user, j, b) });
});

// ───────────────────────── выдача файлов ─────────────────────────
const nameOf = (j) => path.basename(j.file);
route('GET', '/api/files/:id', async ({ req, res, params, query, user }) => {
  const j = jobOf(params.id);
  if (!canRead(user, j) || j.status !== 'done' || !j.file) fail(404, 'not_found', 'Файл не найден');
  const inline = query.get('inline') === '1';
  // «сразу на устройство»: после полной отдачи файл удаляется с сервера
  const once = query.get('once') === '1' && j.user_id === user.id && !!(safeJson(j.opts, {}) || {}).direct;
  serveFile(req, res, j.file, { name: nameOf(j), download: !inline, onComplete: once ? () => { const cur = dl.getJob(j.id); if (cur) dl.removeJob(cur); } : undefined });
});
route('GET', '/api/files/:id/compat', async ({ req, res, params, user }) => {
  const j = jobOf(params.id);
  if (!canRead(user, j) || !j.compat_file || !exists(j.compat_file)) fail(404, 'not_found', 'Совместимая версия ещё не готова');
  serveFile(req, res, j.compat_file, { name: nameOf(j).replace(/\.[^.]+$/, '') + '.mp4' });
});
route('GET', '/api/files/:id/thumb', async ({ req, res, params, user }) => {
  const j = jobOf(params.id);
  if (!canRead(user, j) || !j.file) fail(404, 'not_found', 'Нет превью');
  const f = path.join(path.dirname(j.file), 'thumb.jpg');
  serveFile(req, res, f, { mime: 'image/jpeg', cache: 'private, max-age=86400' });
});
route('GET', '/api/files/:id/subs/:lang', async ({ req, res, params, user }) => {
  const j = jobOf(params.id);
  if (!canRead(user, j) || !j.file) fail(404, 'not_found', 'Нет субтитров');
  const lang = params.lang.replace(/\.vtt$/, '');
  const known = (safeJson(j.meta, {}).subs || []).find((s) => s.lang === lang);
  if (!known) fail(404, 'not_found', 'Нет таких субтитров');
  const f = path.join(path.dirname(j.file), 'subs', `${known.lang}.${known.ext}`);
  if (known.ext === 'vtt') return serveFile(req, res, f, { mime: 'text/vtt; charset=utf-8' });
  const text = srtToVtt(fs.readFileSync(f, 'utf8'));
  res.writeHead(200, { 'content-type': 'text/vtt; charset=utf-8', 'cache-control': 'private, max-age=3600' });
  res.end(text);
});
route('GET', '/api/files/:id/sub-download/:lang', async ({ req, res, params, user }) => {
  const j = jobOf(params.id);
  if (!canRead(user, j) || !j.file) fail(404, 'not_found', 'Нет субтитров');
  const known = (safeJson(j.meta, {}).subs || []).find((s) => s.lang === params.lang);
  if (!known) fail(404, 'not_found', 'Нет таких субтитров');
  serveFile(req, res, path.join(path.dirname(j.file), 'subs', `${known.lang}.${known.ext}`), { name: `${nameOf(j).replace(/\.[^.]+$/, '')}.${known.lang}.${known.ext}`, download: true });
});
route('GET', '/api/zip', async ({ req, res, query, user }) => {
  const ids = String(query.get('ids') || '').split(',').map(Number).filter(Boolean).slice(0, 500);
  const files = [];
  for (const id of ids) {
    const j = dl.getJob(id);
    if (j && canRead(user, j) && j.status === 'done' && j.file && exists(j.file)) files.push({ path: j.file, name: path.basename(j.file) });
  }
  if (!files.length) fail(404, 'not_found', 'Нет готовых файлов для архива');
  await streamZip(req, res, files, sanitizeName(query.get('name') || 'Зацеп', 'Зацеп'));
});

// ссылки для друзей без регистрации
route('POST', '/api/jobs/:id/share', async ({ req, res, params, user }) => {
  const j = jobOf(params.id);
  if (!canRead(user, j) || j.status !== 'done') fail(400, 'not_ready', 'Файл ещё не готов');
  const b = await readJson(req);
  const hours = Math.min(Math.max(Number(b.hours) || getSettings().shareHours, 1), 24 * 365);
  const token = rid(24);
  run('INSERT INTO shares(token,job_id,user_id,created_at,expires_at) VALUES(?,?,?,?,?)', token, j.id, user.id, now(), now() + hours * 3600e3);
  json(res, 200, { token, path: `/s/${token}`, expiresAt: now() + hours * 3600e3 });
});
route('GET', '/api/shares', async ({ res, user }) => {
  const rows = all(`SELECT s.*, j.title FROM shares s JOIN jobs j ON j.id=s.job_id WHERE s.user_id=? AND s.revoked=0 AND s.expires_at>? ORDER BY s.created_at DESC`, user.id, now());
  json(res, 200, { shares: rows.map((s) => ({ token: s.token, jobId: s.job_id, title: s.title, createdAt: s.created_at, expiresAt: s.expires_at })) });
});
route('DELETE', '/api/shares/:token', async ({ res, params, user }) => {
  const s = need(get('SELECT * FROM shares WHERE token=?', params.token));
  if (s.user_id !== user.id && user.role !== 'owner') fail(403, 'forbidden', 'Нет доступа');
  run('UPDATE shares SET revoked=1 WHERE token=?', s.token);
  json(res, 200, { ok: true });
});
route('POST', '/api/jobs/:id/unshare', async ({ res, params, user }) => {
  const j = jobOf(params.id);
  if (!canWrite(user, j)) fail(403, 'forbidden', 'Нет доступа');
  run('UPDATE shares SET revoked=1 WHERE job_id=?', j.id);
  json(res, 200, { ok: true });
});
route('GET', '/s/:token', { auth: false }, async ({ req, res, params, query }) => {
  const s = get('SELECT s.*, j.file, j.status FROM shares s JOIN jobs j ON j.id=s.job_id WHERE s.token=?', params.token);
  if (!s || s.revoked || s.expires_at < now() || s.status !== 'done' || !s.file || !exists(s.file)) {
    res.writeHead(404, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    return res.end('<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>Ссылка не работает</title><body style="font:16px system-ui;background:#000;color:#fff;display:grid;place-items:center;height:100vh;margin:0;text-align:center"><div><h1 style="font-weight:600">Ссылка не работает</h1><p style="opacity:.6">Срок действия закончился или владелец её отозвал.</p></div>');
  }
  serveFile(req, res, s.file, { name: path.basename(s.file), download: query.get('inline') !== '1', cache: 'private, no-store' });
});

// ───────────────────────── свои файлы: загрузка кусками ─────────────────────────
const upDir = (id) => path.join(UPLOAD_DIR, id);
const validUp = (id) => /^[A-Za-z0-9_-]{10,40}$/.test(id);
function upMeta(id, user) {
  if (!validUp(id)) fail(400, 'bad_id', 'Неверный идентификатор загрузки');
  const m = safeJson(exists(path.join(upDir(id), 'meta.json')) ? fs.readFileSync(path.join(upDir(id), 'meta.json'), 'utf8') : null);
  if (!m || m.userId !== user.id) fail(404, 'not_found', 'Загрузка не найдена');
  return m;
}
route('POST', '/api/upload', async ({ req, res, user }) => {
  const { name, size } = await readJson(req);
  if (!name || !(size > 0)) fail(400, 'bad_request', 'Не указан файл');
  if (size > dl.freeBytes() - 500e6) fail(507, 'space', 'Файл не поместится: мало места на диске сервера.');
  const id = rid(16);
  ensureDir(upDir(id));
  fs.writeFileSync(path.join(upDir(id), 'meta.json'), JSON.stringify({ userId: user.id, name: String(name).slice(0, 250), size, created: now() }));
  fs.writeFileSync(path.join(upDir(id), 'data.part'), '');
  json(res, 200, { id, received: 0 });
});
route('GET', '/api/upload/:id', async ({ res, params, user }) => {
  upMeta(params.id, user);
  json(res, 200, { received: fs.statSync(path.join(upDir(params.id), 'data.part')).size });
});
route('PUT', '/api/upload/:id', async ({ req, res, params, query, user }) => {
  const m = upMeta(params.id, user);
  const f = path.join(upDir(params.id), 'data.part');
  const have = fs.statSync(f).size;
  const offset = Number(query.get('offset'));
  if (offset !== have) return json(res, 409, { error: 'offset', message: 'Смещение не совпадает', received: have });
  let n = 0;
  const ws = fs.createWriteStream(f, { flags: 'a' });
  await new Promise((resolve, reject) => {
    req.on('data', (c) => { n += c.length; if (have + n > m.size || n > 16 * 1024 * 1024) { req.destroy(); ws.destroy(); reject(new HttpError(413, 'too_big', 'Слишком большой кусок')); } });
    req.on('error', reject); ws.on('error', reject); ws.on('finish', resolve);
    req.pipe(ws);
  });
  json(res, 200, { received: have + n });
});
route('POST', '/api/upload/:id/finish', async ({ res, params, user }) => {
  const m = upMeta(params.id, user);
  const f = path.join(upDir(params.id), 'data.part');
  const size = fs.statSync(f).size;
  if (size !== m.size) fail(409, 'incomplete', 'Файл загружен не полностью', { received: size });
  const job = await dl.adoptUpload(user, f, m.name);
  rmrf(upDir(params.id));
  json(res, 200, { job });
});
route('DELETE', '/api/upload/:id', async ({ res, params, user }) => { upMeta(params.id, user); rmrf(upDir(params.id)); json(res, 200, { ok: true }); });

// ───────────────────────── статистика, плейлисты, прокси картинок ─────────────────────────
route('GET', '/api/stats', async ({ res, user }) => {
  const out = { used: dl.usedBytes(user.id), free: dl.freeBytes(), limits: dl.limitsFor(user), count: get('SELECT COUNT(*) AS n FROM jobs WHERE user_id=?', user.id).n };
  if (user.role === 'owner') {
    out.total = dl.totalBytes();
    out.users = auth.listUsers().map((u) => ({ id: u.id, username: u.username, used: dl.usedBytes(u.id), online: isOnline(u.id) }));
  }
  json(res, 200, out);
});
route('GET', '/api/playlists', async ({ res, user }) => {
  const pls = all('SELECT * FROM playlists WHERE user_id=? ORDER BY created_at', user.id).map((p) => ({ id: p.id, name: p.name, items: all('SELECT job_id FROM playlist_items WHERE playlist_id=? ORDER BY pos', p.id).map((r) => r.job_id) }));
  json(res, 200, { playlists: pls });
});
route('POST', '/api/playlists', async ({ req, res, user }) => {
  const { name } = await readJson(req);
  const n = String(name || '').trim().slice(0, 80);
  if (!n) fail(400, 'bad_name', 'Дай плейлисту название');
  const r = run('INSERT INTO playlists(user_id,name,created_at) VALUES(?,?,?)', user.id, n, now());
  json(res, 200, { id: Number(r.lastInsertRowid), name: n, items: [] });
});
route('PUT', '/api/playlists/:id', async ({ req, res, params, user }) => {
  const p = need(get('SELECT * FROM playlists WHERE id=? AND user_id=?', Number(params.id), user.id));
  const b = await readJson(req);
  if (b.name) run('UPDATE playlists SET name=? WHERE id=?', String(b.name).trim().slice(0, 80), p.id);
  if (Array.isArray(b.items)) {
    run('DELETE FROM playlist_items WHERE playlist_id=?', p.id);
    let i = 0; const seen = new Set();
    for (const id of b.items.map(Number)) {
      const j = dl.getJob(id);
      if (!j || !canRead(user, j) || seen.has(id)) continue;
      seen.add(id); run('INSERT INTO playlist_items(playlist_id,job_id,pos) VALUES(?,?,?)', p.id, id, i++);
    }
  }
  json(res, 200, { ok: true });
});
route('DELETE', '/api/playlists/:id', async ({ res, params, user }) => { run('DELETE FROM playlists WHERE id=? AND user_id=?', Number(params.id), user.id); json(res, 200, { ok: true }); });

route('GET', '/api/proxy-img', async ({ res, query }) => {
  const u = query.get('u');
  if (!u) fail(400, 'bad_url', 'Нет адреса');
  try {
    const { res: r } = await safeRequest(u, { timeout: 15000, headers: { accept: 'image/*' } });
    const ct = String(r.headers['content-type'] || '');
    if (r.statusCode >= 400 || !/^image\//.test(ct) || /svg/.test(ct)) { r.resume(); return json(res, 404, { error: 'not_image' }); }
    const buf = await readRes(r, 8e6);
    res.writeHead(200, { 'content-type': ct, 'cache-control': 'private, max-age=86400', 'x-content-type-options': 'nosniff', 'content-length': buf.length });
    res.end(buf);
  } catch (e) { if (e instanceof HttpError) throw e; json(res, 502, { error: 'fetch_failed' }); }
});

route('GET', '/api/events', async ({ req, res, user }) => {
  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
  res.write(`retry: 2000\nevent: hello\ndata: ${JSON.stringify({ online: [...onlineIds(), user.id] })}\n\n`);
  addClient(user.id, res);
  req.on('close', () => { try { res.end(); } catch { /* ignore */ } });
});

// Web Share Target: из приложений «Поделиться» → сюда (GET), дальше фронтенд сам подхватит ссылку
route('GET', '/share-target', { auth: false }, async ({ res, query }) => {
  const text = [query.get('url'), query.get('text'), query.get('title')].filter(Boolean).join(' ');
  res.writeHead(302, { location: `/?share=${encodeURIComponent(text).slice(0, 4000)}#/`, 'cache-control': 'no-store' });
  res.end();
});
route('GET', '/healthz', { auth: false }, async ({ res }) => json(res, 200, { ok: true, running: dl.runningCount() }));

// ───────────────────────── сервер ─────────────────────────
const SEC_HEADERS = {
  'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY', 'referrer-policy': 'same-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
};
const CSP = "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; manifest-src 'self'; worker-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'";

async function serveStatic(req, res, pathname) {
  let p = pathname === '/' ? '/index.html' : pathname;
  let f;
  try { f = path.join(PUBLIC_DIR, decodeURIComponent(p)); } catch { f = null; }
  if (!f || !f.startsWith(PUBLIC_DIR + path.sep) || !exists(f) || fs.statSync(f).isDirectory()) {
    // SPA: неизвестные пути без расширения → index.html
    if (!path.extname(p)) f = path.join(PUBLIC_DIR, 'index.html'); else return json(res, 404, { error: 'not_found' });
  }
  const isHtml = extOf(f) === 'html';
  if (isHtml) res.setHeader('content-security-policy', CSP);
  if (path.basename(f) === 'sw.js') res.setHeader('service-worker-allowed', '/');
  serveFile(req, res, f, { cache: 'no-cache' });
}

const EXTRA_HOSTS = String(process.env.ALLOWED_HOSTS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
function hostAllowed(hostHeader) {
  const h = String(hostHeader || '').toLowerCase().replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  if (!h) return false;
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h === os.hostname().toLowerCase() || EXTRA_HOSTS.includes(h)) return true;
  return /^\d+\.\d+\.\d+\.\d+$/.test(h) || h === '::1' || /^(fe80|fc|fd)/.test(h);
}

async function handle(req, res) {
  for (const [k, v] of Object.entries(SEC_HEADERS)) res.setHeader(k, v);
  const url = new URL(req.url, 'http://localhost');
  const method = req.method === 'HEAD' ? 'GET' : req.method;
  try {
    // без входа: защита от DNS rebinding — принимаем только локальные имена/адреса (на публичном хостинге: ALLOW_ANY_HOST=1)
    if (auth.OPEN && process.env.ALLOW_ANY_HOST !== '1' && !hostAllowed(req.headers.host)) fail(403, 'bad_host', 'Открой сайт по адресу localhost или по IP в локальной сети');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !auth.originOk(req)) fail(403, 'bad_origin', 'Запрос с чужого адреса отклонён');
    if (req.method === 'GET' && req.headers.origin && !auth.originOk(req) && url.pathname === '/api/events') fail(403, 'bad_origin', 'Запрос с чужого адреса отклонён');
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
    for (const r of routes) {
      if (r.method !== method) continue;
      const m = r.re.exec(url.pathname);
      if (!m) continue;
      const params = {};
      r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
      const user = auth.userFromRequest(req);
      if (r.opts.auth && !user) fail(401, 'unauthorized', 'Нужно войти');
      if (r.opts.owner && user?.role !== 'owner') fail(403, 'forbidden', 'Только для владельца');
      return await r.handler({ req, res, url, query: url.searchParams, params, user });
    }
    if (url.pathname.startsWith('/api/')) fail(404, 'not_found', 'Нет такого метода');
    if (!['GET'].includes(method)) fail(405, 'method', 'Метод не поддерживается');
    await serveStatic(req, res, url.pathname);
  } catch (e) {
    if (res.headersSent) { try { res.end(); } catch { /* ignore */ } return; }
    if (e instanceof HttpError) return json(res, e.status, { error: e.code, message: e.message, ...(e.extra || {}) });
    console.error('[ошибка запроса]', req.method, req.url, e);
    json(res, 500, { error: 'internal', message: 'Внутренняя ошибка сервера' });
  }
}

function lanIps() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) for (const i of list || []) if (i.family === 'IPv4' && !i.internal) out.push(i.address);
  return out;
}

async function main() {
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 22) { console.error(`Нужен Node.js 22 или новее (у тебя ${process.version}). Скачай на https://nodejs.org`); process.exit(1); }
  await checkTools();
  const created = await auth.ensureOwner();
  dl.recover();

  let server;
  const ips = lanIps();
  if (USE_HTTPS) {
    const { loadOrCreateCert } = await import('./selfcert.js');
    server = https.createServer(loadOrCreateCert(['localhost', '127.0.0.1', os.hostname(), ...ips]), handle);
  } else server = http.createServer(handle);
  server.requestTimeout = 0;
  server.headersTimeout = 30000;
  server.keepAliveTimeout = 15000;

  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') console.error(`\nПорт ${PORT} занят. Закрой другую копию или запусти так: PORT=3001 npm start`);
    else console.error(e);
    process.exit(1);
  });
  server.listen(PORT, HOST, () => {
    const proto = USE_HTTPS ? 'https' : 'http';
    console.log('\n  ╭──────────────────────────────────────────╮');
    console.log('  │   Зацеп — личный загрузчик видео и музыки │');
    console.log('  ╰──────────────────────────────────────────╯\n');
    console.log(`  Компьютер:  ${proto}://localhost:${PORT}`);
    for (const ip of ips) console.log(`  Телефон:    ${proto}://${ip}:${PORT}   (в одной Wi-Fi сети)`);
    if (!USE_HTTPS) console.log('\n  Для «Поделиться», PWA и работы с телефона нужен HTTPS: npm run https');
    else console.log('\n  Сертификат самоподписанный — в браузере нажми «Дополнительно → Перейти на сайт».');
    console.log('\n  Инструменты:');
    const row = (n, t) => console.log(`   ${t.ok ? '✓' : '✗'} ${n.padEnd(10)} ${t.ok ? t.version : 'не найден'}`);
    row('yt-dlp', tools.ytdlp); row('ffmpeg', tools.ffmpeg); row('ffprobe', tools.ffprobe); row('gifski', tools.gifski); row('gallery-dl', tools.gallerydl);
    if (tools.ytdlp.ok && !tools.ytdlp.jsRuntimes) console.log('   ⚠ этот yt-dlp старый (нет --js-runtimes) — обновится автоматически');
    console.log(installHelp());
    if (auth.OPEN) console.log('  Вход отключён: просто открой сайт. Не выставляй порт в интернет без защиты (REQUIRE_LOGIN=1 включает аккаунты).\n');
    else if (created) console.log('  Первый запуск: логин «Пользователь», пароль 12345678 (при входе предложим сменить).\n');
    console.log(`  Данные: ${DATA_DIR}\n  Файлы:  ${filesRoot()}\n`);
  });

  scheduleAutoUpdate();
  setInterval(() => dl.autoCleanup(), 3600e3).unref();
  setTimeout(() => dl.autoCleanup(), 60e3).unref();
  setInterval(() => { // чистка брошенных загрузок и просроченных данных
    for (const d of fs.readdirSync(UPLOAD_DIR)) { try { const st = fs.statSync(path.join(UPLOAD_DIR, d)); if (now() - st.mtimeMs > 48 * 3600e3) rmrf(path.join(UPLOAD_DIR, d)); } catch { /* ignore */ } }
    run('DELETE FROM sessions WHERE expires_at<?', now());
    run('DELETE FROM shares WHERE expires_at<?', now() - 7 * 864e5);
  }, 3600e3).unref();

  const bye = () => { console.log('\nОстанавливаюсь…'); process.exit(0); };
  process.on('SIGINT', bye); process.on('SIGTERM', bye);
}
process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e));
process.on('uncaughtException', (e) => console.error('[uncaughtException]', e));
void ROOT; void fmtBytes; void rid; void mimeOf; void assertPublicUrl;
main();
