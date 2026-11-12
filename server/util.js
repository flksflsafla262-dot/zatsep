import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export class HttpError extends Error {
  constructor(status, code, message, extra) {
    super(message || code);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}
export const fail = (status, code, message, extra) => { throw new HttpError(status, code, message, extra); };

export const now = () => Date.now();
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const rid = (n = 18) => crypto.randomBytes(n).toString('base64url');
export const sha1 = (s) => crypto.createHash('sha1').update(s).digest('hex');
export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

export function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); return p; }
export function rmrf(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* ignore */ } }
export function exists(p) { try { fs.accessSync(p); return true; } catch { return false; } }

const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
/** Безопасное имя файла: кириллица и эмодзи сохраняются, запрещённые символы убираются. */
export function sanitizeName(name, fallback = 'file') {
  let s = String(name ?? '')
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .replace(/[. ]+$/, '');
  // ограничение по длине в байтах (чтобы влезло в файловую систему)
  const enc = new TextEncoder();
  let out = '';
  for (const ch of s) {
    if (enc.encode(out + ch).length > 150) break;
    out += ch;
  }
  s = out.trim().replace(/[. ]+$/, '');
  if (!s) s = fallback;
  if (RESERVED.test(s)) s = '_' + s;
  return s;
}

export function applyTemplate(tpl, info) {
  const map = {
    title: info.title, uploader: info.uploader, artist: info.uploader, album: info.album,
    id: info.id, site: info.site, date: info.date, quality: info.quality,
  };
  const out = String(tpl || '{title}').replace(/\{(\w+)\}/g, (_, k) => (map[k] != null ? String(map[k]) : ''));
  return sanitizeName(out.replace(/\s*[-–]\s*$/, '').replace(/^\s*[-–]\s*/, ''), sanitizeName(info.title, 'file'));
}

/** Достаёт адреса из произвольного текста (из «Поделиться» в мессенджерах). */
const SCHEMELESS = /(?:^|[\s(<«"'])((?:www\.|m\.)?(?:youtu\.be|youtube\.com|music\.youtube\.com|soundcloud\.com|vk\.com|vkvideo\.ru|rutube\.ru|tiktok\.com|vm\.tiktok\.com|instagram\.com|twitter\.com|x\.com|bandcamp\.com|twitch\.tv|reddit\.com|vimeo\.com|dzen\.ru|ok\.ru|facebook\.com|fb\.watch|pinterest\.com|threads\.net|kick\.com|dailymotion\.com|mixcloud\.com)\/[^\s<>"'`]+)/gi;
export function extractUrls(text) {
  const found = [];
  const t = String(text || '');
  const re = /https?:\/\/[^\s<>"'`«»]+/gi;
  let m;
  while ((m = re.exec(t))) found.push(cleanUrl(m[0]));
  const covered = found.join(' ');
  while ((m = SCHEMELESS.exec(t))) {
    const u = cleanUrl('https://' + m[1]);
    if (!covered.includes(m[1])) found.push(u);
  }
  const seen = new Set();
  return found.filter((u) => u && !seen.has(u) && seen.add(u));
}
function cleanUrl(u) {
  let s = u.replace(/[)\]}>.,;:!?»”’'"]+$/g, '');
  // убрать лишнее «)» только если нет открывающей
  try { new URL(s); } catch { return ''; }
  return s;
}

export function contentDisposition(filename, inline = false) {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  const enc = encodeURIComponent(filename).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  return `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${enc}`;
}

export const MIME = {
  mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', mkv: 'video/x-matroska', mov: 'video/quicktime', avi: 'video/x-msvideo',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', opus: 'audio/ogg; codecs=opus', ogg: 'audio/ogg', oga: 'audio/ogg', flac: 'audio/flac', wav: 'audio/wav',
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', avif: 'image/avif',
  vtt: 'text/vtt; charset=utf-8', srt: 'text/plain; charset=utf-8', json: 'application/json; charset=utf-8',
  html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8', svg: 'image/svg+xml',
  webmanifest: 'application/manifest+json', txt: 'text/plain; charset=utf-8', zip: 'application/zip', ico: 'image/x-icon',
};
export const VIDEO_EXT = new Set(['mp4', 'mkv', 'webm', 'mov', 'm4v', 'avi', 'flv', 'ts', '3gp']);
export const AUDIO_EXT = new Set(['mp3', 'm4a', 'aac', 'opus', 'ogg', 'oga', 'flac', 'wav', 'wma', 'weba']);
export const IMAGE_EXT = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'avif', 'bmp']);
export const extOf = (f) => path.extname(f).slice(1).toLowerCase();
export const mimeOf = (f) => MIME[extOf(f)] || 'application/octet-stream';
export const mediaOfExt = (e) => (VIDEO_EXT.has(e) ? 'video' : AUDIO_EXT.has(e) ? 'audio' : IMAGE_EXT.has(e) ? 'image' : 'other');

export function fmtBytes(n) {
  if (!Number.isFinite(n)) return '—';
  const u = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n >= 100 || i === 0 ? 0 : 1)} ${u[i]}`;
}

export function safeJson(s, d = null) { try { return s ? JSON.parse(s) : d; } catch { return d; } }

export function tail(s, n = 4000) { s = String(s || ''); return s.length > n ? s.slice(-n) : s; }

export function moveFile(src, dst) {
  ensureDir(path.dirname(dst));
  try { fs.renameSync(src, dst); } catch (e) {
    if (e.code === 'EXDEV' || e.code === 'EPERM' || e.code === 'EBUSY') { fs.copyFileSync(src, dst); fs.rmSync(src, { force: true }); } else throw e;
  }
}
