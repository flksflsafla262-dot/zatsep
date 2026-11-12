// Сквозная проверка скачивания на живых ссылках: npm test  (сервер должен быть запущен)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = process.env.BASE || 'http://localhost:3000';
const USER = process.env.TEST_USER || 'Пользователь';
const PASS = process.env.TEST_PASS || '12345678';
const ONLY = process.argv.slice(2);
let cookie = '';

async function api(method, url, body) {
  const r = await fetch(BASE + url, { method, headers: { cookie, origin: BASE, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' });
  const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
  const t = await r.text(); let d = null; try { d = JSON.parse(t); } catch { /* not json */ }
  return { status: r.status, data: d, headers: r.headers };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fmt = (n) => (n > 1e6 ? (n / 1e6).toFixed(1) + ' МБ' : n > 1e3 ? (n / 1e3).toFixed(0) + ' КБ' : n + ' Б');

const CASES = [
  { id: 'yt', name: 'YouTube: обычное видео', url: 'https://www.youtube.com/watch?v=jNQXAC9IVRw' },
  { id: 'yt-short-link', name: 'YouTube: youtu.be с ?t=', url: 'https://youtu.be/jNQXAC9IVRw?t=5' },
  { id: 'yt-list', name: 'YouTube: видео + &list= (только одно)', url: 'https://www.youtube.com/watch?v=jNQXAC9IVRw&list=PLFgquLnL59alCl_2TQvOiD5Vgm1hCaGSI', expectSingle: true },
  { id: 'yt-shorts', name: 'YouTube Shorts', url: 'https://www.youtube.com/shorts/FY-6Y-CpuBg' },
  { id: 'yt-1080p60', name: 'YouTube 1080p60', url: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ', height: 1080, clip: { from: '0:10', to: '0:30' } },
  { id: 'yt-4k', name: 'YouTube 4K (фрагмент 15 с)', url: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ', height: 2160, clip: { from: '0:10', to: '0:25' } },
  { id: 'yt-mp3', name: 'YouTube → MP3 (обложка + теги)', url: 'https://www.youtube.com/watch?v=jNQXAC9IVRw', mode: 'audio', afmt: 'mp3', tags: { title: 'Me at the zoo', artist: 'jawed', album: 'Тест', year: '2005' } },
  { id: 'yt-m4a', name: 'YouTube → M4A (обложка + теги)', url: 'https://www.youtube.com/watch?v=jNQXAC9IVRw', mode: 'audio', afmt: 'm4a' },
  { id: 'sc-track', name: 'SoundCloud: трек', url: 'https://soundcloud.com/forss/flickermood', mode: 'audio' },
  { id: 'sc-set', name: 'SoundCloud: сет целиком', url: 'https://soundcloud.com/the-concept-band/sets/the-royal-concept-ep', mode: 'audio', playlist: true },
  { id: 'tt', name: 'TikTok: видео', url: 'https://www.tiktok.com/@tiktok/video/7704834703446117662' },
  { id: 'ig', name: 'Instagram Reels', url: 'https://www.instagram.com/reel/C-vKh8Rs1fI/' },
  { id: 'x', name: 'X/Twitter: пост с видео', url: 'https://x.com/NASA/status/2041101106319667627' },
  { id: 'rutube', name: 'Rutube', url: 'https://rutube.ru/video/d4f6c71ef692390960e4a3953fdc5be2/' },
  { id: 'vk', name: 'VK Видео', url: 'https://vk.com/video-22822305_456239104' },
  { id: 'bandcamp', name: 'Bandcamp', url: 'https://youtube-dl.bandcamp.com/track/youtube-dl-test-song', mode: 'audio' },
  { id: 'direct-mp4', name: 'Прямая ссылка .mp4', url: 'https://www.w3schools.com/html/mov_bbb.mp4' },
  { id: 'direct-mp3', name: 'Прямая ссылка .mp3', url: 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3', mode: 'audio' },
  { id: 'hls', name: 'Прямая ссылка .m3u8 (HLS)', url: 'https://devstreaming-cdn.apple.com/videos/streaming/examples/bipbop_4x3/bipbop_4x3_variant.m3u8', clip: null },
  { id: 'embed', name: 'Страница со встроенным YouTube-плеером (iframe)', url: 'http://localhost:8099/embed.html' },
  { id: 'html-video', name: 'Страница с тегом <video>', url: 'http://localhost:8099/video.html' },
  { id: 'drm', name: 'DRM (Spotify)', url: 'https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT', expectError: 'drm' },
  { id: 'gone', name: 'Несуществующее видео', url: 'https://www.youtube.com/watch?v=zzzzzzzzzzz', expectError: 'any' },
];

async function waitJobs(ids, timeoutMs) {
  const t0 = Date.now();
  for (;;) {
    const { data } = await api('GET', '/api/jobs');
    const js = ids.map((i) => data.jobs.find((j) => j.id === i));
    if (js.every((j) => j && ['done', 'error', 'canceled'].includes(j.status))) return js;
    if (Date.now() - t0 > timeoutMs) return js;
    await sleep(1500);
  }
}

async function runCase(c) {
  const out = { name: c.name, url: c.url, ok: false, note: '' };
  const pr = await api('POST', '/api/probe', { url: c.url, playlist: !!c.playlist, single: true });
  if (pr.status !== 200) {
    out.note = `${pr.data?.error}: ${pr.data?.message}`;
    if (c.expectError && (c.expectError === 'any' || pr.data?.error === c.expectError)) { out.ok = true; out.note = 'понятная ошибка → ' + pr.data.message; }
    return out;
  }
  if (c.expectError) { out.note = 'ожидалась ошибка, но разбор прошёл'; return out; }
  const info = pr.data.info;
  if (c.expectSingle && info.isPlaylist) { out.note = 'скачивается плейлист, а не одно видео'; return out; }
  let items, opts;
  const mode = c.mode || 'video';
  if (info.isPlaylist) {
    items = info.entries.slice(0, 6).map((e) => ({ url: e.url, kind: 'ytdlp', title: e.title, thumbnail: e.thumbnail, site: info.site }));
    opts = { mode, afmt: c.afmt || 'best', container: 'mp4' };
    out.note = `плейлист: ${info.entries.length} эл. `;
  } else {
    const q = (info.qualities || []).find((x) => x.height === c.height) || (c.height ? [...(info.qualities || [])].reverse().find((x) => x.height >= c.height) : null) || (info.qualities || [])[0];
    const kind = info.kind === 'ytdlp' ? 'ytdlp' : info.kind;
    items = [{ url: info.embedUrl || info.url, kind, title: info.title, uploader: info.uploader, thumbnail: info.thumbnail, duration: info.duration, site: info.site, referer: info.referer || undefined, streamType: info.streamType || undefined, expSize: q?.size }];
    opts = { mode: info.hasVideo || mode === 'audio' ? mode : 'audio', height: mode === 'video' ? q?.height : undefined, qualityLabel: q?.label, container: 'mp4', afmt: c.afmt || 'best', abr: 320, clip: c.clip || undefined, tags: c.tags, tagsEdited: !!c.tags, embedThumb: true };
    out.note = `${info.site}; ${(info.qualities || []).slice(0, 4).map((x) => x.label).join('/') || '—'}; `;
  }
  const en = await api('POST', '/api/jobs', { items, opts, force: true });
  if (en.status !== 200) { out.note += `enqueue: ${en.data?.message}`; return out; }
  const ids = en.data.jobs.map((j) => j.id);
  const res = await waitJobs(ids, 15 * 60e3);
  const bad = res.filter((j) => !j || j.status !== 'done');
  if (bad.length) { out.note += bad.map((j) => `${j?.status}: ${j?.errMsg}`).join(' | '); out.errCode = bad[0]?.errCode; return out; }
  // проверка выдачи: Range и размер
  const j = res[0];
  const r = await fetch(`${BASE}/api/files/${j.id}?inline=1`, { headers: { cookie, range: 'bytes=0-99' } });
  const buf = Buffer.from(await r.arrayBuffer());
  if (r.status !== 206 || buf.length !== 100) { out.note += `Range не работает (${r.status})`; return out; }
  const cd = (await fetch(`${BASE}/api/files/${j.id}`, { headers: { cookie } })).headers.get('content-disposition');
  out.ok = true;
  out.note += `файлов: ${res.length}; ${j.title.slice(0, 40)}; ${j.ext} ${j.width ? j.width + 'x' + j.height + ' ' : ''}${j.vcodec || ''}${j.acodec ? '/' + j.acodec : ''}; ${fmt(j.size)}; compat=${j.compat}; ${cd ? 'имя ок' : 'нет имени'}`;
  return out;
}

(async () => {
  const lg = await api('POST', '/api/login', { username: USER, password: PASS });
  if (lg.status !== 200) { console.error('Не удалось войти:', lg.data); process.exit(1); }
  const rows = [];
  for (const c of CASES) {
    if (ONLY.length && !ONLY.includes(c.id)) continue;
    process.stdout.write(`▶ ${c.name} … `);
    const t0 = Date.now();
    let r;
    try { r = await runCase(c); } catch (e) { r = { name: c.name, url: c.url, ok: false, note: 'исключение: ' + e.message }; }
    r.sec = Math.round((Date.now() - t0) / 1000);
    console.log(`${r.ok ? '✓' : '✗'} (${r.sec} с) ${r.note}`);
    rows.push(r);
  }
  const md = ['| Ссылка | Результат | Детали |', '|---|---|---|', ...rows.map((r) => `| ${r.name}<br><sub>${r.url}</sub> | ${r.ok ? '✅' : '❌'} | ${r.note.replace(/\|/g, '/')} |`)].join('\n');
  fs.writeFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'last-report.md'), md);
  console.log('\n' + md);
})();


