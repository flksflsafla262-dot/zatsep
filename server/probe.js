import fs from 'node:fs';
import path from 'node:path';
import { run, tools, updateYtdlp } from './tools.js';
import { getSettings } from './db.js';
import { COOKIES_FILE, UA } from './config.js';
import { assertPublicUrl, safeRequest, fetchText } from './ssrf.js';
import { classifyError, isParseError, isYoutubeBlock, DRM_HOSTS } from './errors.js';
import { fail, VIDEO_EXT, AUDIO_EXT, IMAGE_EXT, extOf, safeJson, tail } from './util.js';

export const YT_CLIENTS = ['tv', 'web_safari', 'mweb', 'ios', 'android_vr'];

/** Общие аргументы yt-dlp для всех операций. */
export function commonArgs({ referer, client, noCookies } = {}) {
  const s = getSettings();
  const a = ['--ignore-config', '--no-colors', '--user-agent', UA, '--socket-timeout', '30'];
  if (tools.ytdlp.jsRuntimes) a.push('--js-runtimes', 'node');
  if (s.proxy) a.push('--proxy', s.proxy);
  if (!noCookies) {
    if (fs.existsSync(COOKIES_FILE)) a.push('--cookies', COOKIES_FILE);
    else if (s.cookiesBrowser) a.push('--cookies-from-browser', s.cookiesBrowser);
  }
  if (referer) a.push('--referer', referer);
  if (client) a.push('--extractor-args', `youtube:player_client=${client}`);
  return a;
}

export const qLabel = (short, fps) => {
  const base = short >= 4320 ? '8K' : short >= 2160 ? '4K' : short >= 1440 ? '2K' : `${short}p`;
  return base + (fps > 30 ? Math.round(fps) : '');
};

const pickThumb = (info) => {
  const th = (info.thumbnails || []).filter((t) => t.url && !/\.(svg)$/i.test(t.url));
  if (th.length) {
    th.sort((a, b) => ((b.preference ?? 0) - (a.preference ?? 0)) || ((b.width || 0) * (b.height || 0) - (a.width || 0) * (a.height || 0)));
    // preference у yt-dlp: последний — лучший, поэтому берём по площади, если она известна
    const byArea = [...th].sort((a, b) => (b.width || 0) * (b.height || 0) - (a.width || 0) * (a.height || 0));
    if ((byArea[0].width || 0) > 0) return byArea[0].url;
    return th[th.length - 1].url;
  }
  return info.thumbnail || null;
};

const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };

function guessTags(info) {
  let title = info.track || info.title || '';
  let artist = info.artist || info.creator || (Array.isArray(info.artists) ? info.artists.join(', ') : '') || '';
  if (!artist) {
    const m = String(info.title || '').match(/^(.{2,80}?)\s[-–—]\s(.+)$/);
    if (m) { artist = m[1].trim(); title = m[2].trim(); }
    else artist = info.uploader || info.channel || '';
  }
  artist = String(artist).replace(/ - Topic$/i, '');
  const year = info.release_year || (info.release_date || info.upload_date || '').slice(0, 4) || '';
  return { title, artist, album: info.album || info.playlist_title || '', year: String(year || '') };
}

