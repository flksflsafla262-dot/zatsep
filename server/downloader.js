import fs from 'node:fs';
import path from 'node:path';
import { get, all, run, getSettings, filesRoot } from './db.js';
import { TMP_DIR, COOKIES_FILE } from './config.js';
import { emitUser, emitAll } from './events.js';
import { tools, run as runProc, spawnTracked, killTree, updateYtdlp } from './tools.js';
import { commonArgs, YT_CLIENTS } from './probe.js';
import { classifyError, isParseError, isYoutubeBlock } from './errors.js';
import { ffprobe, isUniversalVideo, makeThumb, convertThumbToJpg } from './media.js';
import { safeRequest, assertPublicUrl } from './ssrf.js';
import {
  fail, now, sha1, ensureDir, rmrf, exists, sanitizeName, applyTemplate, safeJson, tail, moveFile,
  extOf, mediaOfExt, VIDEO_EXT, AUDIO_EXT, IMAGE_EXT, MIME,
} from './util.js';

const running = new Map(); // jobId -> { child, aborted, ctl }
const lastEmit = new Map();
const DRM_NOTE = 'защищено от копирования';

// ───────────────────────── DTO / события ─────────────────────────
export function jobDto(r) {
  if (!r) return null;
  const opts = safeJson(r.opts, {}) || {};
  const meta = safeJson(r.meta, {}) || {};
  let thumb = null;
  if (r.has_thumb) thumb = `/api/files/${r.id}/thumb?v=${r.finished_at || 0}`;
  else if (r.thumb_url) thumb = `/api/proxy-img?u=${encodeURIComponent(r.thumb_url)}`;
  return {
    id: r.id, userId: r.user_id, shared: !!r.shared, kind: r.kind, url: r.url, status: r.status,
    progress: r.progress, speed: r.speed, eta: r.eta, title: r.title, uploader: r.uploader, album: r.album,
    duration: r.duration, thumb, site: r.site, media: r.media, ext: r.ext, size: r.size,
    vcodec: r.vcodec, acodec: r.acodec, width: r.width, height: r.height, compat: r.compat,
    errCode: r.err_code, errMsg: r.err_msg, hasLog: !!r.log, createdAt: r.created_at, finishedAt: r.finished_at, pos: r.pos,
    opts: { mode: opts.mode, height: opts.height, qualityLabel: opts.qualityLabel, container: opts.container, afmt: opts.afmt, abr: opts.abr, direct: !!opts.direct },
    meta: { warning: meta.warning, quality: meta.quality, subs: meta.subs || [], chapters: meta.chapters || 0 },
  };
}
function emitJob(r) {
  const d = jobDto(r);
  if (r.shared) emitAll('job', d); else emitUser(r.user_id, 'job', d);
}
export const getJob = (id) => get('SELECT * FROM jobs WHERE id=?', id);

const COLS = new Set(['shared', 'status', 'progress', 'speed', 'eta', 'title', 'uploader', 'album', 'duration', 'thumb_url', 'has_thumb', 'site', 'media', 'file', 'ext', 'size', 'vcodec', 'acodec', 'width', 'height', 'compat', 'compat_file', 'err_code', 'err_msg', 'log', 'meta', 'pos', 'started_at', 'finished_at', 'opts']);
function save(job, patch, { quiet = false } = {}) {
  const keys = Object.keys(patch).filter((k) => COLS.has(k));
  if (keys.length) {
    run(`UPDATE jobs SET ${keys.map((k) => `${k}=?`).join(',')} WHERE id=?`, ...keys.map((k) => (typeof patch[k] === 'object' && patch[k] !== null ? JSON.stringify(patch[k]) : patch[k])), job.id);
    Object.assign(job, patch);
  }
  if (!quiet) { lastEmit.set(job.id, now()); emitJob(getJob(job.id)); }
}
function progress(job, patch) {
  Object.assign(job, patch);
  if (now() - (lastEmit.get(job.id) || 0) < 400) return;
  save(job, patch);
}

// ───────────────────────── пути ─────────────────────────
const tmpDirOf = (job) => ensureDir(path.join(TMP_DIR, String(job.id)));
const jobDirOf = (job) => ensureDir(path.join(filesRoot(), job.shared ? 'shared' : String(job.user_id), String(job.id)));

// ───────────────────────── лимиты ─────────────────────────
export function usedBytes(userId) {
  return get('SELECT COALESCE(SUM(size),0) AS n FROM jobs WHERE user_id=?', userId).n;
}
export function totalBytes() { return get('SELECT COALESCE(SUM(size),0) AS n FROM jobs').n; }
export function freeBytes() {
  try { const s = fs.statfsSync(filesRoot()); return Number(s.bavail) * Number(s.bsize); } catch { return Infinity; }
}
export function limitsFor(user) {
  const s = getSettings();
  const owner = user.role === 'owner';
  return {
    quotaGB: user.quota_gb ?? (owner ? 0 : s.perUserGB),
    perDay: user.quota_day ?? (owner ? 0 : s.perUserPerDay),
  };
}
function checkLimits(user, count) {
  const s = getSettings();
  const l = limitsFor(user);
  if (l.perDay > 0) {
    const n = get('SELECT COUNT(*) AS n FROM jobs WHERE user_id=? AND created_at>?', user.id, now() - 864e5).n;
    if (n + count > l.perDay) fail(429, 'limit_day', `Достигнут дневной лимит загрузок (${l.perDay}). Попробуй завтра.`);
  }
  if (l.quotaGB > 0 && usedBytes(user.id) >= l.quotaGB * 1e9) fail(413, 'limit_space', 'Твоё место на диске закончилось. Удали что-нибудь из загрузок.');
  if (s.maxTotalGB > 0 && totalBytes() >= s.maxTotalGB * 1e9) fail(413, 'limit_total', 'Общий лимит места на сервере исчерпан.');
  if (freeBytes() < 300e6) fail(507, 'space', 'На диске сервера почти не осталось места.');
}
function maxFilesize(user) {
  const l = limitsFor(user);
  let m = freeBytes() - 200e6;
  if (l.quotaGB > 0) m = Math.min(m, l.quotaGB * 1e9 - usedBytes(user.id));
  const s = getSettings();
  if (s.maxTotalGB > 0) m = Math.min(m, s.maxTotalGB * 1e9 - totalBytes());
  return Number.isFinite(m) ? Math.max(Math.floor(m), 1e6) : 0;
}

