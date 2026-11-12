import dns from 'node:dns';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import { getSettings } from './db.js';
import { UA } from './config.js';
import { fail } from './util.js';

export function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b, c] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 0 && c === 0) || (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) || a >= 224;
  }
  if (net.isIPv6(ip)) {
    const l = ip.toLowerCase();
    if (l === '::1' || l === '::') return true;
    const mapped = l.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateIp(mapped[1]);
    return /^f[cd]/.test(l) || /^fe[89ab]/.test(l) || l.startsWith('ff') || l.startsWith('2001:db8') || l.startsWith('64:ff9b');
  }
  return true;
}

const allowPrivate = () => getSettings().allowPrivate || process.env.ALLOW_PRIVATE === '1';

/** Проверяет, что адрес указывает на публичный хост (все его IP). */
export async function assertPublicUrl(u) {
  let url;
  try { url = new URL(u); } catch { fail(400, 'bad_url', 'Это не похоже на ссылку'); }
  if (!/^https?:$/.test(url.protocol)) fail(400, 'bad_url', 'Поддерживаются только ссылки http и https');
  if (allowPrivate()) return url;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (/^(localhost|.*\.localhost|.*\.local|.*\.internal)$/i.test(host)) fail(400, 'private_url', 'Ссылки во внутреннюю сеть запрещены');
  if (net.isIP(host)) {
    if (isPrivateIp(host)) fail(400, 'private_url', 'Ссылки во внутреннюю сеть запрещены');
    return url;
  }
  let addrs;
  try { addrs = await dns.promises.lookup(host, { all: true }); } catch { fail(400, 'dns', 'Не удалось найти такой сайт (проверь адрес)'); }
  if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) fail(400, 'private_url', 'Ссылки во внутреннюю сеть запрещены');
  return url;
}

/** lookup, проверяющий IP в момент соединения (защита от DNS rebinding). */
function safeLookup(hostname, options, cb) {
  if (typeof options === 'function') { cb = options; options = {}; }
  dns.lookup(hostname, { ...options, all: true }, (err, addrs) => {
    if (err) return cb(err);
    if (!allowPrivate() && addrs.some((a) => isPrivateIp(a.address))) return cb(new Error('private address blocked'));
    if (options && options.all) return cb(null, addrs);
    cb(null, addrs[0].address, addrs[0].family);
  });
}

/**
 * HTTP-запрос с ручной обработкой редиректов: каждый переход проверяется.
 * Возвращает { res, url } — res это IncomingMessage (поток не прочитан).
 */
export async function safeRequest(url, { method = 'GET', headers = {}, maxRedirects = 6, timeout = 30000, signal } = {}) {
  let cur = url;
  for (let i = 0; i <= maxRedirects; i++) {
    const u = await assertPublicUrl(cur);
    const lib = u.protocol === 'https:' ? https : http;
    const res = await new Promise((resolve, reject) => {
      const req = lib.request(u, {
        method, lookup: safeLookup, timeout, signal,
        headers: { 'user-agent': UA, accept: '*/*', 'accept-encoding': 'identity', ...headers },
      }, resolve);
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', reject);
      req.end();
    });
    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
      res.resume();
      cur = new URL(res.headers.location, u).href;
      continue;
    }
    return { res, url: cur };
  }
  fail(400, 'redirects', 'Слишком много перенаправлений');
}

/** Читает тело ответа с ограничением размера. */
export async function readBody(res, maxBytes = 2 * 1024 * 1024) {
  const chunks = [];
  let n = 0;
  for await (const c of res) {
    n += c.length;
    if (n > maxBytes) { res.destroy(); break; }
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

export async function fetchText(url, opts = {}) {
  const { res, url: finalUrl } = await safeRequest(url, opts);
  const buf = await readBody(res, opts.maxBytes || 2 * 1024 * 1024);
  return { status: res.statusCode, headers: res.headers, text: buf.toString('utf8'), url: finalUrl };
}