export function normalize(info, srcUrl) {
  const site = info.extractor_key || info.extractor || hostOf(srcUrl);
  const base = {
    kind: 'ytdlp', url: srcUrl, webpageUrl: info.webpage_url || srcUrl, site: String(site).replace(/(:.*)$/, ''), siteHost: hostOf(info.webpage_url || srcUrl),
    id: info.id, title: info.title || hostOf(srcUrl), uploader: info.uploader || info.channel || info.creator || '',
    thumbnail: pickThumb(info), listParam: /[?&]list=/.test(srcUrl) && /youtu/.test(srcUrl),
  };
  if (info._type === 'playlist' || Array.isArray(info.entries)) {
    const entries = (info.entries || []).filter(Boolean).map((e, i) => {
      let url = e.webpage_url || (e.url && /^https?:/.test(e.url) ? e.url : null);
      if (!url && e.id && /youtube/i.test(e.ie_key || '')) url = `https://www.youtube.com/watch?v=${e.id}`;
      return {
        i: i + 1, id: e.id, url, title: e.title || `#${i + 1}`, duration: e.duration || null, uploader: e.uploader || e.channel || '', thumbnail: pickThumb(e),
        image: !!(e.ext && IMAGE_EXT.has(String(e.ext).toLowerCase()) && !e.formats),
      };
    }).filter((e) => e.url);
    const carousel = entries.length > 0 && entries.every((e) => e.image);
    return { ...base, isPlaylist: true, carousel, entries, count: info.playlist_count || entries.length, truncated: (info.playlist_count || 0) > entries.length };
  }

  const duration = info.duration || 0;
  const formats = info.formats || [];
  const aonly = formats.filter((f) => f.acodec && f.acodec !== 'none' && (!f.vcodec || f.vcodec === 'none'));
  const bestA = [...aonly].sort((a, b) => (b.abr || b.tbr || 0) - (a.abr || a.tbr || 0))[0];
  const aSize = bestA ? (bestA.filesize || bestA.filesize_approx || ((bestA.abr || bestA.tbr || 0) * 125 * duration)) : 0;
  const vids = formats.filter((f) => f.vcodec && f.vcodec !== 'none' && f.height);
  const byH = new Map();
  for (const f of vids) {
    const e = byH.get(f.height) || { height: f.height, short: Math.min(f.height, f.width || f.height), fps: 0, size: 0, tbr: -1, h264: false };
    e.fps = Math.max(e.fps, f.fps || 0);
    const sz = f.filesize || f.filesize_approx || ((f.tbr || 0) * 125 * duration);
    if ((f.tbr || 0) >= e.tbr) { e.tbr = f.tbr || 0; e.size = sz + (f.acodec && f.acodec !== 'none' ? 0 : aSize); }
    if (/^(avc1|h264)/i.test(f.vcodec)) e.h264 = true;
    byH.set(f.height, e);
  }
  let qualities = [...byH.values()].sort((a, b) => b.height - a.height);
  if (qualities.some((q) => q.short > 240)) qualities = qualities.filter((q) => q.short > 240);
  qualities = qualities.map((q) => ({ height: q.height, fps: Math.round(q.fps) || 0, label: qLabel(q.short, q.fps), size: q.size ? Math.round(q.size) : null, h264: q.h264 }));
  const hasVideo = qualities.length > 0 || (!!info.vcodec && info.vcodec !== 'none') || (formats.length === 0 && VIDEO_EXT.has(String(info.ext || '').toLowerCase()));
  const hasAudio = aonly.length > 0 || formats.some((f) => f.acodec && f.acodec !== 'none') || (!!info.acodec && info.acodec !== 'none') || AUDIO_EXT.has(String(info.ext || '').toLowerCase());
  const onlyImage = !hasVideo && !hasAudio && IMAGE_EXT.has(String(info.ext || '').toLowerCase());

  const subs = [];
  for (const [lang, v] of Object.entries(info.subtitles || {})) if (lang !== 'live_chat' && v?.length) subs.push({ lang, name: v[0].name || lang, auto: false });
  const autoLangs = Object.entries(info.automatic_captions || {}).filter(([l]) => !/-orig$|live_chat/.test(l));
  const autoPick = autoLangs.filter(([l]) => ['ru', 'en', 'uk', 'de', 'es', 'fr', 'tr', 'ja'].includes(l.split('-')[0]));
  for (const [lang, v] of autoPick) if (!subs.some((s) => s.lang === lang)) subs.push({ lang, name: (v?.[0]?.name || lang) + ' (авто)', auto: true });

  return {
    ...base, isPlaylist: false, duration, uploadDate: info.upload_date ? `${info.upload_date.slice(0, 4)}-${info.upload_date.slice(4, 6)}-${info.upload_date.slice(6, 8)}` : null,
    hasVideo, hasAudio, onlyImage, qualities, live: !!info.is_live,
    audio: { abr: bestA ? Math.round(bestA.abr || bestA.tbr || 0) : 0, ext: bestA?.ext || info.ext || null, size: aSize ? Math.round(aSize) : null },
    chapters: (info.chapters || []).length, subs, tags: guessTags(info), images: [],
    size: info.filesize || info.filesize_approx || null,
  };
}

