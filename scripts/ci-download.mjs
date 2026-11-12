// Запускается в GitHub Actions по новому issue «dl:<id> <ссылка>»: скачивает yt-dlp'ом и кладёт файл в Release dl-<id>.
import { spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import dns from 'node:dns/promises';
import net from 'node:net';

const { ISSUE_TITLE = '', ISSUE_BODY = '', ISSUE_NUMBER, REPO, COOKIES = '' } = process.env;
const gh = (...args) => execFileSync('gh', args, { stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8' });
const tryGh = (...args) => { try { return gh(...args); } catch { return ''; } };
const OUT = path.resolve('out');
fs.mkdirSync(OUT, { recursive: true });

const m = /^dl:([a-z0-9]{6,16})\s+(https:\/\/\S+)\s*$/i.exec(ISSUE_TITLE.trim());
if (!m) {
  tryGh('issue', 'comment', ISSUE_NUMBER, '--body', 'Формат заголовка: `dl:<id> https://ссылка`. Запрос пропущен.');
  tryGh('issue', 'close', ISSUE_NUMBER);
  process.exit(0);
}
const id = m[1].toLowerCase();
const url = m[2];
const tag = `dl-${id}`;

function finish(ok, message, file) {
  if (ok) gh('release', 'create', tag, file, '--title', id, '--notes', `OK ${message}`);
  else tryGh('release', 'create', tag, '--title', id, '--notes', `ERROR: ${message}`);
  tryGh('issue', 'comment', ISSUE_NUMBER, '--body', ok ? `Готово: https://github.com/${REPO}/releases/tag/${tag}` : `Не получилось: ${message}`);
  tryGh('issue', 'close', ISSUE_NUMBER);
  console.log(ok ? 'OK' : 'FAIL', message);
  process.exit(0);
}

// опции из тела issue
const opt = {};
for (const line of ISSUE_BODY.split(/\r?\n/)) { const k = /^(mode|quality|afmt)=([\w]+)\s*$/.exec(line.trim()); if (k) opt[k[1]] = k[2]; }
const mode = opt.mode === 'audio' ? 'audio' : 'video';
const quality = ['2160', '1440', '1080', '720', '480', '360'].includes(opt.quality) ? Number(opt.quality) : 0;
const afmt = ['mp3', 'm4a'].includes(opt.afmt) ? opt.afmt : 'mp3';

// защита: не ходим во внутренние адреса раннера (метаданные облака и т.п.)
function isPrivate(ip) {
  if (net.isIPv4(ip)) { const [a, b] = ip.split('.').map(Number); return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224; }
  const l = ip.toLowerCase(); const mp = l.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  return mp ? isPrivate(mp[1]) : l === '::1' || l === '::' || /^f[cdef]/.test(l) || /^fe[89ab]/.test(l);
}
try {
  const host = new URL(url).hostname.replace(/^\[|\]$/g, '');
  const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true });
  if (!addrs.length || addrs.some((a) => isPrivate(a.address))) finish(false, 'Ссылки во внутреннюю сеть запрещены');
} catch { finish(false, 'Не удалось найти такой сайт — проверь ссылку'); }

if (COOKIES.trim()) fs.writeFileSync('cookies.txt', COOKIES.replace(/\r\n/g, '\n'), { mode: 0o600 });

const CLIENTS = [undefined, 'tv', 'web_safari', 'mweb', 'ios'];
function run(client) {
  const a = ['--ignore-config', '--no-colors', '--no-warnings', '--no-playlist', '--js-runtimes', 'node', '--socket-timeout', '30', '--retries', '5', '--fragment-retries', '10',
    '--concurrent-fragments', '4', '--max-filesize', '1900M', '--write-info-json', '-o', path.join(OUT, 'media.%(ext)s'), '--write-thumbnail', '--convert-thumbnails', 'jpg'];
  if (fs.existsSync('cookies.txt')) a.push('--cookies', 'cookies.txt');
  if (client) a.push('--extractor-args', `youtube:player_client=${client}`);
  if (mode === 'audio') a.push('-f', 'ba/b', '-x', '--audio-format', afmt, '--audio-quality', '0', '--embed-metadata', '--embed-thumbnail');
  else {
    const cap = quality ? `[height<=${quality}]` : '';
    a.push('-f', quality ? `bv*${cap}+ba/b${cap}/bv*+ba/b` : 'bv*+ba/b', '-S', 'res,fps,vcodec:h264,acodec:m4a', '--merge-output-format', 'mp4', '--embed-metadata');
  }
  a.push(url);
  return spawnSync('yt-dlp', a, { encoding: 'utf8', maxBuffer: 50e6 });
}

let r, err = '';
for (const c of CLIENTS) {
  fs.rmSync(OUT, { recursive: true, force: true }); fs.mkdirSync(OUT, { recursive: true });
  r = run(c);
  err = (r.stderr || '') + (r.stdout || '').split('\n').filter((l) => /error/i.test(l)).join('\n');
  if (r.status === 0) break;
  console.log(`yt-dlp завершился с кодом ${r.status}${c ? ` (client ${c})` : ''}:\n${(r.stderr || '').slice(-1500)}`);
  if (!(/youtu/i.test(url) && /403|sign in|not a bot|requested format|forbidden|login/i.test(r.stderr || ''))) break;
}

if (r.status !== 0) {
  const t = r.stderr || '';
  const msg = /drm/i.test(t) ? 'Видео защищено от копирования (DRM) — скачать нельзя.'
    : /not a bot|sign in to confirm/i.test(t) ? 'YouTube не пускает серверы GitHub («подтвердите, что вы не бот»). Для таких ссылок нужен cookies.txt (секрет YT_COOKIES в репозитории) или запуск на своём компьютере.'
      : /login|private|age/i.test(t) ? 'Нужен вход в аккаунт или видео закрыто.'
        : /unsupported url|no suitable extractor/i.test(t) ? 'Сайт не поддерживается или на странице нет видео.'
          : /429|too many/i.test(t) ? 'Сайт ограничил частоту запросов — попробуй позже.'
            : /larger than|max-filesize/i.test(t) ? 'Файл больше 1,9 ГБ — GitHub столько не принимает.'
              : /unavailable|removed|not exist|404/i.test(t) ? 'Видео удалено или недоступно.'
                : `Не удалось скачать. ${err.split('\n').pop().replace(/^ERROR:\s*(\[[^\]]+\]\s*)?/, '').slice(0, 200)}`;
  finish(false, msg);
}

const info = (() => { try { return JSON.parse(fs.readFileSync(path.join(OUT, 'media.info.json'), 'utf8')); } catch { return {}; } })();
const media = fs.readdirSync(OUT).filter((f) => /^media\.[a-z0-9]+$/i.test(f) && !/\.(json|jpg|jpeg|png|webp)$/i.test(f)).map((f) => ({ f, s: fs.statSync(path.join(OUT, f)).size })).sort((a, b) => b.s - a.s);
if (!media.length) finish(false, 'Скачивание завершилось, но файла нет.');
const ext = path.extname(media[0].f);
const TR = { а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'yo', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya' };
const slug = String(info.title || id).toLowerCase().replace(/[а-яё]/g, (c) => TR[c] ?? '').normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || id;
const finalName = `${slug}${ext}`;
const finalPath = path.join(OUT, finalName);
fs.renameSync(path.join(OUT, media[0].f), finalPath);
finish(true, `${(info.title || slug).replace(/\n/g, ' ').slice(0, 120)} | ${finalName} | ${media[0].s}`, finalPath);
