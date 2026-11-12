// Клиент API, общее состояние и живые события (SSE)
export class ApiError extends Error {
  constructor(status, data) { super(data?.message || 'Ошибка запроса'); this.status = status; this.code = data?.error; this.data = data || {}; }
}

export async function api(method, url, body, opts = {}) {
  const init = { method, credentials: 'same-origin', headers: {}, signal: opts.signal };
  if (body !== undefined && !(body instanceof Blob) && typeof body !== 'string') { init.body = JSON.stringify(body); init.headers['content-type'] = 'application/json'; }
  else if (body !== undefined) { init.body = body; if (opts.type) init.headers['content-type'] = opts.type; }
  let res;
  try { res = await fetch(url, init); } catch (e) { if (e.name === 'AbortError') throw e; throw new ApiError(0, { error: 'network', message: 'Нет связи с сервером. Проверь, что он запущен.' }); }
  let data = null;
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('json')) { try { data = await res.json(); } catch { /* пусто */ } }
  if (!res.ok) {
    if (res.status === 401 && !opts.quiet401) state.emit('unauthorized');
    throw new ApiError(res.status, data);
  }
  return data;
}
export const get = (u, o) => api('GET', u, undefined, o);
export const post = (u, b, o) => api('POST', u, b ?? {}, o);
export const put = (u, b, o) => api('PUT', u, b, o);
export const patch = (u, b) => api('PATCH', u, b ?? {});
export const del = (u) => api('DELETE', u);

// ── состояние ──
const listeners = new Map();
export const state = {
  me: null, defaults: {}, tools: {}, limits: {}, secure: false,
  jobs: new Map(), jobsLoaded: false, online: new Set(), playlists: [],
  on(ev, fn) { if (!listeners.has(ev)) listeners.set(ev, new Set()); listeners.get(ev).add(fn); return () => listeners.get(ev)?.delete(fn); },
  emit(ev, data) { for (const fn of listeners.get(ev) || []) { try { fn(data); } catch (e) { console.error(e); } } },
  jobList() { return [...state.jobs.values()].sort((a, b) => b.createdAt - a.createdAt || b.id - a.id); },
  isOwner() { return state.me?.role === 'owner'; },
};

export async function loadMe() {
  const d = await get('/api/me', { quiet401: true });
  state.me = d.user; state.defaults = d.defaults; state.tools = d.tools; state.limits = d.limits; state.secure = d.secure; state.open = !!d.open;
  return d;
}
export async function loadJobs() {
  const d = await get('/api/jobs');
  state.jobs = new Map(d.jobs.map((j) => [j.id, j]));
  state.jobsLoaded = true;
  state.emit('jobs');
}
export async function loadPlaylists() {
  try { state.playlists = (await get('/api/playlists')).playlists; } catch { state.playlists = []; }
  state.emit('playlists');
}

const ACTIVE = new Set(['queued', 'downloading', 'processing', 'paused']);
export const isActive = (j) => ACTIVE.has(j.status);

let es = null, esRetry = 0;
export function connectEvents() {
  if (es) es.close();
  es = new EventSource('/api/events');
  es.addEventListener('hello', (e) => { esRetry = 0; state.online = new Set(JSON.parse(e.data).online); state.emit('presence'); loadJobs().catch(() => {}); });
  es.addEventListener('presence', (e) => { state.online = new Set(JSON.parse(e.data).online); state.emit('presence'); });
  es.addEventListener('job', (e) => {
    const j = JSON.parse(e.data);
    const prev = state.jobs.get(j.id);
    state.jobs.set(j.id, j);
    state.emit('job', { job: j, prev });
  });
  es.addEventListener('job-removed', (e) => { const { id } = JSON.parse(e.data); state.jobs.delete(id); state.emit('job-removed', { id }); });
  es.addEventListener('job-reload', () => loadJobs().catch(() => {}));
  es.onerror = () => {
    if (es.readyState === 2) { es.close(); setTimeout(connectEvents, Math.min(15000, 1000 * 2 ** esRetry++)); }
  };
}
export function disconnectEvents() { es?.close(); es = null; }

// URL-помощники
export const fileUrl = (id, inline) => `/api/files/${id}${inline ? '?inline=1' : ''}`;
export const downloadUrl = (id) => `/api/files/${id}`;
export function extractUrls(text) {
  const out = [];
  const re = /https?:\/\/[^\s<>"'`«»]+/gi;
  let m;
  while ((m = re.exec(text || ''))) { const u = m[0].replace(/[)\]}>.,;:!?»”’'"]+$/g, ''); if (u && !out.includes(u)) out.push(u); }
  if (!out.length) {
    const re2 = /(?:^|[\s(<«"'])((?:www\.|m\.)?(?:youtu\.be|youtube\.com|soundcloud\.com|vk\.com|vkvideo\.ru|rutube\.ru|tiktok\.com|vm\.tiktok\.com|instagram\.com|twitter\.com|x\.com|bandcamp\.com|twitch\.tv|reddit\.com|vimeo\.com|dzen\.ru|ok\.ru|facebook\.com|pinterest\.com|threads\.net|kick\.com|dailymotion\.com|mixcloud\.com)\/[^\s<>"'`]+)/gi;
    while ((m = re2.exec(text || ''))) { const u = 'https://' + m[1].replace(/[)\]}>.,;:!?»”’'"]+$/g, ''); if (!out.includes(u)) out.push(u); }
  }
  return out;
}
