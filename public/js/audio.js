// Аудио-движок: очередь, перемешивание, повтор, мини-плеер, «Сейчас играет», Media Session.
import { h, ic, fmtTime, toast } from './ui.js';
import { state } from './api.js';

export const audio = new Audio();
audio.preload = 'metadata';
audio.crossOrigin = 'use-credentials';

const S = { orig: [], queue: [], index: -1, shuffle: false, repeat: 'off' };
let npEl = null, dragging = false;
const subs = new Set();
export const onAudio = (fn) => { subs.add(fn); return () => subs.delete(fn); };
const notify = () => subs.forEach((f) => { try { f(); } catch (e) { console.error(e); } });

export const current = () => S.queue[S.index] || null;
export const isPlaying = () => !audio.paused && !audio.ended;
export const queueState = () => ({ queue: S.queue, index: S.index, shuffle: S.shuffle, repeat: S.repeat });

const srcOf = (j) => `/api/files/${j.id}?inline=1`;
const absThumb = (j) => (j.thumb ? new URL(j.thumb, location.href).href : null);

function load(i, autoplay = true) {
  const j = S.queue[i];
  if (!j) return;
  S.index = i;
  audio.src = srcOf(j);
  audio.currentTime = 0;
  if (autoplay) audio.play().catch((e) => { if (e.name !== 'AbortError') toast('Нажми ▶, чтобы начать — браузер не дал запустить звук сам', { icon: 'info' }); });
  updateSession();
  mount();
  notify();
}

function shuffled(list, firstId) {
  const a = list.filter((j) => j.id !== firstId);
  for (let i = a.length - 1; i > 0; i--) { const k = Math.floor(Math.random() * (i + 1)); [a[i], a[k]] = [a[k], a[i]]; }
  const first = list.find((j) => j.id === firstId);
  return first ? [first, ...a] : a;
}

export function playQueue(list, startId) {
  if (!list.length) return;
  S.orig = [...list];
  const id = startId ?? list[0].id;
  S.queue = S.shuffle ? shuffled(list, id) : [...list];
  load(Math.max(0, S.queue.findIndex((j) => j.id === id)));
}
export function playShuffled(list) { S.shuffle = true; playQueue(list, list[Math.floor(Math.random() * list.length)].id); }
export function enqueueNext(job) {
  if (S.index < 0) return playQueue([job]);
  S.queue.splice(S.index + 1, 0, job); S.orig.push(job); notify(); toast('Сыграет следующим');
}
export function enqueueLast(job) {
  if (S.index < 0) return playQueue([job]);
  S.queue.push(job); S.orig.push(job); notify(); toast('Добавлено в очередь');
}
export function toggle() { if (S.index < 0) return; if (audio.paused) audio.play().catch(() => {}); else audio.pause(); }
export function next(auto = false) {
  if (!S.queue.length) return;
  if (S.repeat === 'one' && auto) { audio.currentTime = 0; audio.play().catch(() => {}); return; }
  let i = S.index + 1;
  if (i >= S.queue.length) { if (S.repeat === 'all' || !auto) i = 0; else { audio.pause(); audio.currentTime = 0; notify(); return; } }
  load(i);
}
export function prev() {
  if (!S.queue.length) return;
  if (audio.currentTime > 3) { audio.currentTime = 0; return; }
  load(S.index > 0 ? S.index - 1 : S.queue.length - 1);
}
export function seek(t) { if (Number.isFinite(audio.duration)) audio.currentTime = Math.max(0, Math.min(audio.duration, t)); }
export function toggleShuffle() {
  S.shuffle = !S.shuffle;
  const cur = current();
  if (cur) { S.queue = S.shuffle ? shuffled(S.orig, cur.id) : [...S.orig]; S.index = Math.max(0, S.queue.findIndex((j) => j.id === cur.id)); }
  notify();
}
export function cycleRepeat() { S.repeat = S.repeat === 'off' ? 'all' : S.repeat === 'all' ? 'one' : 'off'; notify(); }
export function jumpTo(i) { load(i); }
export function stopAll() { audio.pause(); audio.removeAttribute('src'); audio.load(); S.queue = []; S.orig = []; S.index = -1; unmount(); notify(); }

// синхронизация, когда трек удалён/изменён
state.on('job-removed', ({ id }) => {
  const cur = current();
  S.orig = S.orig.filter((j) => j.id !== id);
  if (cur?.id === id) { stopAll(); return; }
  const i = S.queue.findIndex((j) => j.id === id);
  if (i >= 0) { S.queue.splice(i, 1); if (i < S.index) S.index--; notify(); }
});
state.on('job', ({ job }) => {
  for (const arr of [S.queue, S.orig]) { const i = arr.findIndex((j) => j.id === job.id); if (i >= 0) arr[i] = { ...arr[i], title: job.title, uploader: job.uploader, thumb: job.thumb }; }
});

