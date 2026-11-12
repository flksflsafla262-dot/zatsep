// Рисует PNG-иконки приложения (180/192/512) без внешних зависимостей: node scripts/make-icons.js
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const segs = [[256, 110, 256, 294], [256, 294, 190, 228], [256, 294, 322, 228]];
const dSeg = (x, y, [ax, ay, bx, by]) => { const dx = bx - ax, dy = by - ay; const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy))); return Math.hypot(x - ax - t * dx, y - ay - t * dy); };
function white(x, y) {
  for (const s of segs) if (dSeg(x, y, s) <= 15) return true;
  const r = Math.hypot(x - 256, y - 318);
  if (y >= 318 && Math.abs(r - 126) <= 15) return true;
  return Math.hypot(x - 130, y - 318) <= 15 || Math.hypot(x - 382, y - 318) <= 15;
}
function inRound(x, y, rad = 120) {
  const cx = Math.min(Math.max(x, rad), 512 - rad), cy = Math.min(Math.max(y, rad), 512 - rad);
  return Math.hypot(x - cx, y - cy) <= rad;
}
function png(size) {
  const SS = 3, raw = Buffer.alloc((size * 4 + 1) * size);
  for (let py = 0; py < size; py++) {
    raw[py * (size * 4 + 1)] = 0;
    for (let px = 0; px < size; px++) {
      let a = 0, w = 0;
      for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
        const x = ((px + (sx + 0.5) / SS) / size) * 512, y = ((py + (sy + 0.5) / SS) / size) * 512;
        if (inRound(x, y)) { a++; if (white(x, y)) w++; }
      }
      const o = py * (size * 4 + 1) + 1 + px * 4, n = SS * SS;
      const v = a ? Math.round((w / a) * 255) : 0;
      raw[o] = v; raw[o + 1] = v; raw[o + 2] = v; raw[o + 3] = Math.round((a / n) * 255);
    }
  }
  const chunk = (t, d) => { const b = Buffer.alloc(12 + d.length); b.writeUInt32BE(d.length, 0); b.write(t, 4); d.copy(b, 8); b.writeUInt32BE(zlib.crc32(b.subarray(4, 8 + d.length)), 8 + d.length); return b; };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}
for (const s of [180, 192, 512]) { fs.writeFileSync(path.join(OUT, `icon-${s}.png`), png(s)); console.log('icon-' + s + '.png'); }
