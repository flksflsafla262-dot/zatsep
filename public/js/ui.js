import { icon } from './icons.js';

// ── мини-гиперскрипт ──
export function h(tag, props, ...kids) {
  const m = /^([a-z0-9]+)?((?:[.#][\w-]+)*)$/i.exec(tag);
  const el = document.createElement(m && m[1] ? m[1] : 'div');
  if (m && m[2]) for (const part of m[2].match(/[.#][\w-]+/g) || []) { if (part[0] === '.') el.classList.add(part.slice(1)); else el.id = part.slice(1); }
  if (props && (typeof props !== 'object' || props instanceof Node || Array.isArray(props))) { kids.unshift(props); props = null; }
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'class') v.split(' ').filter(Boolean).forEach((c) => el.classList.add(c));
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'value') el.value = v;
    else if (k === 'checked' || k === 'disabled' || k === 'hidden' || k === 'selected') el[k] = !!v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  const add = (k) => {
    if (k == null || k === false) return;
    if (Array.isArray(k)) return k.forEach(add);
    el.append(k instanceof Node ? k : document.createTextNode(String(k)));
  };
  kids.forEach(add);
  return el;
}
export const ic = (name, cls) => { const t = document.createElement('template'); t.innerHTML = icon(name, cls); return t.content.firstChild; };
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// ── форматирование ──
export function fmtBytes(n) {
  if (n == null || !Number.isFinite(n)) return '—';
  const u = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n >= 100 || i === 0 ? 0 : 1).replace('.', ',')} ${u[i]}`;
}
export function fmtTime(s) {
  if (!Number.isFinite(s) || s < 0) return '0:00';
  s = Math.floor(s);
  const hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60), ss = s % 60;
  return hh ? `${hh}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}` : `${mm}:${String(ss).padStart(2, '0')}`;
}
export function fmtSpeed(b) { return b ? `${fmtBytes(b)}/с` : ''; }
export function fmtEta(s) {
  if (s == null || !Number.isFinite(s)) return '';
  s = Math.round(s);
  if (s < 60) return `${s} с`;
  if (s < 3600) return `${Math.floor(s / 60)} мин ${s % 60 ? (s % 60) + ' с' : ''}`.trim();
  return `${Math.floor(s / 3600)} ч ${Math.floor((s % 3600) / 60)} мин`;
}
export function fmtDate(ts) {
  if (!ts) return '';
  const d = new Date(ts), n = new Date();
  const same = d.toDateString() === n.toDateString();
  const y = new Date(n - 864e5).toDateString() === d.toDateString();
  const t = d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  if (same) return `сегодня, ${t}`;
  if (y) return `вчера, ${t}`;
  return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', year: d.getFullYear() === n.getFullYear() ? undefined : 'numeric' });
}
export function fmtRel(ts) {
  if (!ts) return 'давно';
  const s = (Date.now() - ts) / 1000;
  if (s < 60) return 'только что';
  if (s < 3600) return `${Math.floor(s / 60)} мин назад`;
  if (s < 86400) return `${Math.floor(s / 3600)} ч назад`;
  return fmtDate(ts);
}
export const plural = (n, a, b, c) => { const m = Math.abs(n) % 100, k = m % 10; return m > 10 && m < 20 ? c : k > 1 && k < 5 ? b : k === 1 ? a : c; };
export const initials = (s) => (s || '?').trim().slice(0, 1).toUpperCase();

// ── движущаяся пилюля ──
const pillObservers = new WeakMap();
export function pillPlace(container, { animate = true } = {}) {
  const ind = container.querySelector(':scope > .pill-ind');
  const act = container.querySelector('.pi.active');
  if (!ind) return;
  if (!act || !act.offsetWidth) { ind.style.opacity = '0'; return; }
  if (!animate) container.classList.add('no-anim');
  ind.style.opacity = '1';
  ind.style.width = act.offsetWidth + 'px';
  ind.style.height = act.offsetHeight + 'px';
  ind.style.transform = `translate(${act.offsetLeft}px, ${act.offsetTop}px)`;
  if (!animate) requestAnimationFrame(() => requestAnimationFrame(() => container.classList.remove('no-anim')));
}
export function pillInit(container) {
  if (!container.querySelector(':scope > .pill-ind')) container.prepend(h('i.pill-ind'));
  if (!pillObservers.has(container)) {
    const ro = new ResizeObserver(() => pillPlace(container, { animate: false }));
    ro.observe(container);
    pillObservers.set(container, ro);
  }
  pillPlace(container, { animate: false });
  requestAnimationFrame(() => pillPlace(container, { animate: false }));
  if (document.fonts?.ready) document.fonts.ready.then(() => pillPlace(container, { animate: false }));
}
/** Переключатель-сегмент с пилюлей. items: [{v, label, icon?, small?}] */
export function segmented(items, value, onChange, cls = '') {
  const box = h('div', { class: `seg pills ${cls}`, role: 'tablist' });
  const btns = new Map();
  for (const it of items) {
    const b = h('button', { class: 'pi', type: 'button', role: 'tab', 'data-v': it.v, 'aria-selected': 'false' }, it.icon ? ic(it.icon) : null, it.label, it.small ? h('small', it.small) : null);
    b.addEventListener('click', () => { if (box.value === it.v) return; set(it.v); onChange?.(it.v); });
    btns.set(it.v, b); box.append(b);
  }
  function set(v, silent) {
    box.value = v;
    for (const [k, b] of btns) { b.classList.toggle('active', k === v); b.setAttribute('aria-selected', k === v ? 'true' : 'false'); }
    pillPlace(box, { animate: !silent });
  }
  box.set = set;
  box.setItems = (arr) => { for (const [k, b] of btns) { const it = arr.find((x) => x.v === k); if (it && it.small !== undefined) { const s = b.querySelector('small'); if (s) s.textContent = it.small; } } };
  box.prepend(h('i.pill-ind'));
  new ResizeObserver(() => pillPlace(box, { animate: false })).observe(box);
  set(value, true);
  requestAnimationFrame(() => pillPlace(box, { animate: false }));
  return box;
}

// ── тосты ──
export function toast(text, { action, onAction, ms = 3800, icon: ico = 'check' } = {}) {
  const host = document.getElementById('toasts');
  const t = h('div.toast', { role: 'status' }, ico ? ic(ico) : null, h('span.grow', text), action ? h('button', { type: 'button', onclick: () => { onAction?.(); close(); } }, action) : null);
  host.append(t);
  while (host.children.length > 3) host.firstChild.remove();
  let timer = setTimeout(close, ms);
  function close() { clearTimeout(timer); t.classList.add('out'); setTimeout(() => t.remove(), 260); }
  t.addEventListener('mouseenter', () => clearTimeout(timer));
  t.addEventListener('mouseleave', () => { timer = setTimeout(close, 1800); });
  return close;
}

// ── листы ──
const openSheets = [];
export function sheet({ title, body, foot, narrow = false, onClose, dismissible = true }) {
  const host = document.getElementById('overlays');
  const scrim = h('div.scrim');
  const sh = h('div', { class: `sheet${narrow ? ' narrow' : ''}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': title || 'Окно' });
  const head = h('div.sheet-head', h('h3', title || ''), dismissible ? h('button.ib', { type: 'button', 'aria-label': 'Закрыть', onclick: () => api.close() }, ic('close')) : null);
  const bodyEl = h('div.sheet-body', body);
  sh.append(h('div.grab'), head, bodyEl);
  let footEl = null;
  if (foot) { footEl = h('div.sheet-foot', foot); sh.append(footEl); }
  scrim.append(sh);
  host.append(scrim);
  requestAnimationFrame(() => requestAnimationFrame(() => scrim.classList.add('in')));
  let closed = false;
  const prevFocus = document.activeElement;
  const api = {
    el: sh, body: bodyEl, scrim,
    setFoot(f) { if (!footEl) { footEl = h('div.sheet-foot'); sh.append(footEl); } footEl.replaceChildren(...[].concat(f).filter(Boolean)); },
    close(result) {
      if (closed) return; closed = true;
      scrim.classList.remove('in');
      document.removeEventListener('keydown', onKey, true);
      const i = openSheets.indexOf(api); if (i >= 0) openSheets.splice(i, 1);
      setTimeout(() => scrim.remove(), 380);
      try { prevFocus?.focus?.({ preventScroll: true }); } catch { /* ignore */ }
      onClose?.(result);
    },
  };
  function onKey(e) {
    if (openSheets[openSheets.length - 1] !== api) return;
    if (e.key === 'Escape' && dismissible) { e.stopPropagation(); api.close(); }
  }
  document.addEventListener('keydown', onKey, true);
  if (dismissible) scrim.addEventListener('pointerdown', (e) => { if (e.target === scrim) api.close(); });
  // свайп вниз на телефоне
  let sy = null, dy = 0;
  const grab = sh.querySelector('.grab');
  grab.addEventListener('touchstart', (e) => { sy = e.touches[0].clientY; sh.style.transition = 'none'; }, { passive: true });
  grab.addEventListener('touchmove', (e) => { if (sy == null) return; dy = Math.max(0, e.touches[0].clientY - sy); sh.style.transform = `translateY(${dy}px)`; }, { passive: true });
  grab.addEventListener('touchend', () => { sh.style.transition = ''; sh.style.transform = ''; if (dy > 100 && dismissible) api.close(); sy = null; dy = 0; });
  openSheets.push(api);
  setTimeout(() => { const f = sh.querySelector('input:not([type=hidden]),textarea,button.primary'); f?.focus?.({ preventScroll: true }); }, 350);
  return api;
}
export function confirmSheet({ title, text, ok = 'Подтвердить', cancel = 'Отмена', danger = false }) {
  return new Promise((resolve) => {
    let done = false;
    const s = sheet({
      title, narrow: true, body: h('p.muted', text),
      foot: [
        h('button.btn.ghost', { type: 'button', onclick: () => s.close(false) }, cancel),
        h('button', { class: `btn ${danger ? 'danger' : 'primary'}`, type: 'button', onclick: () => { done = true; s.close(true); } }, ok),
      ],
      onClose: (r) => resolve(done ? true : !!r),
    });
  });
}

// ── контекстное меню ──
let openMenu = null;
export function menu(anchor, items) {
  closeMenu();
  const m = h('div.menu', { role: 'menu' });
  for (const it of items) {
    if (it === '-') { m.append(h('hr')); continue; }
    if (!it) continue;
    m.append(h('button', { type: 'button', role: 'menuitem', onclick: (e) => { e.stopPropagation(); closeMenu(); it.onClick?.(); } }, it.icon ? ic(it.icon) : null, it.label));
  }
  const host = anchor.closest('.vp') || document.getElementById('overlays');
  host.append(m);
  const r = anchor.getBoundingClientRect();
  const mw = m.offsetWidth, mh = m.offsetHeight;
  let x = r.right - mw, y = r.bottom + 6;
  if (x < 8) x = Math.min(r.left, innerWidth - mw - 8);
  if (y + mh > innerHeight - 8) y = Math.max(8, r.top - mh - 6);
  m.style.left = Math.max(8, x) + 'px'; m.style.top = y + 'px';
  m.style.setProperty('--oy', y < r.top ? '100%' : '0');
  openMenu = m;
  setTimeout(() => { document.addEventListener('pointerdown', outside, true); document.addEventListener('keydown', esc, true); }, 0);
  function outside(e) { if (!m.contains(e.target)) closeMenu(); }
  function esc(e) { if (e.key === 'Escape') { e.stopPropagation(); closeMenu(); } }
  m._cleanup = () => { document.removeEventListener('pointerdown', outside, true); document.removeEventListener('keydown', esc, true); };
  m.querySelector('button')?.focus({ preventScroll: true });
  return m;
}
export function closeMenu() {
  if (!openMenu) return;
  const m = openMenu; openMenu = null;
  m._cleanup?.();
  m.classList.add('out');
  setTimeout(() => m.remove(), 150);
}

// ── прочее ──
export function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text).then(() => true, () => fallback());
  return Promise.resolve(fallback());
  function fallback() {
    const ta = h('textarea', { style: { position: 'fixed', opacity: 0, left: '-999px' } });
    ta.value = text; document.body.append(ta); ta.select();
    let ok = false; try { ok = document.execCommand('copy'); } catch { /* ignore */ }
    ta.remove(); return ok;
  }
}
export function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }
export function skeletonJobs(n = 3) {
  return Array.from({ length: n }, () => h('div.job.skeleton', h('div.thumb.skel'), h('div.job-main', h('div.skel', { style: { height: '16px', width: '80%' } }), h('div.skel', { style: { height: '12px', width: '50%', marginTop: '6px' } })), h('div.ring.skel', { style: { borderRadius: '50%' } })));
}
export function emptyState(iconName, title, text, action) {
  return h('div.empty', ic(iconName), h('b', title), text ? h('p', text) : null, action || null);
}
export function setBusy(btn, busy) { btn.classList.toggle('busy', !!busy); btn.disabled = !!busy; }
export function onVisible(fn) { document.addEventListener('visibilitychange', () => { if (!document.hidden) fn(); }); }
export function sheetField(label, input, hint) { return h('div.field', h('label', label), input, hint ? h('div.hint', hint) : null); }
export function askText({ title, label, value = '', ok = 'Готово', placeholder = '' }) {
  return new Promise((resolve) => {
    let result = null;
    const input = h('input.input', { value, placeholder, maxlength: 80 });
    const submit = () => { result = input.value.trim(); s.close(); };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
    const s = sheet({ title, narrow: true, body: sheetField(label, input), foot: [h('button.btn.ghost', { type: 'button', onclick: () => s.close() }, 'Отмена'), h('button.btn.primary', { type: 'button', onclick: submit }, ok)], onClose: () => resolve(result || null) });
  });
}
export function sw(checked, onChange) {
  const i = h('input', { type: 'checkbox', checked: !!checked });
  i.addEventListener('change', () => onChange?.(i.checked));
  const w = h('label.switch', i, h('i'));
  w.input = i;
  return w;
}
