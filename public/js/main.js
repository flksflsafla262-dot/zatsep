import { h, ic, pillInit, pillPlace, toast, sheet, $, plural, fmtBytes } from './ui.js';
import { state, loadMe, loadJobs, loadPlaylists, connectEvents, disconnectEvents, get, isActive, extractUrls } from './api.js';
import { showLogin, showInvite } from './auth.js';
import { mountHome, startFlow } from './home.js';
import { mountLibrary } from './library.js';
import { mountMusic } from './music.js';
import { mountProfile, mountFriends, mountSettings, applyTheme, currentTheme, avatarEl } from './account.js';
import { uploadFiles } from './upload.js';
import { autoDownload, download } from './jobs.js';
import { current as curTrack } from './audio.js';

const NAV = [
  { path: '/', label: 'Главная', icon: 'home' },
  { path: '/downloads', label: 'Загрузки', icon: 'download', badge: true },
  { path: '/music', label: 'Музыка', icon: 'music' },
  { path: '/profile', label: 'Профиль', icon: 'user', bottomOnly: false },
];
const OWNER_NAV = [{ path: '/friends', label: 'Друзья', icon: 'users' }, { path: '/settings', label: 'Настройки', icon: 'settings' }];

let cleanup = null, started = false, curPath = null;
const sideNav = $('#sideNav'), bottomNav = $('#bottomNav');

