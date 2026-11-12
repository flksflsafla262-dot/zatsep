import { now } from './util.js';

const clients = new Map(); // userId -> Set<res>

export function addClient(userId, res) {
  if (!clients.has(userId)) clients.set(userId, new Set());
  clients.get(userId).add(res);
  broadcastPresence();
  res.on('close', () => {
    const s = clients.get(userId);
    if (s) { s.delete(res); if (!s.size) clients.delete(userId); }
    broadcastPresence();
  });
}

const write = (res, event, data) => { try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch { /* ignore */ } };

export function emitUser(userId, event, data) {
  const s = clients.get(userId);
  if (s) for (const r of s) write(r, event, data);
}
export function emitAll(event, data) {
  for (const s of clients.values()) for (const r of s) write(r, event, data);
}
export const isOnline = (userId) => clients.has(userId);
export const onlineIds = () => [...clients.keys()];

let presenceTimer = null;
function broadcastPresence() {
  clearTimeout(presenceTimer);
  presenceTimer = setTimeout(() => emitAll('presence', { online: onlineIds() }), 300);
}

setInterval(() => { for (const s of clients.values()) for (const r of s) { try { r.write(`: ping ${now()}\n\n`); } catch { /* ignore */ } } }, 20000).unref();