// ───────────────────────── постановка в очередь ─────────────────────────
export function canonicalUrl(u) {
  try {
    const x = new URL(u);
    if (x.hostname === 'youtu.be') return `https://www.youtube.com/watch?v=${x.pathname.slice(1)}`;
    for (const k of [...x.searchParams.keys()]) if (/^(t|si|feature|pp|fbclid|igsh|igshid|utm_.*|is_from_webapp|sender_device|share_.*)$/i.test(k)) x.searchParams.delete(k);
    if (/youtube/.test(x.hostname) && x.searchParams.get('v')) { const v = x.searchParams.get('v'); x.search = `?v=${v}`; }
    x.hash = '';
    return x.href;
  } catch { return u; }
}
function dedupeKey(userId, url, o) {
  return sha1([userId, canonicalUrl(url), o.mode, o.height || '', o.container || '', o.afmt || '', o.abr || '', o.clip?.from || '', o.clip?.to || '', (o.subs?.langs || []).join(','), o.subs?.embed ? 1 : 0, o.sponsorblock ? 1 : 0].join('|'));
}
const clean = (s, n = 300) => (s == null ? null : String(s).slice(0, n));
const timeRe = /^\d{1,2}(:\d{1,2}){0,2}(\.\d+)?$/;

export function sanitizeOpts(o = {}) {
  const s = getSettings();
  const mode = ['video', 'audio', 'image'].includes(o.mode) ? o.mode : 'video';
  const out = { mode };
  if (o.height != null && Number(o.height) > 0) out.height = Math.min(Math.round(Number(o.height)), 8640);
  out.qualityLabel = clean(o.qualityLabel, 20);
  out.container = ['mp4', 'mkv', 'webm'].includes(o.container) ? o.container : s.defaultContainer || 'mp4';
  out.afmt = ['best', 'mp3', 'm4a', 'opus', 'flac', 'wav'].includes(o.afmt) ? o.afmt : s.defaultAudio || 'best';
  out.abr = [128, 192, 256, 320].includes(Number(o.abr)) ? Number(o.abr) : 320;
  if (o.clip && (o.clip.from || o.clip.to)) {
    const f = String(o.clip.from || '').trim(), t = String(o.clip.to || '').trim();
    if ((f && !timeRe.test(f)) || (t && !timeRe.test(t))) fail(400, 'bad_clip', 'Время фрагмента нужно указать как 1:23 или 83');
    out.clip = { from: f, to: t };
  }
  out.embedThumb = o.embedThumb !== false;
  out.chapters = o.chapters !== false;
  if (o.tags && typeof o.tags === 'object') out.tags = { title: clean(o.tags.title, 200) || '', artist: clean(o.tags.artist, 200) || '', album: clean(o.tags.album, 200) || '', year: clean(o.tags.year, 10) || '' };
  out.tagsEdited = !!o.tagsEdited;
  if (o.subs && Array.isArray(o.subs.langs) && o.subs.langs.length) {
    out.subs = { langs: o.subs.langs.map((l) => String(l).replace(/[^\w.-]/g, '').slice(0, 20)).filter(Boolean).slice(0, 8), fmt: o.subs.fmt === 'vtt' ? 'vtt' : 'srt', embed: !!o.subs.embed, auto: !!o.subs.auto };
  }
  out.sponsorblock = !!o.sponsorblock;
  out.direct = !!o.direct; // «сразу на устройство»: файл отдаётся браузеру и удаляется с сервера
  if (o.referer) out.referer = clean(o.referer, 500);
  if (o.expSize) out.expSize = Number(o.expSize) || 0;
  if (o.streamType) out.streamType = o.streamType;
  if (o.page) out.page = clean(o.page, 500);
  return out;
}

