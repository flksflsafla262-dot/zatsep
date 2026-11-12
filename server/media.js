import fs from 'node:fs';
import path from 'node:path';
import { run } from './tools.js';
import { tools } from './tools.js';
import { ensureDir } from './util.js';

/** ffprobe → краткая сводка о файле. */
export async function ffprobe(file, extraArgs = []) {
  if (!tools.ffprobe.ok) return null;
  const r = await run('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', ...extraArgs, file], { timeout: 60000 });
  if (r.code !== 0) return null;
  try {
    const j = JSON.parse(r.stdout);
    const v = (j.streams || []).find((s) => s.codec_type === 'video' && !(s.disposition && s.disposition.attached_pic));
    const a = (j.streams || []).find((s) => s.codec_type === 'audio');
    const cover = (j.streams || []).find((s) => s.codec_type === 'video' && s.disposition && s.disposition.attached_pic);
    const tags = {};
    for (const [k, val] of Object.entries(j.format?.tags || {})) tags[k.toLowerCase()] = val;
    return {
      duration: Number(j.format?.duration) || Number(v?.duration) || Number(a?.duration) || 0,
      size: Number(j.format?.size) || 0,
      bitrate: Number(j.format?.bit_rate) || 0,
      format: j.format?.format_name,
      video: v ? { codec: v.codec_name, width: v.width, height: v.height, pix_fmt: v.pix_fmt, profile: v.profile, fps: parseRate(v.avg_frame_rate || v.r_frame_rate) } : null,
      audio: a ? { codec: a.codec_name, channels: a.channels, sampleRate: Number(a.sample_rate) || 0 } : null,
      hasCover: !!cover,
      tags,
    };
  } catch { return null; }
}
function parseRate(r) { if (!r) return 0; const [a, b] = String(r).split('/').map(Number); return b ? a / b : a || 0; }

/** Проигрывается ли без перекодирования везде (Chrome / Safari / iOS). */
export function isUniversalVideo(info) {
  if (!info || !info.video) return true;
  const okV = info.video.codec === 'h264' && (!info.video.pix_fmt || info.video.pix_fmt === 'yuv420p');
  const okA = !info.audio || ['aac', 'mp3'].includes(info.audio.codec);
  return okV && okA;
}

/** Кадр из видео или обложка из аудио → thumb.jpg. */
export async function makeThumb(file, dest, info) {
  if (!tools.ffmpeg.ok) return false;
  ensureDir(path.dirname(dest));
  const t = Math.min(Math.max((info?.duration || 4) * 0.1, 0.5), 10);
  const args = info?.video
    ? ['-y', '-v', 'error', '-ss', String(t), '-i', file, '-frames:v', '1', '-vf', 'scale=640:-2', '-q:v', '4', dest]
    : ['-y', '-v', 'error', '-i', file, '-an', '-map', '0:v:0', '-frames:v', '1', '-vf', 'scale=640:-2', '-q:v', '3', dest];
  const r = await run('ffmpeg', args, { timeout: 60000 });
  return r.code === 0 && fs.existsSync(dest);
}

export async function convertThumbToJpg(src, dest) {
  if (!tools.ffmpeg.ok) return false;
  const r = await run('ffmpeg', ['-y', '-v', 'error', '-i', src, '-frames:v', '1', '-vf', 'scale=720:-2', '-q:v', '3', dest], { timeout: 60000 });
  return r.code === 0 && fs.existsSync(dest);
}

/** srt → vtt */
export function srtToVtt(srt) {
  return 'WEBVTT\n\n' + String(srt).replace(/\r/g, '').replace(/^\uFEFF/, '').replace(/(\d\d:\d\d:\d\d),(\d\d\d)/g, '$1.$2');
}
