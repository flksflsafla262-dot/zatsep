// Карточка загрузки и действия над файлами
import { h, ic, fmtBytes, fmtTime, fmtDate, fmtSpeed, fmtEta, menu, toast, sheet, confirmSheet, copyText, segmented, sheetField, setBusy, askText } from './ui.js';
import { state, post, del, get, patch, isActive, ApiError } from './api.js';
import { openVideo } from './player.js';
import { playQueue, enqueueNext, enqueueLast, current as curTrack, isPlaying, toggle as toggleAudio } from './audio.js';

export const MEDIA_ICON = { video: 'film', audio: 'music', image: 'image' };
const C = 2 * Math.PI * 20;

export function qualityText(j) {
  if (j.media === 'video') return j.meta?.quality || (j.height ? `${j.height}p` : '');
  if (j.media === 'audio') return (j.ext || '').toUpperCase();
  return (j.ext || '').toUpperCase();
}
export function errorFriendly(e) { return e instanceof ApiError ? e.message : 'Что-то пошло не так'; }
const mine = (j) => j.userId === state.me?.id;
const canWrite = (j) => mine(j) || (j.shared && state.isOwner());

/** id задач, которые надо сразу отдать на устройство, как только они будут готовы */
export const autoDownload = new Set();
export function download(job) {
  const a = h('a', { href: `/api/files/${job.id}${job.opts?.direct ? '?once=1' : ''}`, download: '', style: { display: 'none' } });
  document.body.append(a); a.click(); a.remove();
}

export function openJob(job, ctx = {}) {
  if (job.status !== 'done') return;
  if (job.media === 'video') openVideo(job);
  else if (job.media === 'audio') {
    const list = (ctx.audioList || state.jobList().filter((j) => j.media === 'audio' && j.status === 'done'));
    if (curTrack()?.id === job.id) toggleAudio(); else playQueue(list.some((j) => j.id === job.id) ? list : [job], job.id);
  } else if (job.media === 'image') lightbox(job);
}
export function lightbox(job) {
  const box = h('div.lightbox', { role: 'dialog', onclick: close }, h('img', { src: `/api/files/${job.id}?inline=1`, alt: job.title }));
  const esc = (e) => { if (e.key === 'Escape') close(); };
  function close() { box.remove(); document.removeEventListener('keydown', esc); }
  document.addEventListener('keydown', esc);
  document.getElementById('overlays').append(box);
}

// ── ссылки для друзей ──
export async function createShare(job, hours) {
  const r = await post(`/api/jobs/${job.id}/share`, { hours });
  return { ...r, url: `${location.origin}${r.path}` };
}
export async function copyShareLink(job) {
  try {
    const r = await createShare(job);
    const ok = await copyText(r.url);
    toast(ok ? `Ссылка скопирована · действует ${Math.round((r.expiresAt - Date.now()) / 3600e3)} ч` : r.url, { icon: 'link', action: 'Отозвать', ms: 6000, onAction: () => del(`/api/shares/${r.token}`).then(() => toast('Ссылка отозвана', { icon: 'check' })).catch(() => {}) });
  } catch (e) { toast(errorFriendly(e), { icon: 'warning' }); }
}
export async function nativeShare(job) {
  try {
    const r = await createShare(job);
    await navigator.share({ title: job.title, text: job.title, url: r.url });
  } catch (e) { if (e.name !== 'AbortError') toast(errorFriendly(e), { icon: 'warning' }); }
}
export function sharesSheet(job) {
  const list = h('div.list');
  const hours = h('input.input', { type: 'number', min: 1, max: 8760, value: state.defaults.shareHours || 72, 'aria-label': 'Часов' });
  const s = sheet({ title: 'Ссылки без регистрации', narrow: true, body: h('div.stack', h('p.muted.small', 'Любой, у кого есть ссылка, сможет скачать этот файл без входа. Ссылку можно отозвать в любой момент.'), list, h('div.row', h('div.grow', sheetField('Действует, часов', hours)), h('button.btn.primary', { type: 'button', onclick: async (e) => { setBusy(e.currentTarget, true); try { const r = await createShare(job, +hours.value); await copyText(r.url); toast('Ссылка скопирована', { icon: 'link' }); await load(); } catch (er) { toast(errorFriendly(er), { icon: 'warning' }); } setBusy(e.currentTarget, false); } }, ic('link'), 'Создать'))) });
  async function load() {
    const { shares } = await get('/api/shares');
    const mineShares = shares.filter((x) => x.jobId === job.id);
    list.replaceChildren(...(mineShares.length ? mineShares.map((x) => h('div.li', h('div.grow', h('b.ellip', `/s/${x.token.slice(0, 8)}…`), h('small.muted', `до ${new Date(x.expiresAt).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}`)),
      h('button.btn.sm', { type: 'button', onclick: async () => { await copyText(`${location.origin}/s/${x.token}`); toast('Скопировано', { icon: 'copy' }); } }, ic('copy'), 'Копировать'),
      h('button.btn.sm.danger', { type: 'button', onclick: async () => { await del(`/api/shares/${x.token}`); toast('Ссылка отозвана'); load(); } }, 'Отозвать'))) : [h('p.muted.small', 'Активных ссылок нет.')]));
  }
  load();
  return s;
}

