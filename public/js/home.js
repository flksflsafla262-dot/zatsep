// Главный экран и окно выбора формата
import { h, ic, sheet, segmented, sw, toast, fmtBytes, fmtTime, plural, setBusy, skeletonJobs } from './ui.js';
import { state, post, extractUrls, isActive, ApiError } from './api.js';
import { createCard, errorFriendly, autoDownload } from './jobs.js';

// «Сразу на устройство» — по умолчанию: файл качается тебе и не остаётся на сервере
const keepPref = { get: () => { try { return localStorage.getItem('keep') === '1'; } catch { return false; } }, set: (v) => { try { localStorage.setItem('keep', v ? '1' : '0'); } catch { /* */ } } };
const keepSwitch = (onChange) => h('label.check', h('span', 'Оставить копию на сервере', h('small', 'Выкл — файл просто скачается на это устройство и удалится с сервера')), sw(keepPref.get(), (v) => { keepPref.set(v); onChange?.(v); }));
import { pickFiles } from './upload.js';

const DIRECT = /\.(mp4|m4v|webm|mkv|mov|mp3|m4a|aac|flac|ogg|opus|wav)(\?|#|$)/i;
const kindOfUrl = (u) => { try { const p = new URL(u).pathname; if (/\.(m3u8|mpd)$/i.test(p)) return 'stream'; if (DIRECT.test(p)) return 'direct'; } catch { /* ignore */ } return 'ytdlp'; };

export async function startFlow(text) {
  const urls = extractUrls(text);
  if (!urls.length) { toast('Не нашёл ссылку. Вставь адрес страницы с видео или музыкой.', { icon: 'warning' }); return; }
  if (!state.tools.ytdlp || !state.tools.ffmpeg) { toast(state.isOwner() ? 'Не установлены yt-dlp/ffmpeg — выполни «npm run tools» и перезапусти сервер.' : 'Владелец ещё не установил инструменты скачивания.', { icon: 'warning', ms: 7000 }); }
  if (urls.length > 1) return bulkSheet(urls);
  return chooserSheet(urls[0]);
}

function defaultHeight(qualities) {
  const want = state.defaults.quality;
  if (!qualities.length) return 0;
  if (!want || want === 'best') return qualities[0].height;
  const n = Number(want);
  return (qualities.find((q) => q.height <= n) || qualities[qualities.length - 1]).height;
}

async function submit(items, opts, { shared = false, done } = {}) {
  opts = { ...opts, direct: !keepPref.get() && !shared };
  let res = await post('/api/jobs', { items, opts, shared });
  if (!res.jobs.length && res.duplicates.length) {
    const d = res.duplicates[0];
    const again = await new Promise((resolve) => {
      let picked = null;
      const s = sheet({
        title: d.active ? 'Уже качается' : 'Уже есть', narrow: true, onClose: () => resolve(picked),
        body: h('p.muted', d.active ? `«${d.job.title}» уже в очереди с такими же настройками.` : `«${d.job.title}» уже скачан с такими же настройками. Скачать ещё раз?`),
        foot: [h('a.btn.ghost', { href: '#/downloads', onclick: () => { picked = 'open'; s.close('open'); } }, 'Открыть загрузки'), d.active ? null : h('button.btn.primary', { type: 'button', onclick: () => { picked = 'again'; s.close('again'); } }, ic('retry'), 'Скачать ещё раз')],
      });
    });
    if (again !== 'again') return false;
    res = await post('/api/jobs', { items, opts, shared, force: true });
  }
  const skipped = res.duplicates.length;
  if (opts.direct) res.jobs.forEach((j) => autoDownload.add(j.id));
  toast(`${opts.direct ? 'Скачаю и отдам на устройство, когда будет готово' : res.jobs.length > 1 ? `Добавлено в очередь: ${res.jobs.length}` : 'Добавлено в очередь'}${skipped ? ` · ${skipped} уже есть` : ''}`, { icon: 'download', action: 'Открыть', onAction: () => { location.hash = '#/downloads'; } });
  done?.();
  return true;
}

// ── несколько ссылок ──
function bulkSheet(urls) {
  let mode = 'video', quality = 0, afmt = state.defaults.audio || 'best';
  const body = h('div.stack');
  const s = sheet({ title: `Ссылок: ${urls.length}`, body, foot: [h('button.btn.ghost', { type: 'button', onclick: () => s.close() }, 'Отмена'), h('button.btn.primary.lg', { type: 'button', onclick: go }, ic('download'), `Скачать все (${urls.length})`)] });
  const draw = () => body.replaceChildren(
    h('div.plist', urls.map((u, i) => h('div.pl-item', { style: { cursor: 'default' } }, h('span.n', String(i + 1)), h('span.t.ellip.small', u)))),
    segmented([{ v: 'video', label: 'Видео', icon: 'film' }, { v: 'audio', label: 'Аудио', icon: 'music' }], mode, (v) => { mode = v; draw(); }),
    mode === 'video'
      ? h('div.field', h('label', 'Качество'), segmented([[0, 'Лучшее'], [1080, '1080p'], [720, '720p'], [480, '480p'], [360, '360p']].map(([v, label]) => ({ v, label })), quality, (v) => { quality = v; }, 'wrap'))
      : h('div.field', h('label', 'Формат'), segmented([['best', 'Исходный'], ['mp3', 'MP3'], ['m4a', 'M4A'], ['opus', 'OPUS'], ['flac', 'FLAC']].map(([v, label]) => ({ v, label })), afmt, (v) => { afmt = v; }, 'wrap')),
    keepSwitch(),
    h('p.muted.small', 'Одновременно качается не больше трёх — остальные ждут своей очереди. Порядок можно менять, загрузки — ставить на паузу.'));
  draw();
  async function go(e) {
    setBusy(e.currentTarget, true);
    try {
      const ok = await submit(urls.map((u) => ({ url: u, kind: kindOfUrl(u) })), { mode, height: quality || undefined, qualityLabel: quality ? `${quality}p` : undefined, afmt, container: state.defaults.container, abr: 320 });
      if (ok) s.close();
    } catch (er) { toast(errorFriendly(er), { icon: 'warning' }); }
    setBusy(e.currentTarget, false);
  }
}

// ── одна ссылка: разбор и выбор формата ──
export function chooserSheet(url, { playlist = false } = {}) {
  const ctrl = new AbortController();
  const body = h('div.stack', h('div.preview', h('div.thumb.skel'), h('div', h('div.skel', { style: { height: '18px', width: '90%', marginBottom: '8px' } }), h('div.skel', { style: { height: '13px', width: '50%' } }))), h('div.skel', { style: { height: '46px' } }), h('div.skel', { style: { height: '90px' } }), h('p.muted.small', { style: { textAlign: 'center' } }, 'Разбираю ссылку… обычно это 3–10 секунд'));
  const s = sheet({ title: 'Разбор ссылки', body, onClose: () => ctrl.abort() });
  load();

  async function load() {
    try {
      const d = await post('/api/probe', { url, playlist, single: true }, { signal: ctrl.signal });
      build(d.info);
    } catch (e) {
      if (e.name === 'AbortError') return;
      showError(e);
    }
  }
  function showError(e) {
    const code = e.code || 'unknown';
    const hint = { bot: 'Владелец может загрузить cookies.txt в «Настройки → Cookies».', login: 'Владелец может загрузить cookies.txt в «Настройки → Cookies».', age: 'Владелец может загрузить cookies.txt в «Настройки → Cookies».', parse: 'Владелец может нажать «Обновить yt-dlp» в настройках.', no_ytdlp: 'Владельцу нужно выполнить «npm run tools» и перезапустить сервер.' }[code];
    body.replaceChildren(h('div.empty', { style: { padding: '16px 0' } }, ic(code === 'drm' ? 'lock' : 'warning'), h('b', code === 'drm' ? 'Скачать нельзя' : 'Не получилось'), h('p', e.message || 'Ошибка'), hint ? h('p.small', hint) : null));
    s.setFoot([e.data?.details ? h('button.btn.ghost', { type: 'button', onclick: () => showDetails(e) }, ic('info'), 'Подробности') : null, !['drm', 'no_ytdlp'].includes(code) ? h('button.btn', { type: 'button', onclick: () => { s.close(); chooserSheet(url, { playlist }); } }, ic('retry'), 'Ещё раз') : null, h('button.btn.primary', { type: 'button', onclick: () => s.close() }, 'Закрыть')]);
  }
  function showDetails(e) {
    sheet({ title: 'Подробности', body: h('div.stack', h('p', e.message), h('pre.log', e.data?.details || '')), foot: [h('button.btn.primary', { type: 'button', onclick: (ev) => ev.currentTarget.closest('.scrim').querySelector('.ib').click() }, 'Закрыть')] });
  }

  function build(info) {
    if (info.isPlaylist) return buildPlaylist(info);
    const imgs = info.images?.length ? info.images : [];
    const modes = [];
    if (info.hasVideo) modes.push({ v: 'video', label: 'Видео', icon: 'film' });
    if (info.hasAudio || info.hasVideo) modes.push({ v: 'audio', label: 'Аудио', icon: 'music' });
    if (imgs.length || (info.thumbnail && !info.hasVideo && !info.hasAudio) || (info.thumbnail && info.kind === 'ytdlp')) modes.push({ v: 'image', label: 'Картинка', icon: 'image' });
    if (!modes.length) modes.push({ v: 'video', label: 'Видео', icon: 'film' });
    const st = {
      mode: modes[0].v, height: defaultHeight(info.qualities || []), container: state.defaults.container || 'mp4', afmt: state.defaults.audio || 'best', abr: 320,
      embedThumb: true, chapters: true, tags: { ...(info.tags || { title: info.title, artist: '', album: '', year: '' }) }, tagsEdited: false, clip: { from: '', to: '' },
      subs: new Set(), subFmt: 'srt', subEmbed: false, sponsor: false, shared: false, more: false,
    };
    const isYt = /youtu/i.test(info.siteHost || '') || /youtube/i.test(info.site || '');
    const proxied = (u) => (u ? `/api/proxy-img?u=${encodeURIComponent(u)}` : null);

    const draw = () => {
      const kids = [];
      const th = h('div.thumb', ic('film'));
      if (info.thumbnail) { const img = h('img', { src: proxied(info.thumbnail), alt: '' }); img.onload = () => img.classList.add('ok'); th.append(img); }
      if (info.duration) th.append(h('span.dur', fmtTime(info.duration)));
      kids.push(h('div.preview', th, h('div', h('h4.clamp2', info.title), h('div.muted.small', [info.uploader, info.uploadDate ? new Date(info.uploadDate).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' }) : null].filter(Boolean).join(' · ')), h('div.row', { style: { gap: '6px', marginTop: '8px' } }, h('span.chip', ic('globe'), info.site || info.siteHost), info.live ? h('span.chip.solid', 'прямой эфир') : null, info.viaHtml ? h('span.chip.dash', 'найдено на странице') : null))));
      if (info.listParam) kids.push(h('div.banner', ic('list'), h('span', 'Это видео из плейлиста. Скачается только оно.'), h('button.btn.sm', { type: 'button', onclick: () => { s.close(); chooserSheet(url, { playlist: true }); } }, 'Весь плейлист')));
      if (modes.length > 1) kids.push(segmented(modes, st.mode, (v) => { st.mode = v; draw(); }));

      if (st.mode === 'video') {
        if (info.qualities?.length) kids.push(h('div.field', h('label', 'Качество'), segmented(info.qualities.map((q) => ({ v: q.height, label: q.label, small: q.size ? fmtBytes(q.size) : '' })), st.height, (v) => { st.height = v; updateBtn(); }, 'wrap')));
        else kids.push(h('p.muted.small', info.streamType ? 'Поток скачается в лучшем качестве без перекодирования.' : 'Качество определит сайт — будет скачан лучший вариант.'));
        kids.push(h('div.field', h('label', 'Контейнер'), segmented([['mp4', 'MP4'], ['mkv', 'MKV'], ['webm', 'WEBM']].map(([v, label]) => ({ v, label })), st.container, (v) => { st.container = v; }), h('div.hint', 'MP4 играет везде — на телефоне, телевизоре и в любом браузере.')));
      } else if (st.mode === 'audio') {
        kids.push(h('div.field', h('label', 'Формат'), segmented([['best', 'Исходный'], ['mp3', 'MP3'], ['m4a', 'M4A'], ['opus', 'OPUS'], ['flac', 'FLAC'], ['wav', 'WAV']].map(([v, label]) => ({ v, label })), st.afmt, (v) => { st.afmt = v; draw(); }, 'wrap'), h('div.hint', st.afmt === 'best' ? `Лучший звук как есть${info.audio?.ext ? ` (${info.audio.ext})` : ''} — без потерь на перекодировании.` : 'Файл будет перекодирован.')));
        if (['mp3', 'm4a'].includes(st.afmt)) kids.push(h('div.field', h('label', 'Качество, кбит/с'), segmented([128, 192, 256, 320].map((v) => ({ v, label: String(v) })), st.abr, (v) => { st.abr = v; })));
      } else kids.push(h('p.muted.small', imgs.length > 1 ? `Найдено картинок: ${imgs.length}. Скачаются все.` : 'Скачается картинка в максимальном разрешении.'));

      // «Ещё»
      kids.push(keepSwitch());
      if (st.mode !== 'image') {
        const more = h('details.more', { open: st.more }, h('summary', ic('settings'), 'Ещё', ic('down')));
        more.addEventListener('toggle', () => { st.more = more.open; });
        const inner = h('div');
        const from = h('input.input', { placeholder: '0:00', value: st.clip.from, 'aria-label': 'Начало', oninput: (e) => { st.clip.from = e.target.value; } });
        const to = h('input.input', { placeholder: info.duration ? fmtTime(info.duration) : 'до конца', value: st.clip.to, 'aria-label': 'Конец', oninput: (e) => { st.clip.to = e.target.value; } });
        inner.append(h('div.field', h('label', 'Вырезать фрагмент'), h('div.grid2.keep', from, to), h('div.hint', 'Время вида 1:23 — без перекодирования, где возможно. Пусто — целиком.')));
        if (st.mode === 'audio') {
          const tf = (k, label) => h('div.field', h('label', label), h('input.input', { value: st.tags[k] || '', oninput: (e) => { st.tags[k] = e.target.value; st.tagsEdited = true; } }));
          inner.append(h('div.field', h('label', 'Теги в файле'), h('div.grid2', tf('title', 'Название'), tf('artist', 'Исполнитель'), tf('album', 'Альбом'), tf('year', 'Год'))));
          inner.append(h('label.check', h('span', 'Встроить обложку', h('small', 'Картинка внутри аудиофайла')), sw(st.embedThumb, (v) => { st.embedThumb = v; })));
        }
        if (info.chapters) inner.append(h('label.check', h('span', `Главы (${info.chapters})`, h('small', 'Встроить главы в файл')), sw(st.chapters, (v) => { st.chapters = v; })));
        if (info.subs?.length) {
          const chips = h('div.row', { style: { gap: '8px' } }, info.subs.map((sb) => { const c = h('button', { type: 'button', class: `chip${st.subs.has(sb.lang) ? ' solid' : ''}`, onclick: () => { if (st.subs.has(sb.lang)) st.subs.delete(sb.lang); else st.subs.add(sb.lang); c.classList.toggle('solid'); } }, sb.name); return c; }));
          inner.append(h('div.field', h('label', 'Субтитры'), chips, h('div.row', segmented([['srt', 'SRT'], ['vtt', 'VTT']].map(([v, label]) => ({ v, label })), st.subFmt, (v) => { st.subFmt = v; }, 'sm'), st.mode === 'video' ? h('label.row', { style: { gap: '10px' } }, sw(st.subEmbed, (v) => { st.subEmbed = v; }), h('span.small', 'Вшить в видео')) : null)));
        }
        if (isYt) inner.append(h('label.check', h('span', 'Убрать рекламные вставки', h('small', 'SponsorBlock: спонсоры, самореклама, заставки')), sw(st.sponsor, (v) => { st.sponsor = v; })));
        if (state.isOwner()) inner.append(h('label.check', h('span', 'Положить в «Для всех»', h('small', 'Файл увидят и друзья')), sw(st.shared, (v) => { st.shared = v; })));
        more.append(inner);
        kids.push(more);
      }
      body.replaceChildren(...kids);
      updateBtn();
    };

    const btn = h('button.btn.primary.lg', { type: 'button', onclick: go }, ic('download'), 'Скачать');
    const updateBtn = () => {
      const q = (info.qualities || []).find((x) => x.height === st.height);
      btn.replaceChildren(ic('download'), st.mode === 'video' && q?.size ? `Скачать · ${fmtBytes(q.size)}` : 'Скачать');
    };
    s.setFoot([h('button.btn.ghost', { type: 'button', onclick: () => s.close() }, 'Отмена'), btn]);
    s.el.querySelector('h3').textContent = 'Что скачать?';
    draw();

    async function go() {
      setBusy(btn, true);
      try {
        const q = (info.qualities || []).find((x) => x.height === st.height);
        const base = { title: info.title, uploader: info.uploader, thumbnail: info.thumbnail, duration: info.duration, site: info.site };
        let items, opts;
        if (st.mode === 'image') {
          const list = imgs.length ? imgs : [info.thumbnail];
          items = list.map((u, i) => ({ url: u, kind: 'image', title: list.length > 1 ? `${info.title} (${i + 1})` : info.title, thumbnail: u, site: info.site, page: info.webpageUrl, referer: info.webpageUrl }));
          opts = { mode: 'image' };
        } else {
          const kind = info.kind === 'ytdlp' ? 'ytdlp' : info.kind === 'stream' ? 'stream' : info.kind === 'direct' ? 'direct' : 'ytdlp';
          items = [{ ...base, url: info.embedUrl || info.url, kind, referer: info.referer || undefined, expSize: q?.size || info.size || undefined, streamType: info.streamType || undefined }];
          opts = {
            mode: st.mode, height: st.mode === 'video' ? st.height || undefined : undefined, qualityLabel: q?.label, container: st.container, afmt: st.afmt, abr: st.abr,
            clip: st.clip.from || st.clip.to ? st.clip : undefined, embedThumb: st.embedThumb, chapters: st.chapters, tags: st.mode === 'audio' ? st.tags : undefined, tagsEdited: st.tagsEdited,
            subs: st.subs.size ? { langs: [...st.subs], fmt: st.subFmt, embed: st.subEmbed, auto: (info.subs || []).some((x) => st.subs.has(x.lang) && x.auto) } : undefined, sponsorblock: st.sponsor,
          };
        }
        const ok = await submit(items, opts, { shared: st.shared });
        if (ok) s.close();
      } catch (er) { toast(errorFriendly(er), { icon: 'warning' }); }
      setBusy(btn, false);
    }
  }

  function buildPlaylist(info) {
    const entries = info.entries;
    const st = { mode: info.carousel ? 'image' : 'video', height: 0, afmt: state.defaults.audio || 'best', container: state.defaults.container || 'mp4', abr: 320, sel: new Set(entries.map((e) => e.i)), from: '', to: '' };
    const list = h('div.plist');
    const count = h('span.muted.small');
    const btn = h('button.btn.primary.lg', { type: 'button', onclick: go });
    const modes = info.carousel ? [{ v: 'image', label: 'Картинки', icon: 'image' }] : [{ v: 'video', label: 'Видео', icon: 'film' }, { v: 'audio', label: 'Аудио', icon: 'music' }];
    const optBox = h('div.stack-sm');
    const drawOpts = () => optBox.replaceChildren(...(st.mode === 'video'
      ? [h('div.field', h('label', 'Качество'), segmented([[0, 'Лучшее'], [1080, '1080p'], [720, '720p'], [480, '480p'], [360, '360p']].map(([v, label]) => ({ v, label })), st.height, (v) => { st.height = v; }, 'wrap'))]
      : st.mode === 'audio' ? [h('div.field', h('label', 'Формат'), segmented([['best', 'Исходный'], ['mp3', 'MP3'], ['m4a', 'M4A'], ['opus', 'OPUS'], ['flac', 'FLAC']].map(([v, label]) => ({ v, label })), st.afmt, (v) => { st.afmt = v; }, 'wrap'))] : []));
    const paint = () => {
      list.replaceChildren(...entries.map((e) => {
        const row = h('div', { class: `pl-item${st.sel.has(e.i) ? ' on' : ''}`, role: 'checkbox', 'aria-checked': st.sel.has(e.i) ? 'true' : 'false', tabindex: '0', onclick: () => { if (st.sel.has(e.i)) st.sel.delete(e.i); else st.sel.add(e.i); paint(); }, onkeydown: (ev) => { if (ev.key === ' ' || ev.key === 'Enter') { ev.preventDefault(); row.click(); } } },
          h('span.cb', ic('check')), h('span.n', String(e.i)), h('span.t.ellip', e.title), h('span.muted.small', e.duration ? fmtTime(e.duration) : ''));
        return row;
      }));
      const n = st.sel.size;
      count.textContent = `Выбрано ${n} из ${entries.length}`;
      btn.replaceChildren(ic('download'), n ? `Скачать ${n} ${st.mode === 'audio' ? plural(n, 'трек', 'трека', 'треков') : st.mode === 'image' ? plural(n, 'картинку', 'картинки', 'картинок') : plural(n, 'видео', 'видео', 'видео')}` : 'Ничего не выбрано');
      btn.disabled = !n;
    };
    const from = h('input.input', { placeholder: '1', inputmode: 'numeric', 'aria-label': 'С номера', oninput: (e) => { st.from = e.target.value; } });
    const to = h('input.input', { placeholder: String(entries.length), inputmode: 'numeric', 'aria-label': 'По номер', oninput: (e) => { st.to = e.target.value; } });
    const applyRange = () => { const a = Math.max(1, parseInt(st.from, 10) || 1), b = Math.min(entries.length, parseInt(st.to, 10) || entries.length); st.sel = new Set(entries.filter((e) => e.i >= a && e.i <= b).map((e) => e.i)); paint(); };
    body.replaceChildren(
      h('div.preview', { style: { gridTemplateColumns: '1fr' } }, h('div', h('h4.clamp2', info.title), h('div.row', { style: { gap: '6px' } }, h('span.chip', ic('list'), `${info.count} ${plural(info.count, 'элемент', 'элемента', 'элементов')}`), h('span.chip', ic('globe'), info.site)), info.truncated ? h('p.muted.small', { style: { marginTop: '6px' } }, 'Показаны первые 100.') : null)),
      modes.length > 1 ? segmented(modes, st.mode, (v) => { st.mode = v; drawOpts(); paint(); }) : null, optBox,
      h('div.row', { style: { justifyContent: 'space-between' } }, count, h('div.row', { style: { gap: '6px' } }, h('button.btn.sm', { type: 'button', onclick: () => { st.sel = new Set(entries.map((e) => e.i)); paint(); } }, 'Все'), h('button.btn.sm', { type: 'button', onclick: () => { st.sel.clear(); paint(); } }, 'Ничего'))),
      list,
      h('div.field', h('label', 'Диапазон'), h('div.row', { style: { flexWrap: 'nowrap' } }, h('div.grow', from), h('span.muted', '—'), h('div.grow', to), h('button.btn', { type: 'button', onclick: applyRange }, 'Выбрать'))),
      keepSwitch(),
      h('p.muted.small', 'Каждый элемент скачивается отдельным файлом. Браузер может спросить разрешение на несколько загрузок. Хочешь один архив — включи «Оставить копию» и собери ZIP в «Загрузках».'),
    );
    s.setFoot([h('button.btn.ghost', { type: 'button', onclick: () => s.close() }, 'Отмена'), btn]);
    s.el.querySelector('h3').textContent = info.carousel ? 'Картинки' : 'Плейлист';
    drawOpts(); paint();
    async function go() {
      setBusy(btn, true);
      try {
        const chosen = entries.filter((e) => st.sel.has(e.i));
        const items = chosen.map((e) => ({ url: e.url, kind: st.mode === 'image' ? 'image' : kindOfUrl(e.url), title: e.title, uploader: e.uploader, thumbnail: e.thumbnail, duration: e.duration, site: info.site, page: info.webpageUrl, referer: info.webpageUrl }));
        const ok = await submit(items, { mode: st.mode, height: st.height || undefined, qualityLabel: st.height ? `${st.height}p` : undefined, afmt: st.afmt, container: st.container, abr: st.abr });
        if (ok) s.close();
      } catch (er) { toast(errorFriendly(er), { icon: 'warning' }); }
      setBusy(btn, false);
    }
  }
}

// ── страница ──
export function mountHome(root) {
  const ta = h('textarea', { rows: 1, placeholder: 'Вставь ссылку…', 'aria-label': 'Ссылка на видео или музыку', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', enterkeyhint: 'go' });
  const grow = () => { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 180) + 'px'; };
  ta.addEventListener('input', grow);
  const go = () => { const t = ta.value.trim(); if (!t) { ta.focus(); return; } startFlow(t); };
  ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); go(); } });
  const pasteBtn = h('button.btn', { type: 'button', onclick: async () => {
    try { const t = await navigator.clipboard.readText(); if (!t) throw new Error('empty'); ta.value = t; grow(); if (extractUrls(t).length) go(); else toast('В буфере нет ссылки', { icon: 'info' }); } catch { ta.focus(); toast('Браузер не дал прочитать буфер. Вставь вручную: Ctrl+V или долгое нажатие.', { icon: 'info', ms: 5000 }); }
  } }, ic('paste'), 'Вставить');
  const goBtn = h('button.btn.primary', { type: 'button', onclick: go }, ic('download'), 'Скачать');

  const missing = !state.tools.ytdlp || !state.tools.ffmpeg;
  const activeBox = h('div.jobs'), activeSec = h('section.section', { hidden: true }, h('div.section-head', h('h2', 'В очереди и в работе')), activeBox);
  const recentBox = h('div.jobs'), recentSec = h('section.section', { hidden: true }, h('div.section-head', h('h2', 'Недавние'), h('a.btn.sm.ghost', { href: '#/downloads' }, 'Все загрузки', ic('right'))), recentBox);
  root.append(...[
    missing ? h('div.card.banner-top', h('div.row', ic('warning'), h('div.grow', h('b', 'Не хватает инструментов'), h('p.muted.small', state.isOwner() ? `На сервере не найден ${[!state.tools.ytdlp && 'yt-dlp', !state.tools.ffmpeg && 'ffmpeg'].filter(Boolean).join(' и ')}. Выполни в папке проекта «npm run tools» и перезапусти сервер.` : 'Владелец ещё не установил инструменты скачивания.')))) : null,
    h('section.hero', h('h1', 'Вставь ссылку'), h('p', 'YouTube, SoundCloud, TikTok, Instagram, VK, Rutube и сотни других сайтов. Вставил ссылку — файл скачался прямо на твоё устройство.'),
      h('div.paste-box', ta, h('div.btns', pasteBtn, goBtn)),
      h('div.hero-tools', h('button.btn.sm.ghost', { type: 'button', onclick: pickFiles }, ic('upload'), 'Загрузить свой файл'), h('span.muted.small', { style: { alignSelf: 'center' } }, 'Можно вставить ссылку где угодно на странице — Ctrl+V — или перетащить её сюда')),
      h('div.sites', ['YouTube', 'Shorts', 'SoundCloud', 'Bandcamp', 'TikTok', 'Instagram', 'X', 'VK', 'Rutube', 'Twitch', 'Reddit', 'Vimeo', 'Дзен', 'прямые .mp4 .mp3 .m3u8'].map((n, i, a) => h('span', n + (i < a.length - 1 ? ' ·' : ''))))),
    activeSec, recentSec,
  ].filter(Boolean));
  setTimeout(() => { if (matchMedia('(pointer:fine)').matches) ta.focus({ preventScroll: true }); }, 400);

  const cards = new Map();
  function sync(box, list, sec, limit) {
    const want = new Set(list.map((j) => j.id));
    for (const [k, c] of cards) if (c.box === box && !want.has(k)) { cards.delete(k); }
    const els = list.slice(0, limit).map((j) => {
      let c = cards.get(j.id);
      if (!c || c.box !== box) { c = { card: createCard(j), box }; cards.set(j.id, c); } else c.card.update(j);
      return c.card.el;
    });
    const sig = els.map((e) => e.dataset.id).join(',');
    if (box.dataset.sig !== sig) { box.dataset.sig = sig; box.replaceChildren(...els); }
    sec.hidden = !els.length;
  }
  function render() {
    if (!state.jobsLoaded) { activeBox.replaceChildren(...skeletonJobs(2)); activeSec.hidden = false; return; }
    const mine = state.jobList().filter((j) => j.userId === state.me.id);
    const act = mine.filter(isActive).sort((a, b) => (a.status === 'queued') - (b.status === 'queued') || a.pos - b.pos);
    sync(activeBox, act, activeSec, 30);
    for (const j of act) { const c = cards.get(j.id); if (c && c.box === activeBox) c.card.update(j); }
    sync(recentBox, mine.filter((j) => !isActive(j)).slice(0, 6), recentSec, 6);
  }
  const unsubs = [state.on('jobs', render), state.on('job', ({ job, prev }) => { const c = cards.get(job.id); if (c && prev && prev.status === job.status) c.card.update(job); else render(); }), state.on('job-removed', render)];
  render();
  return () => unsubs.forEach((u) => u());
}
void ApiError;