function routeOf() {
  const hash = location.hash.replace(/^#/, '') || '/';
  return hash.split('?')[0];
}

// ── навигация ──
function buildNav() {
  const items = [...NAV.filter((n) => n.path !== '/profile'), ...(state.isOwner() ? OWNER_NAV : []), NAV.find((n) => n.path === '/profile')];
  sideNav.replaceChildren(...items.map((n) => navBtn(n, 'side')));
  bottomNav.replaceChildren(...NAV.map((n) => navBtn(n, 'bottom')));
  pillInit(sideNav); pillInit(bottomNav);
  paintNav();
}
function navBtn(n, kind) {
  const a = h('a', { class: 'pi', href: `#${n.path}`, 'data-path': n.path, 'aria-label': n.label }, ic(n.icon), kind === 'side' ? h('span', n.label) : h('span', n.label), n.badge ? h('span.badge', { hidden: true }) : null);
  return a;
}
function paintNav() {
  for (const nav of [sideNav, bottomNav]) {
    for (const a of nav.querySelectorAll('.pi')) {
      const on = a.dataset.path === curPath;
      a.classList.toggle('active', on);
      if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    }
    pillPlace(nav);
  }
}
function paintBadge() {
  const n = state.jobList().filter((j) => j.userId === state.me.id && isActive(j)).length;
  for (const b of document.querySelectorAll('.pi .badge')) { b.hidden = !n; b.textContent = n; }
}
function paintUser() {
  const u = $('#sideUser');
  u.replaceChildren(avatarEl({ ...state.me, avatarV: state.me.avatar ? Date.now() % 1e7 : 0 }), h('span', h('b', state.me.username), h('small', state.me.role === 'owner' ? 'владелец' : 'друг')));
  u.onclick = () => { location.hash = '#/profile'; };
  $('#brandMark').replaceChildren(ic('logo'));
}
async function paintMeter() {
  try {
    const s = await get('/api/stats');
    const m = $('#sideMeter');
    const lim = s.limits?.quotaGB ? s.limits.quotaGB * 1e9 : 0;
    const pct = lim ? Math.min(100, (s.used / lim) * 100) : Math.min(100, (s.used / (s.used + s.free)) * 100);
    m.hidden = false;
    m.replaceChildren(h('div', lim ? `Занято ${fmtBytes(s.used)} из ${fmtBytes(lim)}` : `Занято ${fmtBytes(s.used)}`), h('div.bar', h('i', { style: { width: Math.max(2, pct) + '%' } })), h('div', `Свободно на сервере ${fmtBytes(s.free)}`));
  } catch { /* не критично */ }
}

// ── роутер ──
const PAGES = {
  '/': (el) => mountHome(el),
  '/downloads': (el) => mountLibrary(el),
  '/music': (el) => mountMusic(el),
  '/profile': (el) => mountProfile(el, { rerenderShell: () => { paintUser(); } }),
  '/friends': (el) => (state.isOwner() ? mountFriends(el) : redirect('/')),
  '/settings': (el) => (state.isOwner() ? mountSettings(el) : redirect('/')),
};
function redirect(p) { location.hash = '#' + p; return () => {}; }

let navToken = 0;
function render() {
  const path = routeOf();
  if (path.startsWith('/invite/')) { return; }
  const page = PAGES[path] ? path : '/';
  const token = ++navToken;
  const mount = () => {
    if (token !== navToken) return;
    cleanup?.(); cleanup = null;
    curPath = page;
    paintNav();
    const old = $('#view');
    const view = h('div.view#view');
    old.replaceWith(view);
    try { cleanup = PAGES[page](view) || null; } catch (e) { console.error(e); view.append(h('div.empty', ic('warning'), h('b', 'Ошибка страницы'), h('p', String(e.message)))); }
    window.scrollTo({ top: 0 });
    document.title = (page === '/' ? '' : NAV.concat(OWNER_NAV).find((n) => n.path === page)?.label + ' — ') + 'Зацеп';
    if (!curTrack()) document.title = document.title.replace(/^▶ /, '');
  };
  const old = $('#view');
  if (started && old.childElementCount && !matchMedia('(prefers-reduced-motion: reduce)').matches) { old.classList.add('leaving'); setTimeout(mount, 130); } else mount();
  started = true;
}

// ── глобальная вставка и перетаскивание ──
function anySheetOpen() { return !!document.querySelector('.scrim, .vp, .np'); }
document.addEventListener('paste', (e) => {
  if (!state.me || anySheetOpen()) return;
  const t = e.target;
  if (t && (t.closest?.('input, textarea, [contenteditable]'))) return;
  const files = [...(e.clipboardData?.files || [])];
  if (files.length) { e.preventDefault(); uploadFiles(files); return; }
  const text = e.clipboardData?.getData('text') || '';
  if (extractUrls(text).length) { e.preventDefault(); startFlow(text); }
});
const hint = $('#dropHint');
let dragDepth = 0;
const dragKind = (e) => { const t = [...(e.dataTransfer?.types || [])]; return t.includes('Files') ? 'file' : (t.includes('text/uri-list') || t.includes('text/plain')) ? 'text' : null; };
document.addEventListener('dragenter', (e) => { if (!state.me || !dragKind(e)) return; dragDepth++; hint.hidden = false; $('#dropIcon').replaceChildren(ic(dragKind(e) === 'file' ? 'upload' : 'link')); });
document.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) hint.hidden = true; });
document.addEventListener('dragover', (e) => { if (dragKind(e)) e.preventDefault(); });
document.addEventListener('drop', (e) => {
  dragDepth = 0; hint.hidden = true;
  if (!state.me) return;
  const k = dragKind(e);
  if (!k) return;
  e.preventDefault();
  if (k === 'file') uploadFiles(e.dataTransfer.files);
  else { const text = e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain'); startFlow(text); }
});

// ── уведомления о готовности ──
function watchJobs() {
  state.on('job', ({ job, prev }) => {
    paintBadge();
    if (autoDownload.has(job.id) && job.status === 'done') {
      autoDownload.delete(job.id);
      toast(`Скачивается на устройство: ${job.title.slice(0, 60)}`, { icon: 'download' });
      download(job);
      paintMeter();
      return;
    }
    if (!prev || job.userId !== state.me.id) return;
    if (isActive(prev) && job.status === 'done') {
      toast(`Готово: ${job.title}`, { icon: 'check', action: 'Открыть', onAction: () => { location.hash = '#/downloads'; }, ms: 6000 });
      paintMeter();
      if (document.hidden && 'Notification' in window && Notification.permission === 'granted') {
        try { const n = new Notification('Загрузка готова', { body: job.title, icon: '/icon.svg', tag: `job-${job.id}` }); n.onclick = () => { window.focus(); location.hash = '#/downloads'; n.close(); }; } catch { /* мобильные Chrome требуют SW */ }
      }
    } else if (prev.status !== 'error' && job.status === 'error') toast(`Не удалось: ${job.title.slice(0, 50)} — ${job.errMsg || ''}`, { icon: 'warning', ms: 7000, action: 'Подробнее', onAction: () => { location.hash = '#/downloads'; } });
  });
  state.on('jobs', paintBadge); state.on('job-removed', paintBadge);
}

// ── старт ──
async function startApp() {
  $('#app').hidden = false;
  buildNav(); paintUser(); paintMeter();
  connectEvents();
  loadPlaylists();
  loadJobs().catch(() => {});
  if (!watchJobs.done) { watchJobs.done = true; watchJobs(); }
  render();
  window.addEventListener('hashchange', onHash);
  // «Поделиться» из других приложений
  const q = new URLSearchParams(location.search);
  if (q.get('share')) { const t = q.get('share'); history.replaceState(null, '', '/#/'); setTimeout(() => startFlow(t), 500); }
  if (state.me.mustChange) setTimeout(suggestPassword, 1200);
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) navigator.serviceWorker.register('/sw.js').catch(() => {});
  if (!state.tools.ytdlp || !state.tools.ffmpeg) setTimeout(() => toast(state.isOwner() ? 'Не установлены yt-dlp/ffmpeg — выполни «npm run tools»' : 'Владелец ещё не установил yt-dlp/ffmpeg', { icon: 'warning', ms: 7000 }), 1000);
}
function suggestPassword() {
  const s = sheet({ title: 'Смени пароль', narrow: true, body: h('p.muted', 'Сейчас у тебя пароль по умолчанию. Придумай свой — это займёт полминуты.'), foot: [h('button.btn.ghost', { type: 'button', onclick: () => s.close() }, 'Позже'), h('a.btn.primary', { href: '#/profile', onclick: () => s.close() }, ic('lock'), 'Сменить пароль')] });
}
function onHash() {
  if (routeOf().startsWith('/invite/')) return;
  render();
}
function onUnauthorized() {
  if (!state.me) return;
  state.me = null; disconnectEvents();
  $('#app').hidden = true;
  window.removeEventListener('hashchange', onHash);
  showLogin(afterLogin, { reason: 'Сессия закончилась — войди снова.' });
}
state.on('unauthorized', onUnauthorized);
async function afterLogin() { await loadMe().catch(() => {}); startApp(); }

(async function boot() {
  const finish = () => { const b = $('#boot'); b.classList.add('gone'); setTimeout(() => b.remove(), 500); };
  const inv = /^#\/invite\/([\w-]+)/.exec(location.hash);
  try {
    await loadMe();
    if (inv) { history.replaceState(null, '', '#/'); }
    finish(); startApp();
  } catch {
    finish();
    if (inv) showInvite(inv[1], afterLogin); else showLogin(afterLogin);
  }
  window.addEventListener('hashchange', () => {
    const m = /^#\/invite\/([\w-]+)/.exec(location.hash);
    if (m && !state.me) showInvite(m[1], afterLogin);
  });
})();
void plural; void currentTheme; void applyTheme;