// ── конвертация ──
export function convertSheet(job) {
  const isVideo = job.media === 'video';
  let kind = isVideo ? 'video' : 'audio', fmt = kind === 'video' ? 'mp4' : 'mp3', abr = 192, height = 0;
  const body = h('div.stack');
  const s = sheet({ title: 'Конвертировать', body, foot: [h('button.btn.ghost', { type: 'button', onclick: () => s.close() }, 'Отмена'), h('button.btn.primary', { type: 'button', onclick: go }, ic('convert'), 'Сконвертировать')] });
  function draw() {
    const fmts = kind === 'video' ? [['mp4', 'MP4'], ['mkv', 'MKV'], ['webm', 'WEBM']] : [['mp3', 'MP3'], ['m4a', 'M4A'], ['opus', 'OPUS'], ['flac', 'FLAC'], ['wav', 'WAV']];
    const kids = [h('div.preview', { style: { gridTemplateColumns: '1fr' } }, h('div', h('b', job.title), h('p.muted.small', `Сейчас: ${qualityText(job) || job.ext}, ${fmtBytes(job.size)}`)))];
    if (isVideo) kids.push(segmented([{ v: 'video', label: 'Видео', icon: 'film' }, { v: 'audio', label: 'Только звук', icon: 'music' }], kind, (v) => { kind = v; fmt = v === 'video' ? 'mp4' : 'mp3'; draw(); }));
    kids.push(sheetField('Формат', segmented(fmts.map(([v, label]) => ({ v, label })), fmt, (v) => { fmt = v; draw(); }, 'wrap')));
    if (kind === 'audio' && ['mp3', 'm4a', 'opus'].includes(fmt)) kids.push(sheetField('Качество, кбит/с', segmented([128, 192, 256, 320].map((v) => ({ v, label: String(v) })), abr, (v) => { abr = v; })));
    if (kind === 'video') kids.push(sheetField('Размер картинки', segmented([[0, 'Как есть'], [1080, '1080p'], [720, '720p'], [480, '480p']].map(([v, label]) => ({ v, label })), height, (v) => { height = v; }, 'wrap'), 'Меньше размер — меньше файл.'));
    body.replaceChildren(...kids);
  }
  draw();
  async function go(e) {
    setBusy(e.currentTarget, true);
    try { await post(`/api/jobs/${job.id}/convert`, { to: fmt, abr, height }); s.close(); toast('Конвертация добавлена в очередь', { icon: 'convert' }); } catch (er) { toast(errorFriendly(er), { icon: 'warning' }); setBusy(e.currentTarget, false); }
  }
}

export function editSheet(job) {
  const t = h('input.input', { value: job.title || '' }), a = h('input.input', { value: job.uploader || '' }), al = h('input.input', { value: job.album || '' });
  const s = sheet({ title: 'Название и исполнитель', narrow: true, body: h('div.stack-sm', sheetField('Название', t), sheetField('Исполнитель / автор', a), job.media === 'audio' ? sheetField('Альбом', al) : null, h('p.muted.small', 'Меняется подпись в библиотеке. Сам файл и его теги остаются как есть.')),
    foot: [h('button.btn.ghost', { type: 'button', onclick: () => s.close() }, 'Отмена'), h('button.btn.primary', { type: 'button', onclick: async () => { try { await patch(`/api/jobs/${job.id}`, { title: t.value, uploader: a.value, album: al.value }); s.close(); toast('Сохранено'); } catch (e) { toast(errorFriendly(e), { icon: 'warning' }); } } }, 'Сохранить')] });
}

