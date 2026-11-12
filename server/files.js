import fs from 'node:fs';
import zlib from 'node:zlib';
import { contentDisposition, mimeOf, sanitizeName, extOf } from './util.js';

const SEC = {
  'x-content-type-options': 'nosniff',
  'cross-origin-resource-policy': 'same-origin',
};

/** Отдача файла с поддержкой Range (перемотка и докачка). */
export function serveFile(req, res, absPath, { name, download = false, mime, cache = 'private, max-age=0, must-revalidate', onComplete } = {}) {
  let st;
  try { st = fs.statSync(absPath); } catch { res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' }); return res.end('{"error":"not_found","message":"Файл не найден"}'); }
  const size = st.size;
  const type = mime || mimeOf(absPath);
  const headers = {
    ...SEC, 'content-type': type, 'accept-ranges': 'bytes', 'cache-control': cache,
    'last-modified': st.mtime.toUTCString(), etag: `"${size.toString(36)}-${Math.floor(st.mtimeMs).toString(36)}"`,
  };
  if (name) headers['content-disposition'] = contentDisposition(name, !download);
  else if (download) headers['content-disposition'] = 'attachment';
  if (req.headers['if-none-match'] === headers.etag && !req.headers.range) { res.writeHead(304, headers); return res.end(); }

  let start = 0, end = size - 1, status = 200;
  const range = req.headers.range;
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(String(range).trim());
    if (!m || (m[1] === '' && m[2] === '')) { res.writeHead(416, { ...headers, 'content-range': `bytes */${size}` }); return res.end(); }
    if (m[1] === '') { const n = Number(m[2]); start = Math.max(0, size - n); }
    else { start = Number(m[1]); if (m[2] !== '') end = Math.min(Number(m[2]), size - 1); }
    if (start >= size || start > end) { res.writeHead(416, { ...headers, 'content-range': `bytes */${size}` }); return res.end(); }
    status = 206;
    headers['content-range'] = `bytes ${start}-${end}/${size}`;
  }
  headers['content-length'] = end - start + 1;
  res.writeHead(status, headers);
  if (req.method === 'HEAD' || size === 0) return res.end();
  const stream = fs.createReadStream(absPath, { start, end });
  stream.on('error', () => res.destroy());
  if (onComplete && end === size - 1) res.on('finish', () => setTimeout(onComplete, 300));
  res.on('close', () => stream.destroy());
  stream.pipe(res);
}

// ───────── ZIP потоком, без хранения архива на диске (метод «store») ─────────
const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16LE(n & 0xffff); return b; };
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };
function dosTime(d) {
  const t = ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) & 0xffff;
  const dt = (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xffff;
  return [t, dt];
}

export async function streamZip(req, res, files, zipName) {
  // files: [{path, name}]
  const used = new Set();
  const entries = [];
  for (const f of files) {
    let n = sanitizeName(f.name.replace(/\.[^.]+$/, ''), 'file');
    const e = extOf(f.path);
    let full = `${n}.${e}`, i = 2;
    while (used.has(full.toLowerCase())) full = `${n} (${i++}).${e}`;
    used.add(full.toLowerCase());
    entries.push({ path: f.path, name: full });
  }
  res.writeHead(200, {
    ...SEC, 'content-type': 'application/zip', 'content-disposition': contentDisposition(zipName.endsWith('.zip') ? zipName : `${zipName}.zip`),
    'cache-control': 'no-store', 'x-accel-buffering': 'no',
  });
  let offset = 0;
  const central = [];
  let closed = false;
  res.on('close', () => { closed = true; });
  const write = (buf) => new Promise((resolve) => {
    offset += buf.length;
    if (closed) return resolve();
    if (res.write(buf)) resolve(); else res.once('drain', resolve);
  });
  for (const ent of entries) {
    if (closed) return;
    let st;
    try { st = fs.statSync(ent.path); } catch { continue; }
    const nameBuf = Buffer.from(ent.name, 'utf8');
    const [t, d] = dosTime(st.mtime);
    const lhOffset = offset;
    const zip64 = st.size >= 0xffffffff;
    await write(Buffer.concat([u32(0x04034b50), u16(zip64 ? 45 : 20), u16(0x0808), u16(0), u16(t), u16(d), u32(0), u32(zip64 ? 0xffffffff : 0), u32(zip64 ? 0xffffffff : 0), u16(nameBuf.length), u16(zip64 ? 20 : 0), nameBuf,
      ...(zip64 ? [u16(1), u16(16), Buffer.alloc(16)] : [])]));
    let crc = 0, size = 0;
    await new Promise((resolve) => {
      const rs = fs.createReadStream(ent.path);
      res.on('close', () => rs.destroy());
      rs.on('data', (c) => {
        crc = zlib.crc32(c, crc); size += c.length;
        offset += c.length;
        if (!res.write(c)) { rs.pause(); res.once('drain', () => rs.resume()); }
      });
      rs.on('end', resolve); rs.on('error', resolve); rs.on('close', resolve);
    });
    if (closed) return;
    if (zip64) {
      const s8 = Buffer.alloc(8); s8.writeBigUInt64LE(BigInt(size));
      await write(Buffer.concat([u32(0x08074b50), u32(crc), s8, s8]));
    } else await write(Buffer.concat([u32(0x08074b50), u32(crc), u32(size), u32(size)]));
    central.push({ nameBuf, crc, size, t, d, lhOffset, zip64 });
  }
  const cdStart = offset;
  for (const c of central) {
    const big = c.zip64 || c.lhOffset >= 0xffffffff;
    const extra = big ? Buffer.concat([u16(1), u16(24), (() => { const b = Buffer.alloc(24); b.writeBigUInt64LE(BigInt(c.size), 0); b.writeBigUInt64LE(BigInt(c.size), 8); b.writeBigUInt64LE(BigInt(c.lhOffset), 16); return b; })()]) : Buffer.alloc(0);
    await write(Buffer.concat([u32(0x02014b50), u16(big ? 45 : 20), u16(big ? 45 : 20), u16(0x0808), u16(0), u16(c.t), u16(c.d), u32(c.crc), u32(big ? 0xffffffff : c.size), u32(big ? 0xffffffff : c.size),
      u16(c.nameBuf.length), u16(extra.length), u16(0), u16(0), u16(0), u32(0), u32(big ? 0xffffffff : c.lhOffset), c.nameBuf, extra]));
  }
  const cdSize = offset - cdStart;
  await write(Buffer.concat([u32(0x06054b50), u16(0), u16(0), u16(central.length), u16(central.length), u32(cdSize), u32(cdStart), u16(0)]));
  res.end();
}
