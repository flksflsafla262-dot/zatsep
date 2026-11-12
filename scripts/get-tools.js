// Скачивает yt-dlp (и ffmpeg для Windows) в папку ./bin — запуск: npm run tools
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(ROOT, 'bin');
fs.mkdirSync(BIN, { recursive: true });
const win = process.platform === 'win32';

async function download(url, dest) {
  console.log(`↓ ${url}`);
  const res = await fetch(url, { redirect: 'follow', headers: { 'user-agent': 'zatsep-setup' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} для ${url}`);
  const total = Number(res.headers.get('content-length')) || 0;
  let got = 0, last = 0;
  const src = Readable.fromWeb(res.body);
  src.on('data', (c) => { got += c.length; const t = Date.now(); if (t - last > 500) { last = t; process.stdout.write(`\r   ${(got / 1e6).toFixed(1)} МБ${total ? ' / ' + (total / 1e6).toFixed(1) + ' МБ' : ''}   `); } });
  await pipeline(src, fs.createWriteStream(dest));
  process.stdout.write('\n');
}

function have(cmd) { return spawnSync(cmd, ['-version'], { windowsHide: true }).status === 0 || spawnSync(cmd, ['--version'], { windowsHide: true }).status === 0; }

async function ytdlp() {
  const map = { win32: 'yt-dlp.exe', linux: os.arch() === 'arm64' ? 'yt-dlp_linux_aarch64' : 'yt-dlp_linux', darwin: 'yt-dlp_macos' };
  const file = map[process.platform];
  if (!file) { console.log('Для этой системы поставь yt-dlp вручную: https://github.com/yt-dlp/yt-dlp#installation'); return; }
  const dest = path.join(BIN, win ? 'yt-dlp.exe' : 'yt-dlp');
  await download(`https://github.com/yt-dlp/yt-dlp/releases/latest/download/${file}`, dest);
  if (!win) fs.chmodSync(dest, 0o755);
  console.log('✓ yt-dlp установлен в ./bin');
}

async function ffmpeg() {
  if (!win) {
    if (have('ffmpeg')) { console.log('✓ ffmpeg уже есть в системе'); return; }
    console.log(process.platform === 'darwin' ? 'Поставь ffmpeg: brew install ffmpeg' : 'Поставь ffmpeg: sudo apt install ffmpeg   (или dnf/pacman install ffmpeg)');
    return;
  }
  const zip = path.join(os.tmpdir(), 'zatsep-ffmpeg.zip');
  const out = path.join(os.tmpdir(), 'zatsep-ffmpeg');
  await download('https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip', zip);
  fs.rmSync(out, { recursive: true, force: true });
  const r = spawnSync('powershell', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${out}' -Force`], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error('Не удалось распаковать архив');
  const root = fs.readdirSync(out).map((d) => path.join(out, d, 'bin')).find((d) => fs.existsSync(path.join(d, 'ffmpeg.exe')));
  if (!root) throw new Error('В архиве нет ffmpeg.exe');
  for (const f of ['ffmpeg.exe', 'ffprobe.exe']) fs.copyFileSync(path.join(root, f), path.join(BIN, f));
  fs.rmSync(zip, { force: true }); fs.rmSync(out, { recursive: true, force: true });
  console.log('✓ ffmpeg и ffprobe установлены в ./bin');
}

try {
  if (!have('yt-dlp') && !fs.existsSync(path.join(BIN, win ? 'yt-dlp.exe' : 'yt-dlp'))) await ytdlp(); else console.log('✓ yt-dlp уже есть');
  if (!have('ffmpeg') && !fs.existsSync(path.join(BIN, win ? 'ffmpeg.exe' : 'ffmpeg'))) await ffmpeg(); else console.log('✓ ffmpeg уже есть');
  console.log('\nГотово. Необязательно: pip install gallery-dl (картинки/слайдшоу) и gifski. Запусти: npm start');
} catch (e) {
  console.error('\nНе получилось:', e.message);
  process.exit(1);
}