export async function detailsSheet(job) {
  const pre = h('pre.log', 'Загружаю…');
  const s = sheet({ title: 'Подробности', body: h('div.stack', h('p', job.errMsg || 'Нет сообщения'), h('div.field', h('label', 'Ссылка'), h('div.small', { style: { wordBreak: 'break-all' } }, job.url || '—')), h('div.field', h('label', 'Последние строки лога yt-dlp'), pre)),
    foot: [h('button.btn', { type: 'button', onclick: () => copyText(pre.textContent).then(() => toast('Лог скопирован', { icon: 'copy' })) }, ic('copy'), 'Копировать лог'), h('button.btn.primary', { type: 'button', onclick: () => s.close() }, 'Закрыть')] });
  try { const d = await get(`/api/jobs/${job.id}/log`); pre.textContent = d.log || '(лог пуст)'; } catch { pre.textContent = '(не удалось загрузить)'; }
}

export async function removeJobs(jobs) {
  const done = jobs.filter((j) => j.status === 'done').length;
  if (done) {
    const ok = await confirmSheet({ title: jobs.length > 1 ? `Удалить ${jobs.length} шт.?` : 'Удалить файл?', text: jobs.length > 1 ? 'Файлы будут удалены с сервера без возможности восстановления.' : `«${jobs[0].title}» будет удалён с сервера без возможности восстановления.`, ok: 'Удалить', danger: true });
    if (!ok) return false;
  }
  try { await post('/api/jobs/bulk', { action: 'delete', ids: jobs.map((j) => j.id) }); toast(jobs.length > 1 ? 'Удалено' : 'Файл удалён', { icon: 'trash' }); return true; } catch (e) { toast(errorFriendly(e), { icon: 'warning' }); return false; }
}

export async function addToPlaylistSheet(job) {
  const body = h('div.list');
  const s = sheet({ title: 'В плейлист', narrow: true, body: h('div.stack-sm', body, h('button.btn.outline', { type: 'button', onclick: async () => { const name = await askText({ title: 'Новый плейлист', label: 'Название', ok: 'Создать' }); if (!name) return; await post('/api/playlists', { name }); await draw(); } }, ic('plus'), 'Новый плейлист')) });
  async function draw() {
    const { loadPlaylists } = await import('./api.js');
    await loadPlaylists();
    body.replaceChildren(...(state.playlists.length ? state.playlists.map((p) => h('button.li', { type: 'button', onclick: async () => { if (!p.items.includes(job.id)) { const { put } = await import('./api.js'); await put(`/api/playlists/${p.id}`, { items: [...p.items, job.id] }); await loadPlaylists(); } toast(`Добавлено в «${p.name}»`, { icon: 'list' }); s.close(); } }, ic('list'), h('div.grow', h('b', p.name), h('small.muted', `${p.items.length} трек.`)))) : [h('p.muted.small', 'Плейлистов пока нет — создай первый.')]));
  }
  draw();
}

// ── меню действий ──
export function jobMenu(anchor, job, ctx = {}) {
  const items = [];
  const ownerOfRow = canWrite(job);
  if (job.status === 'done') {
    items.push({ label: job.media === 'audio' ? 'Играть' : job.media === 'image' ? 'Открыть' : 'Смотреть', icon: 'play', onClick: () => openJob(job, ctx) });
    if (job.media === 'audio') { items.push({ label: 'Играть следующим', icon: 'queue', onClick: () => enqueueNext(job) }, { label: 'В очередь', icon: 'list', onClick: () => enqueueLast(job) }, { label: 'В плейлист…', icon: 'list', onClick: () => addToPlaylistSheet(job) }); }
    items.push('-', { label: 'Скачать на устройство', icon: 'download', onClick: () => download(job) }, { label: 'Копировать ссылку', icon: 'link', onClick: () => copyShareLink(job) });
    if (navigator.share) items.push({ label: 'Поделиться…', icon: 'share', onClick: () => nativeShare(job) });
    items.push({ label: 'Ссылки доступа…', icon: 'lock', onClick: () => sharesSheet(job) });
    if (job.media !== 'image') items.push('-', { label: 'Конвертировать…', icon: 'convert', onClick: () => convertSheet(job) });
    if (ownerOfRow) items.push({ label: 'Переименовать…', icon: 'edit', onClick: () => editSheet(job) });
    if (state.isOwner() && mine(job)) items.push({ label: job.shared ? 'Убрать из «Для всех»' : 'Показать всем («Для всех»)', icon: 'users', onClick: () => post(`/api/jobs/${job.id}/shared`, { shared: !job.shared }).then(() => toast(job.shared ? 'Убрано из общей папки' : 'Теперь файл виден всем', { icon: 'users' })).catch((e) => toast(errorFriendly(e), { icon: 'warning' })) });
  } else if (['error', 'canceled'].includes(job.status)) {
    items.push({ label: 'Повторить', icon: 'retry', onClick: () => post(`/api/jobs/${job.id}/retry`) });
    if (job.hasLog) items.push({ label: 'Подробности', icon: 'info', onClick: () => detailsSheet(job) });
  } else if (job.status === 'paused') items.push({ label: 'Продолжить', icon: 'play', onClick: () => post(`/api/jobs/${job.id}/resume`) });
  if (isActive(job) && ownerOfRow) items.push({ label: 'Отменить', icon: 'stop', onClick: () => post(`/api/jobs/${job.id}/cancel`) });
  if (ownerOfRow) items.push('-', { label: 'Удалить', icon: 'trash', onClick: () => removeJobs([job]) });
  return menu(anchor, items);
}

