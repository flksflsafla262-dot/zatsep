import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { BIN_DIR } from './config.js';
import { getSettings, setSetting } from './db.js';
import { tail, now } from './util.js';

// добавляем ./bin в PATH — туда `npm run tools` кладёт yt-dlp и ffmpeg
if (fs.existsSync(BIN_DIR)) process.env.PATH = BIN_DIR + path.delimiter + process.env.PATH;

export const tools = {
  ytdlp: { ok: false, version: null, jsRuntimes: false },
  ffmpeg: { ok: false, version: null },
  ffprobe: { ok: false, version: null },
  gifski: { ok: false, version: null },
  gallerydl: { ok: false, version: null },
  node: process.version,
};

/** Запуск процесса с таймаутом; не бросает исключений. */
export function run(cmd, args = [], { timeout = 0, input, env, onStdout, onStderr, cwd } = {}) {
  return new Promise((resolve) => {
    let stdout = '', stderr = '', done = false, timedOut = false;
    let child;
    try {
      child = spawn(cmd, args, { windowsHide: true, env: env || process.env, cwd, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    } catch (e) { return resolve({ code: -1, stdout, stderr: String(e.message), error: e, timedOut }); }
    const finish = (code, error) => { if (done) return; done = true; clearTimeout(t); resolve({ code, stdout, stderr, error, timedOut, child }); };
    const t = timeout ? setTimeout(() => { timedOut = true; killTree(child); }, timeout) : null;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => { stdout += d; if (stdout.length > 30e6) stdout = stdout.slice(-20e6); onStdout?.(d); });
    child.stderr.on('data', (d) => { stderr += d; if (stderr.length > 2e6) stderr = stderr.slice(-1e6); onStderr?.(d); });
    child.on('error', (e) => finish(-1, e));
    child.on('close', (code) => finish(code));
    child.stdin.on('error', () => {});
    if (input != null) child.stdin.end(input); else child.stdin.end();
  });
}

export function spawnTracked(cmd, args, opts = {}) {
  return spawn(cmd, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32', ...opts });
}

export function killTree(child) {
  if (!child || child.killed || child.exitCode != null) return;
  try {
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
    else process.kill(-child.pid, 'SIGKILL');
  } catch { try { child.kill('SIGKILL'); } catch { /* ignore */ } }
}

async function probeTool(key, cmd, args, parse) {
  const r = await run(cmd, args, { timeout: 15000 });
  const ok = r.code === 0 && !r.error;
  tools[key].ok = ok;
  tools[key].version = ok ? parse((r.stdout || r.stderr).trim()) : null;
  return ok;
}

export async function checkTools() {
  await Promise.all([
    probeTool('ytdlp', 'yt-dlp', ['--version'], (s) => s.split(/\r?\n/)[0]),
    probeTool('ffmpeg', 'ffmpeg', ['-version'], (s) => (s.match(/ffmpeg version (\S+)/) || [])[1] || 'ok'),
    probeTool('ffprobe', 'ffprobe', ['-version'], (s) => (s.match(/ffprobe version (\S+)/) || [])[1] || 'ok'),
    probeTool('gifski', 'gifski', ['--version'], (s) => s.split(/\r?\n/)[0]),
    probeTool('gallerydl', 'gallery-dl', ['--version'], (s) => s.split(/\r?\n/)[0]),
  ]);
  if (tools.ytdlp.ok) {
    const h = await run('yt-dlp', ['--help'], { timeout: 15000 });
    tools.ytdlp.jsRuntimes = /--js-runtimes/.test(h.stdout);
  }
  return tools;
}

export function installHelp() {
  const lines = [];
  const miss = [];
  if (!tools.ytdlp.ok) miss.push('yt-dlp');
  if (!tools.ffmpeg.ok || !tools.ffprobe.ok) miss.push('ffmpeg/ffprobe');
  if (!miss.length) return '';
  lines.push('', `⚠  Не найдено: ${miss.join(', ')}. Без них скачивание не заработает.`, '');
  lines.push('   Самый простой путь (Windows/macOS/Linux): npm run tools', '   — он скачает yt-dlp (и ffmpeg для Windows) в папку ./bin.', '');
  lines.push('   Или поставь вручную:');
  lines.push('   Windows : winget install yt-dlp.yt-dlp Gyan.FFmpeg      (или scoop install yt-dlp ffmpeg)');
  lines.push('   macOS   : brew install yt-dlp ffmpeg');
  lines.push('   Linux   : sudo apt install ffmpeg && pipx install yt-dlp   (или скачай yt-dlp с github.com/yt-dlp/yt-dlp/releases)');
  lines.push('   Необязательно: gifski и gallery-dl (pip install gallery-dl) — для картинок и слайдшоу.', '');
  return lines.join('\n');
}

// ── обновление yt-dlp ──
let updating = null;
export function updateYtdlp(reason = 'manual') {
  if (updating) return updating;
  updating = (async () => {
    if (!tools.ytdlp.ok) return { ok: false, message: 'yt-dlp не установлен', version: null };
    const before = tools.ytdlp.version;
    let r = await run('yt-dlp', ['-U'], { timeout: 180000 });
    let text = (r.stdout + '\n' + r.stderr).trim();
    let how = 'yt-dlp -U';
    if (/pip|pypi|package manager|installed (with|via|using)/i.test(text) || r.code !== 0) {
      for (const [c, a] of [['python', ['-m', 'pip', 'install', '-U', '--user', 'yt-dlp']], ['python3', ['-m', 'pip', 'install', '-U', '--user', 'yt-dlp']], ['pip', ['install', '-U', 'yt-dlp']]]) {
        const p = await run(c, a, { timeout: 240000 });
        if (p.code === 0) { text = (p.stdout + p.stderr).trim(); how = 'pip install -U yt-dlp'; break; }
      }
    }
    await checkTools();
    setSetting('lastUpdateCheck', now());
    const after = tools.ytdlp.version;
    return { ok: !!after, version: after, before, changed: before !== after, how, reason, message: tail(text, 600) };
  })().finally(() => { updating = null; });
  return updating;
}

export function scheduleAutoUpdate() {
  const tick = async () => {
    const s = getSettings();
    if (!s.autoUpdate || !tools.ytdlp.ok) return;
    if (now() - (s.lastUpdateCheck || 0) > 24 * 3600e3) {
      const r = await updateYtdlp('auto');
      console.log(`[yt-dlp] автообновление: ${r.ok ? (r.changed ? `${r.before} → ${r.version}` : `актуальная версия ${r.version}`) : 'не удалось — ' + r.message}`);
    }
  };
  setTimeout(tick, 3000).unref();
  setInterval(tick, 3600e3).unref();
}