/** items: [{url, title, uploader, thumbnail, duration, site, kind}] */
export async function enqueue(user, { items, opts, force = false, shared = false }) {
  if (!Array.isArray(items) || !items.length) fail(400, 'no_items', 'Нет ссылок для скачивания');
  if (items.length > 300) fail(400, 'too_many', 'Слишком много ссылок за раз (максимум 300)');
  if (!tools.ytdlp.ok && items.some((i) => !['direct', 'stream', 'image'].includes(i.kind))) fail(503, 'no_ytdlp', 'На сервере не установлен yt-dlp — владельцу нужно выполнить «npm run tools».');
  if (!tools.ffmpeg.ok) fail(503, 'no_ffmpeg', 'На сервере не установлен ffmpeg — владельцу нужно выполнить «npm run tools».');
  checkLimits(user, items.length);
  const o = sanitizeOpts(opts);
  const out = { jobs: [], duplicates: [] };
  const maxPos = get('SELECT COALESCE(MAX(pos),0) AS m FROM jobs').m;
  let p = maxPos;
  for (const it of items) {
    const url = String(it.url || '');
    await assertPublicUrl(url);
    const kind = ['ytdlp', 'direct', 'stream', 'image'].includes(it.kind) ? it.kind : 'ytdlp';
    const jo = { ...o, mode: kind === 'image' ? 'image' : o.mode };
    if (it.referer) jo.referer = clean(it.referer, 500);
    if (it.expSize) jo.expSize = Number(it.expSize) || 0;
    if (it.streamType) jo.streamType = it.streamType;
    if (it.page) jo.page = clean(it.page, 500);
    const key = dedupeKey(user.id, url, jo);
    if (!force) {
      const dup = get("SELECT * FROM jobs WHERE user_id=? AND dedupe=? AND status='done' ORDER BY id DESC LIMIT 1", user.id, key);
      if (dup && dup.file && exists(dup.file)) { out.duplicates.push({ url, job: jobDto(dup) }); continue; }
      const act = get("SELECT * FROM jobs WHERE user_id=? AND dedupe=? AND status IN ('queued','downloading','processing','paused') LIMIT 1", user.id, key);
      if (act) { out.duplicates.push({ url, job: jobDto(act), active: true }); continue; }
    }
    const r = run(`INSERT INTO jobs(user_id,shared,kind,url,opts,dedupe,status,title,uploader,duration,thumb_url,site,media,pos,created_at,meta)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      user.id, shared && user.role === 'owner' ? 1 : 0, kind, url, JSON.stringify(jo), key, 'queued', clean(it.title) || url, clean(it.uploader), Number(it.duration) || null,
      clean(it.thumbnail, 800), clean(it.site, 60), jo.mode === 'audio' ? 'audio' : jo.mode === 'image' ? 'image' : 'video', ++p, now(), JSON.stringify({ quality: jo.qualityLabel }));
    const row = getJob(Number(r.lastInsertRowid));
    out.jobs.push(jobDto(row));
    emitJob(row);
  }
  setImmediate(tick);
  return out;
}

// ───────────────────────── планировщик ─────────────────────────
export function tick() {
  const max = Math.max(1, Math.min(10, Number(getSettings().maxConcurrent) || 3));
  const free = max - running.size;
  if (free <= 0) return;
  const rows = all("SELECT * FROM jobs WHERE status='queued' ORDER BY pos, id LIMIT ?", free);
  for (const row of rows) {
    if (running.has(row.id)) continue;
    start(row);
  }
}

function start(row) {
  const ctl = { child: null, aborted: null };
  running.set(row.id, ctl);
  const job = row;
  save(job, { status: 'downloading', progress: 0, speed: null, eta: null, err_code: null, err_msg: null, started_at: now() });
  (async () => {
    try {
      if (job.kind === 'ytdlp') await runYtdlp(job, ctl);
      else if (job.kind === 'direct') await runDirect(job, ctl);
      else if (job.kind === 'stream') await runStream(job, ctl);
      else if (job.kind === 'image') await runImage(job, ctl);
      else if (job.kind === 'convert') await runConvert(job, ctl);
      else throw Object.assign(new Error('unknown kind'), { jobError: { code: 'unknown', message: 'Неизвестный тип задачи' } });
    } catch (e) {
      if (e && e.aborted) {
        if (e.aborted === 'cancel') { rmrf(tmpDirOf(job)); if (getJob(job.id)) save(job, { status: 'canceled', speed: null, eta: null }); }
        else if (e.aborted === 'pause') save(job, { status: 'paused', speed: null, eta: null });
      } else {
        const je = e?.jobError || { code: 'unknown', message: 'Внутренняя ошибка: ' + String(e?.message || e).slice(0, 200) };
        console.error(`[job ${job.id}] ошибка ${je.code}:`, e?.stack || e);
        failJob(job, je.code, je.message, e?.log || String(e?.stack || e));
      }
    } finally {
      running.delete(job.id);
      lastEmit.delete(job.id);
      setImmediate(tick);
    }
  })();
}

function failJob(job, code, message, log) {
  console.warn(`[job ${job.id}] ✗ ${code}: ${message}\n${tail(log, 1200)}`);
  save(job, { status: 'error', err_code: code, err_msg: message, log: tail(log, 8000), speed: null, eta: null, finished_at: now() });
  rmrf(path.join(TMP_DIR, String(job.id)));
}

// ───────────────────────── общие утилиты процессов ─────────────────────────
function lineSplitter(cb) {
  let buf = '';
  return (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.search(/\r|\n/)) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); if (l) cb(l); }
    if (buf.length > 20000) buf = '';
  };
}
const num = (s) => { const n = Number(s); return s && s !== 'NA' && s !== 'None' && Number.isFinite(n) ? n : null; };
function abortIfNeeded(ctl) { if (ctl.aborted) throw Object.assign(new Error('aborted'), { aborted: ctl.aborted }); }

function spawnWatch(job, ctl, cmd, args, { onLine, cwd } = {}) {
  return new Promise((resolve) => {
    let stderr = '', stdout = '';
    const child = spawnTracked(cmd, args, { cwd, env: process.env });
    ctl.child = child;
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    const feedOut = lineSplitter((l) => { stdout = tail(stdout + l + '\n', 20000); onLine?.(l, false); });
    const feedErr = lineSplitter((l) => { stderr = tail(stderr + l + '\n', 60000); onLine?.(l, true); });
    child.stdout.on('data', feedOut);
    child.stderr.on('data', feedErr);
    child.on('error', (e) => { stderr += String(e.message); resolve({ code: -1, stderr, stdout }); });
    child.on('close', (code) => resolve({ code, stderr, stdout }));
  });
}

// ───────────────────────── yt-dlp ─────────────────────────
function buildYtdlpArgs(job, o, { client, noEmbedThumb, container, user }) {
  const tmp = tmpDirOf(job);
  const args = [
    ...commonArgs({ referer: o.referer, client }),
    '--newline', '--no-playlist', '--retries', '10', '--fragment-retries', '20', '--concurrent-fragments', '4',
    '--no-mtime', '--write-info-json', '--no-warnings',
    '--progress-template', 'download:[[P]]%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s|%(progress.speed)s|%(progress.eta)s|%(info.format_id)s',
    '-o', path.join(tmp, 'media.%(ext)s'),
    '--write-thumbnail', '--convert-thumbnails', 'jpg',
  ];
  const mf = maxFilesize(user);
  if (mf) args.push('--max-filesize', String(mf));
  if (o.mode === 'audio') {
    args.push('-f', 'ba/b', '-x', '--audio-format', o.afmt || 'best');
    if (['mp3', 'm4a'].includes(o.afmt)) args.push('--audio-quality', `${o.abr || 320}K`);
    args.push('--embed-metadata');
    if (o.embedThumb && !noEmbedThumb) args.push('--embed-thumbnail');
    if (o.chapters) args.push('--embed-chapters');
  } else {
    const H = o.height;
    const cap = H ? `[height<=${H}]` : '';
    let f = H ? `bv*${cap}+ba/b${cap}/bv*+ba/b` : 'bv*+ba/b';
    if (container === 'webm') f = `bv*[ext=webm]${cap}+ba[ext=webm]/` + f;
    args.push('-f', f, '-S', 'res,fps,vcodec:h264,acodec:m4a', '--merge-output-format', container === 'webm' ? 'webm/mkv' : container || 'mp4');
    args.push('--embed-metadata');
    if (o.chapters) args.push('--embed-chapters');
  }
  if (o.clip) {
    const f = o.clip.from || '0', t = o.clip.to || 'inf';
    args.push('--download-sections', `*${f}-${t}`);
  }
  if (o.subs) {
    args.push('--write-subs', '--sub-langs', o.subs.langs.join(','), '--convert-subs', o.subs.fmt === 'vtt' ? 'vtt' : 'srt');
    if (o.subs.auto) args.push('--write-auto-subs');
    if (o.subs.embed && o.mode !== 'audio') args.push('--embed-subs');
  }
  if (o.sponsorblock) args.push('--sponsorblock-remove', 'sponsor,selfpromo,interaction,intro,outro,preview,music_offtopic');
  args.push(job.url);
  return args;
}

async function runYtdlp(job, ctl) {
  const o = safeJson(job.opts, {});
  const user = get('SELECT * FROM users WHERE id=?', job.user_id);
  if (!user) throw Object.assign(new Error('no user'), { aborted: 'cancel' });
  const tmp = tmpDirOf(job);
  const isYt = /youtu/i.test(job.url);
  let updated = false, noThumb = false, timeoutRetried = false, container = o.container, clientIdx = -1, client, attempts = 0;
  let res, lastLog = '';
  const streams = new Map();
  let speedEma = 0;

  const onLine = (l) => {
    if (l.startsWith('[[P]]')) {
      const p = l.slice(5).split('|');
      const dl = num(p[0]) || 0, tot = num(p[1]) || num(p[2]) || 0, spd = num(p[3]), eta = num(p[4]), fid = p[5] || '0';
      streams.set(fid, { dl, tot });
      let sd = 0, st = 0;
      for (const s of streams.values()) { sd += s.dl; st += s.tot; }
      const expected = Math.max(o.expSize || 0, st);
      const pct = expected ? Math.min(sd / expected, 0.99) * 100 : 0;
      if (spd != null) speedEma = speedEma ? speedEma * 0.75 + spd * 0.25 : spd;
      progress(job, { status: 'downloading', progress: Math.max(job.progress || 0, pct), speed: speedEma || null, eta: eta });
    } else if (/^\[(Merger|ExtractAudio|VideoConvertor|EmbedThumbnail|Metadata|ModifyChapters|EmbedSubtitle|FixupM3u8|FixupM4a|ThumbnailsConvertor|SponsorBlock|VideoRemuxer|SubtitlesConvertor|Fixup\w*)\]/.test(l)) {
      progress(job, { status: 'processing', progress: 100, speed: null, eta: null });
    }
  };

  for (;;) {
    attempts++;
    abortIfNeeded(ctl);
    streams.clear();
    const args = buildYtdlpArgs(job, o, { client, noEmbedThumb: noThumb, container, user });
    res = await spawnWatch(job, ctl, 'yt-dlp', args, { onLine });
    abortIfNeeded(ctl);
    lastLog = res.stderr;
    if (res.code === 0) break;
    const err = classifyError(res.stderr);
    console.warn(`[job ${job.id}] yt-dlp код ${res.code}, попытка ${attempts}: ${err.code}`);
    if (attempts >= 8) break;
    if (/embed.*thumbnail|thumbnail.*(mutagen|atomicparsley|could not)|Postprocessing: .*thumbnail/i.test(res.stderr) && !noThumb && o.mode === 'audio') { noThumb = true; continue; }
    if (/postprocessing|conversion failed|could not write header|muxer/i.test(res.stderr) && container === 'mp4' && o.mode === 'video') { container = 'mkv'; continue; }
    if (isParseError(res.stderr) && !updated) { updated = true; save(job, { status: 'downloading' }); await updateYtdlp('retry'); continue; }
    if (isYt && isYoutubeBlock(res.stderr) && clientIdx < YT_CLIENTS.length - 1) { client = YT_CLIENTS[++clientIdx]; continue; }
    if (err.code === 'timeout' && !timeoutRetried) { timeoutRetried = true; continue; }
    break;
  }

  if (res.code !== 0) {
    const err = classifyError(res.stderr);
    throw Object.assign(new Error(err.message), { jobError: err, log: lastLog });
  }
  progress(job, { status: 'processing', progress: 100, speed: null, eta: null });
  save(job, {});

  // ── собираем результат ──
  const files = fs.readdirSync(tmp);
  let info = {};
  const ij = files.find((f) => f === 'media.info.json');
  if (ij) info = safeJson(fs.readFileSync(path.join(tmp, ij), 'utf8'), {}) || {};
  const want = o.mode === 'audio' ? AUDIO_EXT : new Set([...VIDEO_EXT, ...AUDIO_EXT]);
  const cands = files.filter((f) => /^media\.[a-z0-9]+$/i.test(f) && want.has(extOf(f))).map((f) => ({ f, size: fs.statSync(path.join(tmp, f)).size })).sort((a, b) => b.size - a.size);
  if (!cands.length) throw Object.assign(new Error('empty'), { jobError: { code: 'unknown', message: 'yt-dlp завершился, но файла нет. Подробности по кнопке.' }, log: lastLog });
  const patch = {
    title: job.title && job.title !== job.url && !/^#\d+$/.test(job.title) ? job.title : (info.track || info.title || job.title),
    uploader: info.artist || info.creator || info.uploader || info.channel || job.uploader,
    album: info.album || null,
    duration: info.duration || job.duration,
    site: info.extractor_key || job.site,
    chapters: (info.chapters || []).length,
  };
  await finishFile(job, path.join(tmp, cands[0].f), patch, { thumbSrc: files.find((f) => /^media\.(jpg|jpeg|png|webp)$/i.test(f)), tmp, id: info.id });
}

// ───────────────────────── прямые файлы ─────────────────────────
async function runDirect(job, ctl) {
  const o = safeJson(job.opts, {});
  const user = get('SELECT * FROM users WHERE id=?', job.user_id);
  const tmp = tmpDirOf(job);
  const part = path.join(tmp, 'media.part');
  const mf = maxFilesize(user);
  let have = exists(part) ? fs.statSync(part).size : 0;
  let url = job.url, total = null, finalExt = null, filename = null, tries = 0;
  const controller = new AbortController();
  ctl.child = { kill: () => controller.abort(), killed: false, exitCode: null, pid: 0, _custom: true };
  let lastT = now(), lastB = have, ema = 0;

  for (;;) {
    abortIfNeeded(ctl);
    try {
      const headers = {};
      if (o.referer) headers.referer = o.referer;
      if (have > 0) headers.range = `bytes=${have}-`;
      const { res, url: finalUrl } = await safeRequest(url, { headers, timeout: 30000, signal: controller.signal });
      if (res.statusCode === 416) { res.resume(); break; }
      if (res.statusCode >= 400) { res.resume(); throw Object.assign(new Error('HTTP ' + res.statusCode), { jobError: classifyError(`HTTP Error ${res.statusCode}`), log: `HTTP ${res.statusCode} ${finalUrl}` }); }
      if (have > 0 && res.statusCode === 200) { have = 0; fs.rmSync(part, { force: true }); }
      const cr = String(res.headers['content-range'] || '').split('/')[1];
      total = Number(cr) || (Number(res.headers['content-length']) + have) || null;
      if (mf && total && total > mf) { res.resume(); throw Object.assign(new Error('big'), { jobError: classifyError('max-filesize'), log: 'file too large' }); }
      const cd = String(res.headers['content-disposition'] || '').match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i);
      if (cd) { try { filename = decodeURIComponent(cd[1]); } catch { filename = cd[1]; } }
      const ct = String(res.headers['content-type'] || '').toLowerCase();
      finalExt = extOf(new URL(finalUrl).pathname) || extOf(filename || '') || (ct.startsWith('audio/') ? 'mp3' : ct.startsWith('video/') ? 'mp4' : ct.startsWith('image/') ? ct.split('/')[1].replace('jpeg', 'jpg') : 'bin');
      if (/text\/html/.test(ct)) throw Object.assign(new Error('html'), { jobError: { code: 'unsupported', message: 'По этой ссылке открывается страница, а не файл.' }, log: ct });
      const out = fs.createWriteStream(part, { flags: have > 0 ? 'a' : 'w' });
      await new Promise((resolve, reject) => {
        res.on('data', (c) => {
          have += c.length;
          if (mf && have > mf) { controller.abort(); return reject(Object.assign(new Error('big'), { jobError: classifyError('max-filesize') })); }
          const t = now();
          if (t - lastT > 500) { const sp = (have - lastB) / ((t - lastT) / 1000); ema = ema ? ema * 0.7 + sp * 0.3 : sp; lastT = t; lastB = have; progress(job, { progress: total ? Math.min(99, (have / total) * 100) : 0, speed: ema, eta: total && ema ? (total - have) / ema : null }); }
        });
        res.on('error', reject);
        res.on('aborted', () => reject(new Error('connection aborted')));
        res.pipe(out);
        out.on('finish', resolve);
        out.on('error', reject);
      });
      if (total && have < total) throw new Error('short read');
      break;
    } catch (e) {
      abortIfNeeded(ctl);
      if (e.jobError) throw e;
      if (++tries > 6) throw Object.assign(e, { jobError: classifyError('timed out ' + e.message), log: String(e.stack || e) });
      await new Promise((r) => setTimeout(r, 1500 * tries));
      have = exists(part) ? fs.statSync(part).size : 0;
    }
  }
  progress(job, { status: 'processing', progress: 100, speed: null, eta: null });
  const base = sanitizeName((filename || decodeURIComponent(path.basename(new URL(url).pathname)) || 'file').replace(/\.[^.]+$/, ''));
  const finalPath = path.join(tmp, `media.${finalExt}`);
  fs.renameSync(part, finalPath);
  await finishFile(job, finalPath, { title: job.title && job.title !== job.url ? job.title : base }, { tmp });
}

// ───────────────────────── HLS / DASH через ffmpeg ─────────────────────────
async function runStream(job, ctl) {
  const o = safeJson(job.opts, {});
  const tmp = tmpDirOf(job);
  await assertPublicUrl(job.url);
  const pi = await ffprobe(job.url, ['-protocol_whitelist', 'file,http,https,tcp,tls,crypto', ...(o.referer ? ['-headers', `Referer: ${o.referer}\r\n`] : [])]);
  const duration = pi?.duration || job.duration || 0;
  const audioOnly = o.mode === 'audio' || (pi && !pi.video);
  const outExt = audioOnly ? (o.afmt && o.afmt !== 'best' ? o.afmt : 'm4a') : o.container === 'mkv' ? 'mkv' : 'mp4';
  const out = path.join(tmp, `media.${outExt}`);
  const base = ['-hide_banner', '-nostdin', '-y', '-protocol_whitelist', 'file,http,https,tcp,tls,crypto', '-user_agent', 'Mozilla/5.0'];
  if (o.referer) base.push('-headers', `Referer: ${o.referer}\r\n`);
  const tryRun = async (extra) => {
    const args = [...base, '-i', job.url, ...extra, '-progress', 'pipe:1', '-nostats', out];
    let ema = 0, lastT = now(), lastMs = 0;
    return spawnWatch(job, ctl, 'ffmpeg', args, {
      onLine: (l) => {
        const m = l.match(/^out_time_(?:us|ms)=(\d+)/);
        if (m) {
          const sec = Number(m[1]) / 1e6;
          const t = now();
          if (t - lastT > 500) { const sp = (sec - lastMs) / ((t - lastT) / 1000); ema = ema ? ema * 0.7 + sp * 0.3 : sp; lastMs = sec; lastT = t; }
          progress(job, { progress: duration ? Math.min(99, (sec / duration) * 100) : 0, eta: duration && ema ? (duration - sec) / ema : null, speed: null });
        }
      },
    });
  };
  let r = await tryRun(audioOnly ? ['-vn', '-c:a', outExt === 'm4a' ? 'copy' : 'libmp3lame'] : ['-map', '0:v:0?', '-map', '0:a:0?', '-c', 'copy', ...(outExt === 'mp4' ? ['-bsf:a', 'aac_adtstoasc', '-movflags', '+faststart'] : [])]);
  abortIfNeeded(ctl);
  if (r.code !== 0 && !audioOnly) { fs.rmSync(out, { force: true }); r = await tryRun(['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-c:a', 'aac']); abortIfNeeded(ctl); }
  if (r.code !== 0 || !exists(out)) throw Object.assign(new Error('ffmpeg'), { jobError: classifyError(r.stderr), log: r.stderr });
  progress(job, { status: 'processing', progress: 100 });
  await finishFile(job, out, { title: job.title && job.title !== job.url ? job.title : 'stream', duration }, { tmp });
}

// ───────────────────────── картинки ─────────────────────────
async function runImage(job, ctl) {
  const o = safeJson(job.opts, {});
  const tmp = tmpDirOf(job);
  const headers = o.referer || o.page ? { referer: o.referer || o.page } : {};
  const { res, url } = await safeRequest(job.url, { headers, timeout: 30000 });
  if (res.statusCode >= 400) { res.resume(); throw Object.assign(new Error('HTTP'), { jobError: classifyError(`HTTP Error ${res.statusCode}`) }); }
  const ct = String(res.headers['content-type'] || '').toLowerCase();
  let ext = extOf(new URL(url).pathname);
  if (!IMAGE_EXT.has(ext)) ext = ct.includes('png') ? 'png' : ct.includes('webp') ? 'webp' : ct.includes('gif') ? 'gif' : ct.includes('avif') ? 'avif' : 'jpg';
  if (ext === 'jpeg') ext = 'jpg';
  const file = path.join(tmp, `media.${ext}`);
  let n = 0;
  const max = 60e6;
  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(file);
    res.on('data', (c) => { n += c.length; if (n > max) { res.destroy(new Error('too big')); } });
    res.on('error', reject); out.on('error', reject); out.on('finish', resolve);
    res.pipe(out);
    ctl.child = { kill: () => res.destroy(), killed: false, exitCode: null, pid: 0, _custom: true };
  });
  abortIfNeeded(ctl);
  await finishFile(job, file, { title: job.title && job.title !== job.url ? job.title : 'image' }, { tmp, noThumb: false, imageIsThumb: true });
}

// ───────────────────────── конвертация ─────────────────────────
async function runConvert(job, ctl) {
  const o = safeJson(job.opts, {});
  const src = get('SELECT * FROM jobs WHERE id=?', o.srcId);
  if (!src || !src.file || !exists(src.file)) throw Object.assign(new Error('nosrc'), { jobError: { code: 'gone', message: 'Исходный файл не найден.' } });
  const tmp = tmpDirOf(job);
  const to = o.to;
  const out = path.join(tmp, `media.${to}`);
  const info = await ffprobe(src.file);
  const duration = info?.duration || src.duration || 0;
  const A = { mp3: ['-c:a', 'libmp3lame', '-b:a', `${o.abr || 192}k`], m4a: ['-c:a', 'aac', '-b:a', `${o.abr || 192}k`], opus: ['-c:a', 'libopus', '-b:a', `${Math.min(o.abr || 160, 256)}k`], flac: ['-c:a', 'flac'], wav: ['-c:a', 'pcm_s16le'] };
  let args;
  if (A[to]) {
    args = ['-vn', '-map', '0:a:0', ...A[to]];
    if (!info?.video && info?.hasCover && ['mp3', 'm4a', 'flac'].includes(to)) args = ['-map', '0:a:0', '-map', '0:v:0?', ...A[to], '-c:v', 'copy', '-disposition:v', 'attached_pic', ...(to === 'mp3' ? ['-id3v2_version', '3'] : [])];
    args.push('-map_metadata', '0');
  } else {
    const vf = o.height ? ['-vf', `scale=-2:'min(${o.height},ih)'`] : [];
    if (to === 'webm') args = ['-map', '0:v:0', '-map', '0:a:0?', '-c:v', 'libvpx-vp9', '-crf', '33', '-b:v', '0', '-deadline', 'realtime', '-cpu-used', '5', '-c:a', 'libopus', ...vf];
    else args = ['-map', '0:v:0', '-map', '0:a:0?', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '160k', ...(to === 'mp4' ? ['-movflags', '+faststart'] : []), ...vf];
    args.push('-map_metadata', '0');
  }
  let ema = 0, lastT = now(), lastS = 0;
  const r = await spawnWatch(job, ctl, 'ffmpeg', ['-hide_banner', '-nostdin', '-y', '-i', src.file, ...args, '-progress', 'pipe:1', '-nostats', out], {
    onLine: (l) => {
      const m = l.match(/^out_time_(?:us|ms)=(\d+)/);
      if (m) {
        const sec = Number(m[1]) / 1e6; const t = now();
        if (t - lastT > 500) { const sp = (sec - lastS) / ((t - lastT) / 1000); ema = ema ? ema * 0.7 + sp * 0.3 : sp; lastS = sec; lastT = t; }
        progress(job, { progress: duration ? Math.min(99, (sec / duration) * 100) : 0, eta: duration && ema ? (duration - sec) / ema : null });
      }
    },
  });
  abortIfNeeded(ctl);
  if (r.code !== 0 || !exists(out)) throw Object.assign(new Error('ffmpeg'), { jobError: { code: 'unknown', message: 'Не удалось сконвертировать файл.' }, log: r.stderr });
  progress(job, { status: 'processing', progress: 100 });
  const patch = { title: job.title, uploader: src.uploader, album: src.album, duration, site: 'Конвертация' };
  let thumbSrc;
  const srcThumb = path.join(path.dirname(src.file), 'thumb.jpg');
  if (exists(srcThumb)) { fs.copyFileSync(srcThumb, path.join(tmp, 'media.jpg')); thumbSrc = 'media.jpg'; }
  await finishFile(job, out, patch, { tmp, thumbSrc });
}

// ───────────────────────── завершение: проверка → имя → файл ─────────────────────────
async function finishFile(job, srcFile, meta, { thumbSrc, tmp, id, noThumb } = {}) {
  const o = safeJson(job.opts, {});
  const s = getSettings();
  let info = await ffprobe(srcFile);
  const ext0 = extOf(srcFile);
  let media = mediaOfExt(ext0);
  if (info) media = info.video ? 'video' : info.audio ? 'audio' : media;
  if (o.mode === 'image') media = 'image';
  if (!info && tools.ffprobe.ok && media !== 'image') throw Object.assign(new Error('bad file'), { jobError: { code: 'unknown', message: 'Скачанный файл повреждён или не опознан.' } });
  if (media === 'video' && o.mode === 'video' && info && !info.video) throw Object.assign(new Error('novideo'), { jobError: { code: 'unknown', message: 'В скачанном файле нет видео.' } });
  if (o.mode === 'audio' && info && !info.audio) throw Object.assign(new Error('noaudio'), { jobError: { code: 'unknown', message: 'В скачанном файле нет звука.' } });
  if (info && info.duration > 0 === false && media !== 'image' && job.kind !== 'convert') { /* допускаем без длительности (потоки) */ }

  let warning = null;
  if (media === 'video' && info && !info.audio) warning = 'В видео нет звуковой дорожки';

  // теги для музыки (если пользователь их правил)
  let tagsFile = srcFile;
  if (media === 'audio' && o.tagsEdited && o.tags && tools.ffmpeg.ok) {
    const tagged = path.join(path.dirname(srcFile), `tagged.${ext0}`);
    const m = [];
    if (o.tags.title) m.push('-metadata', `title=${o.tags.title}`);
    if (o.tags.artist) m.push('-metadata', `artist=${o.tags.artist}`, '-metadata', `album_artist=${o.tags.artist}`);
    if (o.tags.album) m.push('-metadata', `album=${o.tags.album}`);
    if (o.tags.year) m.push('-metadata', `date=${o.tags.year}`);
    const r = await runProc('ffmpeg', ['-hide_banner', '-nostdin', '-y', '-i', srcFile, '-map', '0', '-c', 'copy', ...m, ...(ext0 === 'mp3' ? ['-id3v2_version', '3'] : []), tagged], { timeout: 300000 });
    if (r.code === 0 && exists(tagged)) { fs.rmSync(srcFile, { force: true }); fs.renameSync(tagged, srcFile); tagsFile = srcFile; }
    meta = { ...meta, title: o.tags.title || meta.title, uploader: o.tags.artist || meta.uploader, album: o.tags.album || meta.album };
  }
  void tagsFile;

  const title = clean(meta.title || job.title || 'file', 250);
  const quality = media === 'video' && info?.video ? `${info.video.height}p` : '';
  const name = applyTemplate(s.nameTemplate, { title, uploader: meta.uploader, album: meta.album, id: id || job.id, site: meta.site || job.site, date: new Date().toISOString().slice(0, 10), quality });
  const dir = jobDirOf(job);
  const finalPath = path.join(dir, `${name}.${ext0}`);
  moveFile(srcFile, finalPath);

  // превью
  let hasThumb = 0;
  const thumbDest = path.join(dir, 'thumb.jpg');
  if (thumbSrc && tmp && exists(path.join(tmp, thumbSrc))) {
    const ts = path.join(tmp, thumbSrc);
    hasThumb = extOf(thumbSrc) === 'jpg' ? (moveFile(ts, thumbDest), 1) : (await convertThumbToJpg(ts, thumbDest) ? 1 : 0);
  }
  if (!hasThumb && media === 'image') hasThumb = (await convertThumbToJpg(finalPath, thumbDest)) ? 1 : 0;
  if (!hasThumb && media !== 'image' && info) hasThumb = (await makeThumb(finalPath, thumbDest, info)) ? 1 : 0;

  // субтитры
  const subs = [];
  if (tmp) {
    for (const f of fs.readdirSync(tmp)) {
      const m = f.match(/^media\.(.+)\.(vtt|srt)$/i);
      if (m) { const sd = ensureDir(path.join(dir, 'subs')); moveFile(path.join(tmp, f), path.join(sd, `${m[1]}.${m[2].toLowerCase()}`)); subs.push({ lang: m[1], ext: m[2].toLowerCase() }); }
    }
  }
  const stat = fs.statSync(finalPath);
  const compatNeeded = media === 'video' && info?.video && !isUniversalVideo(info);
  save(job, {
    status: 'done', progress: 100, speed: null, eta: null, title, uploader: clean(meta.uploader), album: clean(meta.album), duration: info?.duration || meta.duration || job.duration || null,
    site: clean(meta.site || job.site, 60), media, file: finalPath, ext: ext0, size: stat.size, vcodec: info?.video?.codec || null, acodec: info?.audio?.codec || null,
    width: info?.video?.width || null, height: info?.video?.height || null, has_thumb: hasThumb, compat: compatNeeded ? 'pending' : 'none', finished_at: now(), err_code: null, err_msg: null,
    meta: { warning, quality: o.qualityLabel || (quality || undefined), subs, chapters: meta.chapters || 0 },
  });
  if (tmp) rmrf(tmp);
  if (compatNeeded) queueCompat(job.id);
  void noThumb; void DRM_NOTE; void MIME;
}

// ───────────────────────── совместимая копия для встроенного плеера ─────────────────────────
const compatQueue = [];
let compatBusy = false;
export function queueCompat(id) { if (!compatQueue.includes(id)) compatQueue.push(id); void pumpCompat(); }
async function pumpCompat() {
  if (compatBusy) return;
  compatBusy = true;
  try {
    while (compatQueue.length) {
      const id = compatQueue.shift();
      const job = getJob(id);
      if (!job || !job.file || !exists(job.file)) continue;
      const dest = path.join(path.dirname(job.file), 'compat.mp4');
      save(job, { compat: 'pending' });
      const r = await runProc('ffmpeg', ['-hide_banner', '-nostdin', '-y', '-i', job.file, '-map', '0:v:0', '-map', '0:a:0?', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p',
        '-vf', "scale='min(1920,iw)':-2", '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', dest], { timeout: 4 * 3600e3 });
      const j2 = getJob(id);
      if (!j2) { rmrf(dest); continue; }
      if (r.code === 0 && exists(dest)) save(j2, { compat: 'ready', compat_file: dest });
      else { rmrf(dest); save(j2, { compat: 'failed' }); }
    }
  } finally { compatBusy = false; }
}

// ───────────────────────── управление задачами ─────────────────────────
export function abortJob(id, how) {
  const ctl = running.get(id);
  if (!ctl) return false;
  if (process.env.DEBUG_ABORT) console.log(`[job ${id}] abort=${how}`, new Error().stack.split('\n').slice(2, 5).join(' <- '));
  ctl.aborted = how;
  const c = ctl.child;
  if (c) { if (c._custom) c.kill(); else killTree(c); }
  return true;
}
export function cancelJob(job) {
  if (running.has(job.id)) { abortJob(job.id, 'cancel'); return; }
  if (['queued', 'paused', 'downloading', 'processing'].includes(job.status)) { rmrf(tmpDirOf(job)); save(job, { status: 'canceled', speed: null, eta: null }); }
}
export function pauseJob(job) {
  if (running.has(job.id)) { abortJob(job.id, 'pause'); return; }
  if (job.status === 'queued') save(job, { status: 'paused' });
}
export function resumeJob(job) {
  if (job.status === 'paused') { save(job, { status: 'queued' }); setImmediate(tick); }
}
export function retryJob(job) {
  if (!['error', 'canceled', 'paused'].includes(job.status)) return;
  if (job.status !== 'paused') rmrf(tmpDirOf(job));
  const p = get('SELECT COALESCE(MAX(pos),0)+1 AS p FROM jobs').p;
  save(job, { status: 'queued', progress: 0, speed: null, eta: null, err_code: null, err_msg: null, log: null, pos: p });
  setImmediate(tick);
}
export function removeJob(job) {
  if (running.has(job.id)) { abortJob(job.id, 'cancel'); }
  const dirs = new Set();
  if (job.file) dirs.add(path.dirname(job.file));
  for (const d of dirs) rmrf(d);
  rmrf(path.join(TMP_DIR, String(job.id)));
  run('DELETE FROM jobs WHERE id=?', job.id);
  const d = { id: job.id };
  if (job.shared) emitAll('job-removed', d); else emitUser(job.user_id, 'job-removed', d);
}
export function reorder(userId, ids) {
  const rows = all("SELECT id,pos FROM jobs WHERE status='queued' AND user_id=?", userId);
  const mine = new Set(rows.map((r) => r.id));
  const order = ids.filter((i) => mine.has(i));
  const positions = rows.map((r) => r.pos).sort((a, b) => a - b);
  order.forEach((id, i) => run('UPDATE jobs SET pos=? WHERE id=?', positions[i], id));
  for (const id of order) emitJob(getJob(id));
}

export async function enqueueConvert(user, src, { to, abr, height }) {
  checkLimits(user, 1);
  const audio = ['mp3', 'm4a', 'opus', 'flac', 'wav'];
  const video = ['mp4', 'mkv', 'webm'];
  if (![...audio, ...video].includes(to)) fail(400, 'bad_format', 'Неизвестный формат');
  if (video.includes(to) && src.media !== 'video') fail(400, 'bad_format', 'Из аудио нельзя сделать видео');
  const o = { mode: audio.includes(to) ? 'audio' : 'video', to, abr: Number(abr) || 192, height: Number(height) || 0, srcId: src.id, qualityLabel: height ? `${height}p` : undefined };
  const title = src.title;
  const r = run(`INSERT INTO jobs(user_id,shared,kind,url,opts,dedupe,status,title,uploader,album,duration,site,media,pos,created_at,meta)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, user.id, 0, 'convert', `convert:${src.id}`, JSON.stringify(o), null, 'queued', title, src.uploader, src.album, src.duration, 'Конвертация',
    audio.includes(to) ? 'audio' : 'video', get('SELECT COALESCE(MAX(pos),0)+1 AS p FROM jobs').p, now(), '{}');
  const row = getJob(Number(r.lastInsertRowid));
  emitJob(row);
  setImmediate(tick);
  return jobDto(row);
}

/** Создаёт готовую запись для загруженного пользователем файла. */
export async function adoptUpload(user, srcFile, origName) {
  const r = run(`INSERT INTO jobs(user_id,shared,kind,url,opts,status,title,site,media,pos,created_at,meta)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`, user.id, 0, 'upload', `upload:${origName}`.slice(0, 300), JSON.stringify({ mode: 'video' }), 'processing', sanitizeName(origName.replace(/\.[^.]+$/, ''), 'file'), 'Мой файл', 'video', 0, now(), '{}');
  const job = getJob(Number(r.lastInsertRowid));
  emitJob(job);
  const tmp = tmpDirOf(job);
  const ext = extOf(origName) || 'bin';
  const f = path.join(tmp, `media.${ext}`);
  moveFile(srcFile, f);
  try {
    const info = await ffprobe(f);
    if (!info && tools.ffprobe.ok && !IMAGE_EXT.has(ext)) throw Object.assign(new Error('bad'), { jobError: { code: 'unknown', message: 'Этот файл не похож на видео, аудио или картинку.' } });
    const mode = info ? (info.video ? 'video' : 'audio') : 'image';
    save(job, { opts: { mode } });
    job.opts = JSON.stringify({ mode });
    const tags = info?.tags || {};
    await finishFile(job, f, { title: tags.title || job.title, uploader: tags.artist || null, album: tags.album || null, duration: info?.duration, site: 'Мой файл' }, { tmp });
  } catch (e) {
    const je = e.jobError || { code: 'unknown', message: 'Не удалось обработать файл.' };
    failJob(job, je.code, je.message, String(e.stack || e));
  }
  return jobDto(getJob(job.id));
}

// ───────────────────────── старт / очистка ─────────────────────────
export function recover() {
  const rows = all("SELECT * FROM jobs WHERE status IN ('downloading','processing')");
  for (const r of rows) {
    rmrf(path.join(TMP_DIR, String(r.id)));
    run("UPDATE jobs SET status='error', err_code='interrupted', err_msg=?, speed=NULL, eta=NULL, finished_at=? WHERE id=?",
      'Загрузка прервалась: сервер был перезапущен. Нажми «Повторить».', now(), r.id);
  }
  // чистим временные папки, которым не принадлежит ни одна живая задача
  try {
    const keep = new Set(all("SELECT id FROM jobs WHERE status IN ('queued','paused')").map((r) => String(r.id)));
    for (const d of fs.readdirSync(TMP_DIR)) if (!keep.has(d)) rmrf(path.join(TMP_DIR, d));
  } catch { /* ignore */ }
  for (const r of all("SELECT id FROM jobs WHERE compat='pending'")) queueCompat(r.id);
  if (rows.length) console.log(`[восстановление] прерванных загрузок: ${rows.length} — помечены ошибкой с кнопкой «Повторить»`);
  setImmediate(tick);
}

export function autoCleanup() {
  const s = getSettings();
  let removed = 0;
  // файлы режима «сразу на устройство», которые так и не забрали, не копим дольше 3 часов
  for (const r of all("SELECT * FROM jobs WHERE status='done' AND finished_at < ? AND opts LIKE '%\"direct\":true%'", now() - 3 * 3600e3)) { removeJob(r); removed++; }
  if (s.cleanupDays > 0) {
    const cutoff = now() - s.cleanupDays * 864e5;
    for (const r of all("SELECT * FROM jobs WHERE status IN ('done','error','canceled') AND COALESCE(finished_at, created_at) < ? AND shared=0", cutoff)) { removeJob(r); removed++; }
  }
  if (s.maxTotalGB > 0) {
    let total = totalBytes();
    const limit = s.maxTotalGB * 1e9;
    if (total > limit) {
      for (const r of all("SELECT * FROM jobs WHERE status='done' ORDER BY finished_at")) {
        if (total <= limit * 0.9) break;
        total -= r.size; removeJob(r); removed++;
      }
    }
  }
  if (removed) console.log(`[автоочистка] удалено файлов: ${removed}`);
}
export function runningCount() { return running.size; }
export { COOKIES_FILE };