// ── карточка ──
export function createCard(job, { ctx = {}, onSelect } = {}) {
  let sig = '', j = job, selected = false, selecting = false;
  const thumb = h('div.thumb');
  const img = h('img', { alt: '', loading: 'lazy', decoding: 'async' });
  const dur = h('span.dur', { hidden: true });
  const playov = h('div.playov', ic('play'));
  const selbox = h('div.selbox', { hidden: true }, ic('check'));
  thumb.append(img, playov, dur);
  const iconSlot = h('span');
  thumb.prepend(iconSlot);
  img.addEventListener('load', () => img.classList.add('ok'));
  img.addEventListener('error', () => { img.classList.remove('ok'); img.removeAttribute('src'); });
  const title = h('div.job-title');
  const meta = h('div.job-meta');
  const status = h('div.job-status');
  const act = h('div.job-act');
  const el = h('article.job', { 'data-id': job.id }, selbox, thumb, h('div.job-main', title, meta, status), act);
  thumb.tabIndex = 0; thumb.setAttribute('role', 'button');
  const open = () => { if (selecting) return toggleSel(); openJob(j, ctx); };
  thumb.addEventListener('click', open);
  thumb.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
  title.addEventListener('click', () => { if (selecting) toggleSel(); else if (j.status === 'done') openJob(j, ctx); });
  title.style.cursor = 'pointer';
  el.addEventListener('click', (e) => { if (selecting && !e.target.closest('button,a')) toggleSel(); });
  function toggleSel() { selected = !selected; el.classList.toggle('sel', selected); onSelect?.(j, selected); }

  function ring(p, ind) {
    const r = h('div', { class: `ring${ind ? ' spin' : ''}` });
    r.innerHTML = `<svg viewBox="0 0 46 46"><circle class="tr" cx="23" cy="23" r="20"/><circle class="fg" cx="23" cy="23" r="20" stroke-dasharray="${C}" stroke-dashoffset="${ind ? C * 0.72 : C * (1 - Math.min(100, p) / 100)}"/></svg><b>${ind ? '' : Math.floor(p) + '%'}</b>`;
    return r;
  }
  function buttons() {
    const b = (icn, label, fn, cls = '') => h('button', { class: `btn icon sm ${cls}`, type: 'button', 'aria-label': label, title: label, onclick: (e) => { e.stopPropagation(); fn(e); } }, ic(icn));
    const kids = [];
    const w = canWrite(j);
    if (j.status === 'done') {
      kids.push(b('download', 'Скачать на устройство', () => download(j)));
      if (j.media !== 'image') kids.push(b(j.media === 'audio' && curTrack()?.id === j.id && isPlaying() ? 'pause' : 'play', 'Смотреть или слушать', () => openJob(j, ctx), 'primary'));
      kids.push(b('more', 'Ещё', (e) => jobMenu(e.currentTarget, j, ctx), 'ghost'));
    } else {
      if (j.status === 'downloading' || j.status === 'queued') { if (w) kids.push(b('pause2', 'Приостановить', () => post(`/api/jobs/${j.id}/pause`))); }
      if (j.status === 'paused' && w) kids.push(b('play', 'Продолжить', () => post(`/api/jobs/${j.id}/resume`), 'primary'));
      if (['error', 'canceled'].includes(j.status)) {
        kids.push(h('button.btn.sm.primary', { type: 'button', onclick: (e) => { e.stopPropagation(); post(`/api/jobs/${j.id}/retry`).catch((er) => toast(errorFriendly(er), { icon: 'warning' })); } }, ic('retry'), 'Повторить'));
        if (j.hasLog) kids.push(b('info', 'Подробности', () => detailsSheet(j), 'ghost'));
        if (w) kids.push(b('trash', 'Удалить', () => removeJobs([j]), 'ghost'));
      } else if (w) kids.push(b('stop', 'Отменить', () => post(`/api/jobs/${j.id}/cancel`), 'ghost'));
    }
    return kids;
  }
  function update(nj) {
    j = nj;
    title.textContent = j.title || j.url;
    title.title = j.title || '';
    const sq = j.media === 'audio';
    thumb.classList.toggle('sq', sq);
    const wantIcon = MEDIA_ICON[j.media] || 'film';
    if (iconSlot.dataset.i !== wantIcon) { iconSlot.dataset.i = wantIcon; iconSlot.replaceChildren(ic(wantIcon)); }
    if (j.thumb) { if (img.dataset.src !== j.thumb) { img.dataset.src = j.thumb; img.classList.remove('ok'); img.src = j.thumb; } } else { img.removeAttribute('src'); img.dataset.src = ''; img.classList.remove('ok'); }
    dur.hidden = !(j.duration > 0 && j.status === 'done'); dur.textContent = fmtTime(j.duration);
    playov.replaceChildren(ic(j.media === 'audio' && curTrack()?.id === j.id && isPlaying() ? 'pause' : 'play'));
    playov.style.display = j.status === 'done' && j.media !== 'image' ? '' : 'none';
    // мета-строка
    const parts = [];
    if (j.uploader && j.media === 'audio') parts.push(j.uploader);
    if (j.site) parts.push(j.site);
    if (j.status === 'done') { const q = qualityText(j); if (q) parts.push(q); if (j.size) parts.push(fmtBytes(j.size)); parts.push(fmtDate(j.finishedAt || j.createdAt)); } else parts.push(fmtDate(j.createdAt));
    meta.replaceChildren(...[...parts.flatMap((p, i) => (i ? [h('span.sep', '·'), p] : [p])), j.shared ? h('span.chip.dash', ic('users'), 'для всех') : null, j.compat === 'pending' && j.status === 'done' ? h('span.chip.dash', 'готовится версия для браузера') : null].filter(Boolean));
    // статус
    status.className = 'job-status';
    status.replaceChildren();
    const pct = Math.floor(j.progress || 0);
    if (j.status === 'queued') status.append(ic('clock'), 'В очереди');
    else if (j.status === 'paused') status.append(ic('pause2'), 'На паузе');
    else if (j.status === 'downloading') {
      const bar = h('div.bar', { class: `bar${pct ? '' : ' ind'}` }, h('i', { style: { width: pct + '%' } }));
      status.append(bar, h('span', [`${pct}%`, j.speed ? ` · ${fmtSpeed(j.speed)}` : '', j.eta ? ` · ещё ${fmtEta(j.eta)}` : ''].join('')));
    } else if (j.status === 'processing') status.append(h('div.bar.ind', h('i')), 'Обрабатывается…');
    else if (j.status === 'error') { status.classList.add('err'); status.append(ic('warning'), h('span.clamp2', j.errMsg || 'Ошибка')); }
    else if (j.status === 'canceled') status.append(ic('stop'), 'Отменено');
    else if (j.meta?.warning) status.append(ic('info'), j.meta.warning);
    status.hidden = j.status === 'done' && !j.meta?.warning;
    // действия
    const s2 = `${j.status}|${j.media}|${j.compat}|${j.shared}|${j.hasLog}|${selecting}|${curTrack()?.id === j.id && isPlaying()}`;
    if (s2 !== sig) {
      sig = s2;
      const kids = buttons();
      if (j.status === 'downloading') kids.unshift(ring(pct, !pct));
      else if (j.status === 'processing') kids.unshift(ring(100, true));
      act.replaceChildren(...kids);
    } else if (j.status === 'downloading') {
      const r = act.querySelector('.ring');
      if (r) { r.classList.toggle('spin', !pct); r.querySelector('.fg').setAttribute('stroke-dashoffset', !pct ? C * 0.72 : C * (1 - pct / 100)); r.querySelector('b').textContent = pct ? pct + '%' : ''; }
    }
  }
  update(job);
  return {
    el, update, get job() { return j; },
    setSelecting(v) { selecting = v; selbox.hidden = !v; if (!v) { selected = false; el.classList.remove('sel'); } sig = ''; update(j); },
    setSelected(v) { selected = v; el.classList.toggle('sel', v); },
    get selected() { return selected; },
  };
}