// ── yt-dlp -J ──
async function ytdlpJson(url, { playlist = false, referer, client, timeout = 60000 } = {}) {
  const args = [...commonArgs({ referer, client }), '-J', playlist ? '--yes-playlist' : '--no-playlist', '--flat-playlist', '--playlist-end', '100', '--no-warnings', url];
  const r = await run('yt-dlp', args, { timeout });
  if (r.timedOut) return { ok: false, stderr: 'timed out: yt-dlp не ответил за 60 секунд' };
  if (r.code !== 0) return { ok: false, stderr: r.stderr || String(r.error?.message || '') };
  const info = safeJson(r.stdout.slice(r.stdout.indexOf('{')));
  if (!info) return { ok: false, stderr: 'не удалось разобрать ответ yt-dlp (json)' };
  return { ok: true, info };
}

async function ytdlpJsonSmart(url, opts) {
  let r = await ytdlpJson(url, opts);
  if (r.ok) return r;
  if (isParseError(r.stderr) && !ytdlpJsonSmart.updated) {
    ytdlpJsonSmart.updated = true;
    const u = await updateYtdlp('parse-error');
    if (u.changed) r = await ytdlpJson(url, opts);
    if (r.ok) return r;
  }
  if (/youtu/i.test(url) && isYoutubeBlock(r.stderr)) {
    for (const client of YT_CLIENTS.slice(0, 3)) {
      const r2 = await ytdlpJson(url, { ...opts, client });
      if (r2.ok) return { ...r2, client };
    }
  }
  return r;
}

// ── прямые ссылки на файлы / потоки ──
const DIRECT_EXT = new Set([...VIDEO_EXT, ...AUDIO_EXT, 'm3u8', 'mpd']);
export function looksDirect(url) {
  try { return DIRECT_EXT.has(extOf(new URL(url).pathname)); } catch { return false; }
}

