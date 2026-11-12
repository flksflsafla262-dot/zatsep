import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { CERT_DIR } from './config.js';
import { ensureDir } from './util.js';

// Минимальный генератор самоподписанного X.509-сертификата без внешних зависимостей.
const der = (tag, ...bufs) => {
  const body = Buffer.concat(bufs);
  const l = body.length;
  const len = l < 128 ? Buffer.from([l]) : l < 256 ? Buffer.from([0x81, l]) : Buffer.from([0x82, l >> 8, l & 255]);
  return Buffer.concat([Buffer.from([tag]), len, body]);
};
const seq = (...b) => der(0x30, ...b);
const set = (...b) => der(0x31, ...b);
const oid = (s) => {
  const p = s.split('.').map(Number);
  const bytes = [p[0] * 40 + p[1]];
  for (const n of p.slice(2)) {
    const t = [n & 127];
    let v = n >> 7;
    while (v > 0) { t.unshift((v & 127) | 128); v >>= 7; }
    bytes.push(...t);
  }
  return der(0x06, Buffer.from(bytes));
};
const int = (buf) => der(0x02, buf[0] & 0x80 ? Buffer.concat([Buffer.from([0]), buf]) : buf);
const utf8 = (s) => der(0x0c, Buffer.from(s));
const utc = (d) => der(0x17, Buffer.from(d.toISOString().replace(/[-:T]/g, '').slice(2, 14) + 'Z'));
const bitstr = (b) => der(0x03, Buffer.concat([Buffer.from([0]), b]));
const pem = (label, buf) => `-----BEGIN ${label}-----\n${buf.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END ${label}-----\n`;

function makeCert(hosts) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const name = seq(set(seq(oid('2.5.4.3'), utf8('Zatsep local'))));
  const sigAlg = seq(oid('1.2.840.113549.1.1.11'), der(0x05));
  const san = seq(...hosts.map((h) => (net.isIPv4(h) ? der(0x87, Buffer.from(h.split('.').map(Number))) : der(0x82, Buffer.from(h)))));
  const ext = seq(seq(oid('2.5.29.17'), der(0x04, san)), seq(oid('2.5.29.19'), der(0x04, seq(der(0x01, Buffer.from([0]))))));
  const from = new Date(Date.now() - 864e5), to = new Date(Date.now() + 3650 * 864e5);
  const tbs = seq(
    der(0xa0, int(Buffer.from([2]))), int(crypto.randomBytes(8)), sigAlg, name, seq(utc(from), utc(to)), name,
    crypto.createPublicKey(publicKey).export({ type: 'spki', format: 'der' }), der(0xa3, ext),
  );
  const sig = crypto.sign('sha256', tbs, privateKey);
  const cert = seq(tbs, sigAlg, bitstr(sig));
  return { cert: pem('CERTIFICATE', cert), key: privateKey.export({ type: 'pkcs8', format: 'pem' }) };
}

export function loadOrCreateCert(hosts) {
  ensureDir(CERT_DIR);
  const certF = path.join(CERT_DIR, 'cert.pem'), keyF = path.join(CERT_DIR, 'key.pem'), hostsF = path.join(CERT_DIR, 'hosts.json');
  const want = [...new Set(hosts)].sort();
  try {
    const have = JSON.parse(fs.readFileSync(hostsF, 'utf8'));
    if (JSON.stringify(have) === JSON.stringify(want)) return { cert: fs.readFileSync(certF), key: fs.readFileSync(keyF) };
  } catch { /* создаём заново */ }
  const c = makeCert(want);
  fs.writeFileSync(certF, c.cert); fs.writeFileSync(keyF, c.key); fs.writeFileSync(hostsF, JSON.stringify(want));
  return { cert: c.cert, key: c.key };
}
