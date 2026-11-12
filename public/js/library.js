// Раздел «Загрузки»: фильтры, поиск, сортировка, пакетные действия, общая папка
import { h, ic, segmented, debounce, skeletonJobs, emptyState, toast, plural } from './ui.js';
import { state, isActive, post } from './api.js';
import { createCard, removeJobs, errorFriendly } from './jobs.js';
import { pickFiles } from './upload.js';
import { onAudio } from './audio.js';

const SORTS = { new: (a, b) => b.createdAt - a.createdAt || b.id - a.id, old: (a, b) => a.createdAt - b.createdAt, title: (a, b) => (a.title || '').localeCompare(b.title || '', 'ru'), size: (a, b) => (b.size || 0) - (a.size || 0) };

export function mountLibrary(root, { scope = 'mine' } = {}) {
  let filter = 'all', q = '', sort = 'new', selecting = false, shared = scope === 'shared';
  const cards = new Map();
  const sel = new Set();
  const grid = h('div.jobs');
  const emptyBox = h('div');
  const batch = h('div.batch');
  const pickBtn = h('button.btn.sm', { type: 'button', onclick: pickFiles }, ic('upload'), 'Загрузить файл');
  const selBtn = h('button.btn.sm.outline', { type: 'button', onclick: () => setSelecting(!selecting) }, ic('check'), 'Выбрать');
  const search = h('input.input', { type: 'search', placeholder: 'Поиск по названию…', 'aria-label': 'Поиск', oninput: debounce((e) => { q = e.target.value.trim().toLowerCase(); render(); }, 120) });
  const sortSel = h('select.select', { 'aria-label': 'Сортировка', style: { width: 'auto', minWidth: '150px', borderRadius: '999px' }, onchange: (e) => { sort = e.target.value; render(); } },
    h('option', { value: 'new' }, 'Сначала новые'), h('option', { value: 'old' }, 'Сначала старые'), h('option', { value: 'title' }, 'По названию'), h('option', { value: 'size' }, 'По размеру'));
  const tabs = segmented([{ v: 'all', label: 'Всё' }, { v: 'video', label: 'Видео', icon: 'film' }, { v: 'audio', label: 'Музыка', icon: 'music' }, { v: 'image', label: 'Картинки', icon: 'image' }, { v: 'active', label: 'В работе', small: '' }, { v: 'error', label: 'Ошибки', small: '' }], filter, (v) => { filter = v; render(); }, 'sm');
  const scopeTabs = state.isOwner() || true ? segmented([{ v: 'mine', label: 'Мои' }, { v: 'shared', label: 'Для всех', icon: 'users' }], scope, (v) => { shared = v === 'shared'; render(); }) : null;

  root.append(
    h('div.page-head', h('div', h('h1', 'Загрузки'), h('p', 'Всё, что скачано или загружено. Новое появляется здесь само.')), h('div.row', pickBtn, selBtn)),
    h('div.toolbar', scopeTabs),
    h('div.toolbar', h('div.search', ic('search'), search), sortSel),
    h('div', { style: { marginBottom: '18px', maxWidth: '100%', overflow: 'hidden' } }, tabs),
    grid, emptyBox,
  );
  document.getElementById('overlays').append(batch);

  function visible() {
    let list = state.jobList().filter((j) => (shared ? j.shared : j.userId === state.me.id));
    if (filter === 'video') list = list.filter((j) => j.media === 'video');
    else if (filter === 'audio') list = list.filter((j) => j.media === 'audio');
    else if (filter === 'image') list = list.filter((j) => j.media === 'image');
    else if (filter === 'active') list = list.filter(isActive);
    else if (filter === 'error') list = list.filter((j) => ['error', 'canceled'].includes(j.status));
    if (q) list = list.filter((j) => `${j.title} ${j.uploader || ''} ${j.site || ''}`.toLowerCase().includes(q));
    return list.sort(SORTS[sort]);
  }
  let order = '';
  function render() {
    if (!state.jobsLoaded) { grid.replaceChildren(...skeletonJobs(4)); return; }
    const mineAll = state.jobList().filter((j) => (shared ? j.shared : j.userId === state.me.id));
    tabs.setItems([{ v: 'active', small: String(mineAll.filter(isActive).length || '') }, { v: 'error', small: String(mineAll.filter((j) => ['error', 'canceled'].includes(j.status)).length || '') }]);
    const list = visible();
    const ids = list.map((j) => j.id).join(',');
    const ctx = { audioList: list.filter((j) => j.media === 'audio' && j.status === 'done') };
    const keep = new Set(list.map((j) => j.id));
    for (const [id, c] of cards) if (!keep.has(id)) { cards.delete(id); sel.delete(id); }
    const els = list.map((j) => {
      let c = cards.get(j.id);
      if (!c) { c = createCard(j, { ctx, onSelect: (jj, on) => { if (on) sel.add(jj.id); else sel.delete(jj.id); paintBatch(); } }); c.setSelecting(selecting); cards.set(j.id, c); } else { c.update(j); }
      c.setSelected(sel.has(j.id));
      return c.el;
    });
    if (ids !== order) { order = ids; grid.replaceChildren(...els); }
    emptyBox.replaceChildren();
    if (!list.length) {
      emptyBox.append(q || filter !== 'all' ? emptyState('search', 'Ничего не найдено', 'Попробуй другой фильтр или поиск.')
        : shared ? emptyState('users', 'Здесь пока пусто', state.isOwner() ? 'Открой меню ⋯ у файла и выбери «Показать всем» — он появится у друзей.' : 'Владелец ещё ничего сюда не положил.')
          : emptyState('download', 'Пока ничего нет', 'Вставь ссылку на главной — скачанное появится здесь.', h('a.btn.primary', { href: '#/' }, ic('link'), 'Вставить ссылку')));
    }
    paintBatch();
  }
  function setSelecting(v) {
    selecting = v; sel.clear();
    selBtn.classList.toggle('primary', v); selBtn.classList.toggle('outline', !v);
    selBtn.replaceChildren(ic('check'), v ? 'Готово' : 'Выбрать');
    for (const c of cards.values()) c.setSelecting(v);
    paintBatch();
  }
  function paintBatch() {
    batch.classList.toggle('on', selecting);
    const picked = [...sel].map((id) => state.jobs.get(id)).filter(Boolean);
    const done = picked.filter((j) => j.status === 'done');
    const errs = picked.filter((j) => ['error', 'canceled'].includes(j.status));
    const act = picked.filter(isActive);
    batch.replaceChildren(...[
      h('b', { style: { marginRight: '8px' } }, picked.length ? `${picked.length} ${plural(picked.length, 'выбран', 'выбрано', 'выбрано')}` : 'Выбери карточки'),
      h('button.btn.sm', { type: 'button', onclick: () => { const all = visible(); const every = all.every((j) => sel.has(j.id)); sel.clear(); if (!every) all.forEach((j) => sel.add(j.id)); for (const [id, c] of cards) c.setSelected(sel.has(id)); paintBatch(); } }, 'Все'),
      done.length ? h('a.btn.sm', { href: `/api/zip?ids=${done.map((j) => j.id).join(',')}&name=${encodeURIComponent('Зацеп')}`, download: '' }, ic('zip'), 'ZIP') : null,
      errs.length ? h('button.btn.sm', { type: 'button', onclick: async () => { await post('/api/jobs/bulk', { action: 'retry', ids: errs.map((j) => j.id) }); toast('Запущено заново'); } }, ic('retry'), 'Повторить') : null,
      act.length ? h('button.btn.sm', { type: 'button', onclick: async () => { await post('/api/jobs/bulk', { action: 'cancel', ids: act.map((j) => j.id) }); } }, ic('stop'), 'Отменить') : null,
      picked.length ? h('button.btn.sm.danger', { type: 'button', onclick: async () => { const ok = await removeJobs(picked); if (ok) { sel.clear(); paintBatch(); } } }, ic('trash'), 'Удалить') : null,
    ].filter(Boolean));
  }

  const rerender = debounce(render, 60);
  const unsubs = [
    state.on('jobs', render),
    state.on('job', ({ job, prev }) => {
      const c = cards.get(job.id);
      const structural = !c || !prev || prev.status !== job.status || prev.media !== job.media || prev.title !== job.title || prev.size !== job.size || prev.shared !== job.shared;
      if (structural) rerender(); else c.update(job);
    }),
    state.on('job-removed', () => rerender()),
    onAudio(() => { for (const c of cards.values()) if (c.job.media === 'audio') c.update(c.job); }),
  ];
  render();
  return () => { unsubs.forEach((u) => u()); batch.remove(); };
}
void errorFriendly;