async function checkManifestHosts(text) {
  const hosts = new Set();
  for (const m of text.matchAll(/https?:\/\/[^\s"'<>\\]+/g)) hosts.add(m[0]);
  let n = 0;
  for (const u of hosts) { if (n++ > 40) break; await assertPublicUrl(u); }
}

export async function probeDirect(url, referer) {
  const headers = { range: 'bytes=0-0' };
  if (referer) headers.referer = referer;
  const { res, url: finalUrl } = await safeRequest(url, { headers, timeout: 20000 });
  res.destroy();
  const ct = String(res.headers['content-type'] || '').toLowerCase();
  if (res.statusCode >= 400) return null;
  if (/text\/html|application\/xhtml/.test(ct)) return null;
  const path_ = new URL(finalUrl).pathname;
  let ext = extOf(path_) || 'mp4';
  const isHls = ext === 'm3u8' || /mpegurl/.test(ct);
  const isDash = ext === 'mpd' || /dash\+xml/.test(ct);
  const total = Number((String(res.headers['content-range'] || '').split('/')[1])) || Number(res.headers['content-length']) || null;
  if (!isHls && !isDash && !DIRECT_EXT.has(ext)) {
    if (/^audio\//.test(ct)) ext = 'mp3'; else if (/^video\//.test(ct)) ext = 'mp4'; else return null;
  }
  let duration = 0;
  let hasVideo = VIDEO_EXT.has(ext), hasAudio = true, qualities = [];
  if (isHls || isDash) {
    const m = await fetchText(finalUrl, { headers: referer ? { referer } : {}, maxBytes: 1.5e6 });
    await checkManifestHosts(m.text);
    hasVideo = isDash ? /<AdaptationSet[^>]*(video|contentType="video")|mimeType="video/i.test(m.text) : /RESOLUTION=|CODECS="[^"]*(avc1|hvc1|hev1|vp09|av01)/i.test(m.text) || !/^#EXT-X-STREAM-INF/m.test(m.text);
    if (isHls) {
      const best = [...m.text.matchAll(/RESOLUTION=(\d+)x(\d+)/g)].map((x) => Math.min(+x[1], +x[2])).sort((a, b) => b - a)[0];
      if (best) qualities = [{ height: best, fps: 0, label: qLabel(best, 0), size: null, h264: true }];
    }
    if (tools.ffprobe.ok && !isDash) {
      const { ffprobe } = await import('./media.js');
      const info = await ffprobe(finalUrl, ['-protocol_whitelist', 'file,http,https,tcp,tls,crypto', ...(referer ? ['-headers', `Referer: ${referer}\r\n`] : [])]);
      if (info) { duration = info.duration; hasVideo = !!info.video; hasAudio = !!info.audio; }
    }
  }
  const name = decodeURIComponent(path.basename(path_)).replace(/\.[^.]+$/, '') || new URL(finalUrl).hostname;
  return {
    kind: isHls || isDash ? 'stream' : 'direct', url: finalUrl, webpageUrl: finalUrl, site: 'Прямая ссылка', siteHost: hostOf(finalUrl), id: name, title: name, uploader: hostOf(finalUrl),
    thumbnail: null, isPlaylist: false, duration, hasVideo, hasAudio, qualities, audio: { abr: 0, ext: AUDIO_EXT.has(ext) ? ext : null, size: null },
    chapters: 0, subs: [], tags: { title: name, artist: '', album: '', year: '' }, images: [], size: total, ext, streamType: isHls ? 'hls' : isDash ? 'dash' : null, referer: referer || null,
  };
}

// ── разбор HTML, если yt-dlp не понял страницу ──
export async function htmlFallback(url) {
  let page;
  try { page = await fetchText(url, { timeout: 20000 }); } catch { return null; }
  if (page.status >= 400 || !page.text) return null;
  const html = page.text;
  const abs = (u) => { try { return new URL(u.replace(/\\\//g, '/').replace(/&amp;/g, '&'), page.url).href; } catch { return null; } };
  const cands = [];
  const push = (u) => { const a = u && abs(u); if (a && /^https?:/.test(a) && !cands.includes(a)) cands.push(a); };
  const meta = (re) => { const m = html.match(re); return m ? m[1] : null; };
  for (const re of [
    /<meta[^>]+(?:property|name)=["'](?:og:video(?::secure_url|:url)?|twitter:player:stream|og:audio(?::secure_url|:url)?)["'][^>]+content=["']([^"']+)["']/gi,
    /<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["'](?:og:video(?::secure_url|:url)?|og:audio(?::secure_url|:url)?)["']/gi,
    /<(?:video|audio|source)[^>]+src=["']([^"']+)["']/gi,
    /"contentUrl"\s*:\s*"([^"]+)"/gi,
    /["'(]((?:https?:)?\\?\/\\?\/[^"'\s<>)]+?\.(?:m3u8|mp4|webm|mp3|m4a|flac)(?:\?[^"'\s<>)]*)?)["')]/gi,
  ]) for (const m of html.matchAll(re)) push(m[1]);
  const direct = cands.filter((c) => { try { return DIRECT_EXT.has(extOf(new URL(c).pathname)); } catch { return false; } });
  const embedMeta = cands.filter((c) => !direct.includes(c) && /youtube|vimeo|rutube|vk\.com|dailymotion|player/i.test(c));
  const iframes = [...html.matchAll(/<iframe[^>]+src=["']([^"']+)["']/gi)].map((m) => abs(m[1])).filter(Boolean);
  const title = (meta(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i) || meta(/<title[^>]*>([^<]+)<\/title>/i) || hostOf(url)).trim();
  const thumb = abs(meta(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i) || '') || null;

  for (const d of direct.sort((a, b) => (/\.m3u8/.test(a) ? 1 : 0) - (/\.m3u8/.test(b) ? 1 : 0)).slice(0, 4)) {
    try {
      const r = await probeDirect(d, page.url);
      if (r) return { ...r, title, thumbnail: thumb, webpageUrl: page.url, viaHtml: true, referer: page.url };
    } catch { /* try next */ }
  }
  for (const f of [...embedMeta, ...iframes].slice(0, 4)) {
    try {
      await assertPublicUrl(f);
      const r = await ytdlpJson(f, { referer: page.url, timeout: 45000 });
      if (r.ok) return { ...normalize(r.info, f), referer: page.url, viaHtml: true, embedUrl: f, webpageUrl: page.url, title: r.info.title || title };
    } catch { /* try next */ }
  }
  return null;
}

// ── gallery-dl: последний запасной вариант ──
export async function galleryDlProbe(url) {
  if (!tools.gallerydl.ok) return null;
  const args = ['-g'];
  if (fs.existsSync(COOKIES_FILE)) args.push('--cookies', COOKIES_FILE);
  args.push(url);
  const r = await run('gallery-dl', args, { timeout: 60000 });
  if (r.code !== 0) return null;
  const urls = r.stdout.split(/\r?\n/).map((s) => s.trim().replace(/^\|\s*/, '')).filter((s) => /^https?:/.test(s));
  if (!urls.length) return null;
  const imgs = urls.filter((u) => IMAGE_EXT.has(extOf(new URL(u).pathname)) || /format=(jpg|png|webp)/.test(u));
  const entries = urls.map((u, i) => ({ i: i + 1, id: String(i + 1), url: u, title: `${hostOf(url)} #${i + 1}`, thumbnail: imgs.includes(u) ? u : null, image: imgs.includes(u) }));
  return {
    kind: 'gallerydl', url, webpageUrl: url, site: 'gallery-dl', siteHost: hostOf(url), title: hostOf(url), uploader: '', thumbnail: imgs[0] || null, isPlaylist: true, carousel: true,
    entries, count: entries.length, images: imgs,
  };
}

/** Главная функция: разобрать ссылку. */
export async function probe(rawUrl, { playlist = false } = {}) {
  const u = await assertPublicUrl(rawUrl);
  const url = u.href;
  if (DRM_HOSTS.test(u.hostname)) fail(422, 'drm', 'Этот сервис защищён от копирования (DRM). Скачать такой контент нельзя.');

  if (looksDirect(url)) {
    try { const d = await probeDirect(url); if (d) return d; } catch (e) { if (e.status) throw e; }
  }
  if (!tools.ytdlp.ok) {
    const d = await htmlFallback(url);
    if (d) return d;
    fail(503, 'no_ytdlp', 'На сервере не установлен yt-dlp — владельцу нужно выполнить «npm run tools».');
  }

  const r = await ytdlpJsonSmart(url, { playlist });
  if (r.ok) {
    const n = normalize(r.info, url);
    if (r.client) n.client = r.client;
    // одиночный пост с картинкой (например, фото в соцсети)
    if (!n.isPlaylist && n.onlyImage) n.images = [n.thumbnail].filter(Boolean);
    if (!n.isPlaylist && !n.hasVideo && !n.hasAudio && !n.images.length && n.thumbnail) n.images = [n.thumbnail];
    return n;
  }
  const err = classifyError(r.stderr);
  if (['drm', 'rate', 'bot', 'login', 'age', 'geo', 'private', 'gone', 'live', 'network', 'timeout'].includes(err.code)) {
    fail(422, err.code, err.message, { details: tail(r.stderr, 3000) });
  }
  // yt-dlp не понял страницу — пробуем разобрать HTML самостоятельно
  const h = await htmlFallback(url);
  if (h) return h;
  const g = await galleryDlProbe(url);
  if (g) return g;
  fail(422, err.code, err.message, { details: tail(r.stderr, 3000) });
}
