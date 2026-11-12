import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureDir } from './util.js';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = ensureDir(path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data')));
export const TMP_DIR = ensureDir(path.join(DATA_DIR, 'tmp'));
export const UPLOAD_DIR = ensureDir(path.join(DATA_DIR, 'uploads'));
export const AVATAR_DIR = ensureDir(path.join(DATA_DIR, 'avatars'));
export const CERT_DIR = path.join(DATA_DIR, 'cert');
export const BIN_DIR = path.join(ROOT, 'bin');
export const PUBLIC_DIR = path.join(ROOT, 'public');
export const COOKIES_FILE = path.join(DATA_DIR, 'cookies.txt');

export const PORT = Number(process.env.PORT || 3000);
export const HOST = process.env.HOST || '0.0.0.0';
export const USE_HTTPS = process.argv.includes('--https') || process.env.HTTPS === '1';

export const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export const DEFAULT_SETTINGS = {
  maxConcurrent: 3,
  maxTotalGB: 0,        // 0 = без лимита
  perUserGB: 0,         // лимит места по умолчанию для друзей (0 = без лимита)
  perUserPerDay: 0,     // загрузок в сутки по умолчанию для друзей (0 = без лимита)
  cleanupDays: 0,       // автоудаление старше N дней (0 = выкл)
  nameTemplate: '{title}',
  defaultQuality: 'best',
  defaultContainer: 'mp4',
  defaultAudio: 'best',
  proxy: '',
  cookiesBrowser: '',
  storageDir: '',
  shareHours: 72,
  allowPrivate: false,
  autoUpdate: true,
  lastUpdateCheck: 0,
};
