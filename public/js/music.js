// Раздел «Музыка»: список с обложками, очередь, перемешивание, плейлисты
import { h, ic, segmented, debounce, fmtTime, emptyState, toast, askText, confirmSheet, menu } from './ui.js';
import { state, put, del, post, loadPlaylists } from './api.js';
import { jobMenu, errorFriendly } from './jobs.js';
import { playQueue, playShuffled, current, isPlaying, onAudio, toggle } from './audio.js';

export function mountMusic(root) {
  let view = 'all', q = '';
  const listEl = h('div.tracks');
  const head = h('div');
  const tabsHost = h('div', { style: { marginBottom: '16px', maxWidth: '100%' } });
  const search = h('input.input', { type: 'search', placeholder: 'Поиск по трекам…', 'aria-label': 'Поиск', oninput: debounce((e) => { q = e.target.value.trim().toLowerCase(); render(); }, 120) });
  root.append(
    h('div.page-head', h('div', h('h1', 'Музыка'), h('p', 'Все аудио из загрузок. Музыка не прерывается, пока ходишь по сайту.'))),
    tabsHost, h('div.toolbar', h('div.search', ic('search'), search)), head, listEl,
  );

  const audioJobs = () => state.jobList().filter((j) => j.media === 'audio' && j.status === 'done');
  function tracks() {
    let list = audioJobs();
    if (view !== 'all') {
      const p = state.playlists.find((x) => `pl:${x.id}` === view);
      if (p) { const m = new Map(list.map((j) => [j.id, j])); list = p.items.map((id) => m.get(id)).filter(Boolean); } else { view = 'all'; }
    } else list.sort((a, b) => (b.finishedAt || 0) - (a.finishedAt || 0));
    if (q) list = list.filter((j) => `${j.title} ${j.uploader || ''} ${j.album || ''}`.toLowerCase().includes(q));
    return list;
  }
  function drawTabs() {
    tabsHost.replaceChildren(h('div.row', segmented([{ v: 'all', label: 'Все треки', small: String(audioJobs().length || '') }, ...state.playlists.map((p) => ({ v: `pl:${p.id}`, label: p.name, small: String(p.items.length) }))], view, (v) => { view = v; render(); }, 'sm'),
      h('button.btn.sm.outline', { type: 'button', onclick: async () => { const name = await askText({ title: 'Новый плейлист', label: 'Название', ok: 'Создать' }); if (!name) return; try { const p = await post('/api/playlists', { name }); await loadPlaylists(); view = `pl:${p.id}`; drawTabs(); render(); } catch (e) { toast(errorFriendly(e), { icon: 'warning' }); } } }, ic('plus'), 'Плейлист')));
  }
  function trackRow(j, list) {
    const cover = h('div.cover', ic('music'));
    if (j.thumb) { const img = h('img', { src: j.thumb, alt: '', loading: 'lazy' }); img.onerror = () => img.remove(); cover.append(img); }
    cover.append(h('div.eq', h('i'), h('i'), h('i')));
    const more = h('button.ib', { type: 'button', 'aria-label': 'Ещё', onclick: (e) => { e.stopPropagation(); const items = [];
      jobMenu(e.currentTarget, j, { audioList: list });
      void items; } }, ic('more'));
    const row = h('div', { class: `track${current()?.id === j.id ? ' cur' : ''}${current()?.id === j.id && isPlaying() ? ' playing' : ''}`, 'data-id': j.id, role: 'button', tabindex: '0', onclick: () => { if (current()?.id === j.id) toggle(); else playQueue(list, j.id); }, onkeydown: (e) => { if (e.key === 'Enter') row.click(); } },
      cover, h('div.t', h('b.ellip', j.title), h('small.muted.ellip', [j.uploader, j.album].filter(Boolean).join(' · ') || j.site || '')), h('span.dur', j.duration ? fmtTime(j.duration) : ''), more);
    return row;
  }
  function render() {
    drawTabs();
    const list = tracks();
    const pl = state.playlists.find((x) => `pl:${x.id}` === view);
    head.replaceChildren(h('div.row', { style: { margin: '6px 0 12px' } },
      h('button.btn.primary', { type: 'button', disabled: !list.length, onclick: () => playQueue(list) }, ic('play'), 'Играть'),
      h('button.btn', { type: 'button', disabled: !list.length, onclick: () => playShuffled(list) }, ic('shuffle'), 'Вперемешку'),
      pl ? h('button.btn.ghost.icon', { type: 'button', 'aria-label': 'Действия с плейлистом', onclick: (e) => menu(e.currentTarget, [
        { label: 'Переименовать', icon: 'edit', onClick: async () => { const n = await askText({ title: 'Переименовать плейлист', label: 'Название', value: pl.name }); if (n) { await put(`/api/playlists/${pl.id}`, { name: n }); await loadPlaylists(); render(); } } },
        { label: 'Удалить плейлист', icon: 'trash', onClick: async () => { if (await confirmSheet({ title: 'Удалить плейлист?', text: 'Треки останутся в загрузках.', ok: 'Удалить', danger: true })) { await del(`/api/playlists/${pl.id}`); await loadPlaylists(); view = 'all'; render(); } } },
      ]) }, ic('more')) : null,
      h('span.muted.small', `${list.length} трек.`)));
    listEl.replaceChildren(...(list.length ? list.map((j) => trackRow(j, list)) : [view === 'all' && !q ? emptyState('music', 'Музыки пока нет', 'Скачай трек в режиме «Аудио» — он появится здесь.', h('a.btn.primary', { href: '#/' }, ic('link'), 'Вставить ссылку')) : emptyState('search', 'Пусто', pl && !q ? 'Добавь треки через меню ⋯ → «В плейлист».' : 'Ничего не найдено.')]));
  }
  const rerender = debounce(render, 80);
  const un = [state.on('jobs', render), state.on('job', ({ job, prev }) => { if (job.media === 'audio' && (!prev || prev.status !== job.status || prev.title !== job.title)) rerender(); }), state.on('job-removed', rerender), state.on('playlists', render),
    onAudio(() => { const cur = current(); for (const r of listEl.querySelectorAll('.track')) { const on = cur && +r.dataset.id === cur.id; r.classList.toggle('cur', !!on); r.classList.toggle('playing', !!on && isPlaying()); } })];
  loadPlaylists().then(render);
  render();
  return () => un.forEach((u) => u());
}