audio.addEventListener('ended', () => next(true));
audio.addEventListener('play', () => { notify(); document.title = `▶ ${current()?.title || ''} — Зацеп`; if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing'; });
audio.addEventListener('pause', () => { notify(); document.title = 'Зацеп — качалка видео и музыки'; if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused'; });
audio.addEventListener('error', () => {
  if (!audio.getAttribute('src')) return;
  toast('Этот файл не играет в браузере. Скачай его или сконвертируй в MP3 (меню ⋯ → Конвертировать).', { icon: 'warning', ms: 6000 });
});
let lastPos = 0;
audio.addEventListener('timeupdate', () => {
  paintProgress();
  const t = Date.now();
  if (t - lastPos > 1000 && 'mediaSession' in navigator && Number.isFinite(audio.duration)) {
    lastPos = t;
    try { navigator.mediaSession.setPositionState({ duration: audio.duration, position: Math.min(audio.currentTime, audio.duration), playbackRate: audio.playbackRate }); } catch { /* ignore */ }
  }
});
audio.addEventListener('loadedmetadata', paintProgress);
audio.addEventListener('durationchange', paintProgress);

function updateSession() {
  const j = current();
  if (!j || !('mediaSession' in navigator)) return;
  const art = absThumb(j);
  navigator.mediaSession.metadata = new MediaMetadata({ title: j.title || '', artist: j.uploader || '', album: j.album || 'Зацеп', artwork: art ? [{ src: art, sizes: '640x640', type: 'image/jpeg' }] : [] });
  const set = (a, f) => { try { navigator.mediaSession.setActionHandler(a, f); } catch { /* не поддерживается */ } };
  set('play', () => audio.play()); set('pause', () => audio.pause());
  set('previoustrack', prev); set('nexttrack', () => next(false));
  set('seekto', (d) => seek(d.seekTime)); set('seekbackward', (d) => seek(audio.currentTime - (d.seekOffset || 10))); set('seekforward', (d) => seek(audio.currentTime + (d.seekOffset || 10)));
}

// ── мини-плеер ──
function coverNode(j, cls) {
  const box = h(`div.${cls}`, ic('music'));
  if (j?.thumb) { const img = h('img', { src: j.thumb, alt: '', loading: 'lazy' }); img.onerror = () => img.remove(); box.append(img); }
  return box;
}
function mount() {
  const mini = document.getElementById('mini');
  document.getElementById('app').classList.add('has-mini');
  document.body.classList.add('has-mini');
  mini.hidden = false;
  renderMini();
}
function unmount() {
  const mini = document.getElementById('mini');
  mini.hidden = true; mini.replaceChildren();
  document.getElementById('app').classList.remove('has-mini');
  document.body.classList.remove('has-mini');
  closeNowPlaying();
}
function renderMini() {
  const mini = document.getElementById('mini');
  const j = current();
  if (!j) return;
  if (mini.dataset.id !== String(j.id)) {
    mini.dataset.id = String(j.id);
    mini.replaceChildren(
      coverNode(j, 'cover'),
      h('div.t', h('b.ellip', j.title), h('small.ellip', j.uploader || 'Неизвестный исполнитель')),
      h('div.ctl',
        h('button.ib', { type: 'button', 'aria-label': 'Предыдущий', onclick: (e) => { e.stopPropagation(); prev(); } }, ic('prev')),
        h('button.ib.mpp', { type: 'button', 'aria-label': 'Играть или пауза', onclick: (e) => { e.stopPropagation(); toggle(); } }, ic('play')),
        h('button.ib', { type: 'button', 'aria-label': 'Следующий', onclick: (e) => { e.stopPropagation(); next(false); } }, ic('next'))),
      h('div.prog'),
    );
    mini.onclick = () => openNowPlaying();
  }
  const b = mini.querySelector('.mpp');
  b.replaceChildren(ic(isPlaying() ? 'pause' : 'play'));
  paintProgress();
}
function paintProgress() {
  const pct = audio.duration ? (audio.currentTime / audio.duration) * 100 : 0;
  const pr = document.querySelector('#mini .prog');
  if (pr) pr.style.width = pct + '%';
  if (npEl && !dragging) {
    const r = npEl.querySelector('.rng');
    r.max = audio.duration || 0; r.value = audio.currentTime || 0; r.style.setProperty('--p', pct + '%');
    npEl.querySelector('.t-cur').textContent = fmtTime(audio.currentTime);
    npEl.querySelector('.t-dur').textContent = fmtTime(audio.duration);
  }
}

// ── «Сейчас играет» ──
export function openNowPlaying() {
  if (npEl || !current()) return;
  const j = current();
  npEl = h('div.np', { role: 'dialog', 'aria-label': 'Сейчас играет' },
    h('div.bg'),
    h('div.inner',
      h('div.top',
        h('button.ib', { type: 'button', 'aria-label': 'Свернуть', onclick: closeNowPlaying }, ic('down')),
        h('span.muted.small', { style: { fontWeight: 600 } }, 'Сейчас играет'),
        h('button.ib', { type: 'button', 'aria-label': 'Очередь', onclick: () => npEl.querySelector('.queue').classList.toggle('in') }, ic('queue'))),
      h('div.artwork', h('div.art', ic('music'))),
      h('div',
        h('div.row', { style: { justifyContent: 'space-between', flexWrap: 'nowrap' } }, h('div.grow', h('h2.clamp2.np-title'), h('p.muted.np-artist.ellip'))),
        h('div.scrub',
          h('input.rng', { type: 'range', min: 0, max: 0, step: 'any', value: 0, 'aria-label': 'Перемотка' }),
          h('div.times', h('span.t-cur', '0:00'), h('span.t-dur', '0:00'))),
        h('div.ctrls',
          h('button.ib.sh', { type: 'button', 'aria-label': 'Перемешать', onclick: toggleShuffle }, ic('shuffle')),
          h('button.ib', { type: 'button', 'aria-label': 'Предыдущий', onclick: prev }, ic('prev')),
          h('button.ib.big.pp', { type: 'button', 'aria-label': 'Играть или пауза', onclick: toggle }, ic('play')),
          h('button.ib', { type: 'button', 'aria-label': 'Следующий', onclick: () => next(false) }, ic('next')),
          h('button.ib.rp', { type: 'button', 'aria-label': 'Повтор', onclick: cycleRepeat }, ic('repeat'))))),
    h('div.queue', h('div.inner2', h('div.row', { style: { justifyContent: 'space-between', margin: '4px 4px 10px' } }, h('b', 'Очередь'), h('button.ib', { type: 'button', onclick: () => npEl.querySelector('.queue').classList.remove('in') }, ic('close'))), h('div.tracks.q-list'))),
  );
  const rng = npEl.querySelector('.rng');
  rng.addEventListener('input', () => { dragging = true; const p = (rng.value / (rng.max || 1)) * 100; rng.style.setProperty('--p', p + '%'); npEl.querySelector('.t-cur').textContent = fmtTime(+rng.value); });
  rng.addEventListener('change', () => { seek(+rng.value); dragging = false; });
  document.getElementById('overlays').append(npEl);
  requestAnimationFrame(() => requestAnimationFrame(() => npEl?.classList.add('in')));
  document.addEventListener('keydown', npKey);
  renderNP();
  void j;
}
function npKey(e) { if (e.key === 'Escape' && npEl) { if (npEl.querySelector('.queue.in')) npEl.querySelector('.queue').classList.remove('in'); else closeNowPlaying(); } }
export function closeNowPlaying() {
  if (!npEl) return;
  const el = npEl; npEl = null;
  el.classList.remove('in');
  document.removeEventListener('keydown', npKey);
  setTimeout(() => el.remove(), 650);
}
function renderNP() {
  if (!npEl) return;
  const j = current();
  if (!j) return;
  npEl.querySelector('.np-title').textContent = j.title;
  npEl.querySelector('.np-artist').textContent = j.uploader || '';
  const art = npEl.querySelector('.art');
  art.classList.toggle('paused', !isPlaying());
  if (art.dataset.id !== String(j.id)) {
    art.dataset.id = String(j.id);
    art.replaceChildren(ic('music'));
    const bg = npEl.querySelector('.bg');
    if (j.thumb) { const img = h('img', { src: j.thumb, alt: '' }); img.onerror = () => img.remove(); art.append(img); bg.style.backgroundImage = `url("${j.thumb}")`; } else bg.style.backgroundImage = '';
  }
  npEl.querySelector('.pp').replaceChildren(ic(isPlaying() ? 'pause' : 'play'));
  npEl.querySelector('.sh').classList.toggle('act', S.shuffle);
  const rp = npEl.querySelector('.rp');
  rp.classList.toggle('act', S.repeat !== 'off');
  rp.replaceChildren(ic(S.repeat === 'one' ? 'repeat1' : 'repeat'));
  const ql = npEl.querySelector('.q-list');
  ql.replaceChildren(...S.queue.map((q, i) => h('div', { class: `track${i === S.index ? ' cur' : ''}`, onclick: () => jumpTo(i) }, coverNode(q, 'cover'), h('div.t', h('b.ellip', q.title), h('small.muted.ellip', q.uploader || '')), h('span.dur', q.duration ? fmtTime(q.duration) : ''), h('span'))));
}
onAudio(() => { renderMini(); renderNP(); });
