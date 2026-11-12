// Профиль, друзья (приглашения, лимиты), настройки владельца
import { h, ic, segmented, sw, toast, sheet, sheetField, confirmSheet, setBusy, fmtBytes, fmtDate, fmtRel, copyText, plural, menu } from './ui.js';
import { state, get, post, put, patch, del, api, loadMe } from './api.js';
import { errorFriendly } from './jobs.js';

export function applyTheme(t) {
  try { if (t === 'light' || t === 'dark') localStorage.setItem('theme', t); else localStorage.removeItem('theme'); } catch { /* ignore */ }
  if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t); else document.documentElement.removeAttribute('data-theme');
}
export const currentTheme = () => { try { return localStorage.getItem('theme') || 'auto'; } catch { return 'auto'; } };
export function avatarEl(u, cls = '') {
  const a = h('div', { class: `avatar ${cls}` }, (u.username || '?').slice(0, 1).toUpperCase());
  if (u.avatar) { const img = h('img', { src: `/api/avatar/${u.id}?v=${u.avatarV || 0}`, alt: '' }); img.onerror = () => img.remove(); a.append(img); }
  return a;
}

let installEvent = null;
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installEvent = e; });

// ───────────── профиль ─────────────
export function mountProfile(root, { rerenderShell }) {
  const me = state.me;
  const avatarWrap = h('div');
  const drawAvatar = () => avatarWrap.replaceChildren(h('div.avatar-edit', { role: 'button', tabindex: '0', 'aria-label': 'Сменить аватар', onclick: pick }, avatarEl({ ...state.me, avatarV: Date.now() }, 'lg'), h('span.edit', ic('edit'))));
  function pick() {
    const inp = h('input', { type: 'file', accept: 'image/jpeg,image/png,image/webp', style: { display: 'none' } });
    inp.onchange = async () => {
      const f = inp.files[0]; if (!f) return;
      try {
        const blob = await squareCrop(f);
        await api('PUT', '/api/avatar', blob, { type: blob.type });
        await loadMe(); drawAvatar(); rerenderShell(); toast('Аватар обновлён');
      } catch (e) { toast(errorFriendly(e), { icon: 'warning' }); }
    };
    document.body.append(inp); inp.click(); setTimeout(() => inp.remove(), 60000);
  }
  drawAvatar();
  const name = h('input.input', { value: me.username, maxlength: 32 });
  const nameBtn = h('button.btn.primary', { type: 'button', onclick: async () => { setBusy(nameBtn, true); try { await post('/api/profile', { username: name.value }); await loadMe(); rerenderShell(); toast('Имя сохранено'); } catch (e) { toast(errorFriendly(e), { icon: 'warning' }); } setBusy(nameBtn, false); } }, 'Сохранить');
  const op = h('input.input', { type: 'password', autocomplete: 'current-password' }), np = h('input.input', { type: 'password', autocomplete: 'new-password' }), np2 = h('input.input', { type: 'password', autocomplete: 'new-password' });
  const pwBtn = h('button.btn.primary', { type: 'button', onclick: async () => {
    if (np.value !== np2.value) return toast('Новые пароли не совпадают', { icon: 'warning' });
    setBusy(pwBtn, true);
    try { await post('/api/password', { oldPassword: op.value, newPassword: np.value }); op.value = np.value = np2.value = ''; await loadMe(); rerenderShell(); toast('Пароль изменён. Остальные устройства разлогинены.'); } catch (e) { toast(errorFriendly(e), { icon: 'warning' }); }
    setBusy(pwBtn, false);
  } }, 'Сменить пароль');
  const theme = segmented([{ v: 'auto', label: 'Как в системе', icon: 'auto' }, { v: 'light', label: 'Светлая', icon: 'sun' }, { v: 'dark', label: 'Тёмная', icon: 'moon' }], currentTheme(), (v) => applyTheme(v === 'auto' ? null : v));
  const notifOn = 'Notification' in window && Notification.permission === 'granted';
  const notif = sw(notifOn, async (on) => {
    if (!('Notification' in window)) { toast('Этот браузер не поддерживает уведомления', { icon: 'info' }); notif.input.checked = false; return; }
    if (on) { const r = await Notification.requestPermission(); notif.input.checked = r === 'granted'; toast(r === 'granted' ? 'Уведомления включены' : 'Разрешение не выдано — включи его в настройках сайта в браузере', { icon: 'bell' }); } else toast('Отключить можно в настройках сайта в браузере', { icon: 'info' });
  });
  const usage = h('div');
  get('/api/stats').then((s) => {
    const lim = s.limits?.quotaGB ? s.limits.quotaGB * 1e9 : 0;
    usage.replaceChildren(h('div.stat-row', h('div.stat', h('b', fmtBytes(s.used)), h('span', `занято (${s.count} ${plural(s.count, 'файл', 'файла', 'файлов')})`)), h('div.stat', h('b', fmtBytes(s.free)), h('span', 'свободно на сервере')), lim ? h('div.stat', h('b', fmtBytes(lim)), h('span', 'твой лимит')) : null, s.limits?.perDay ? h('div.stat', h('b', String(s.limits.perDay)), h('span', 'загрузок в сутки')) : null));
  }).catch(() => {});
  root.append(
    h('div.page-head', h('div', h('h1', 'Профиль'), h('p', state.open ? 'Вход отключён — оформление и уведомления.' : me.role === 'owner' ? 'Ты владелец этого сервера.' : 'Твоя библиотека видна только тебе.'))),
    h('div.settings-grid',
      state.open ? null : h('div.setting-card', h('div.profile-top', avatarWrap, h('div.grow', { style: { minWidth: '220px' } }, sheetField('Имя', h('div.row', { style: { flexWrap: 'nowrap' } }, h('div.grow', name), nameBtn))))),
      state.open ? null : h('div.setting-card', h('h3', ic('lock'), 'Пароль'), me.mustChange ? h('div.banner', ic('info'), h('span', 'Сейчас у тебя пароль по умолчанию. Лучше сменить его.')) : null, h('div.grid3', sheetField('Текущий', op), sheetField('Новый (от 8 знаков)', np), sheetField('Повтори новый', np2)), h('div', pwBtn)),
      h('div.setting-card', h('h3', ic('sun'), 'Оформление'), theme),
      h('div.setting-card', h('h3', ic('bell'), 'Уведомления'), h('label.check', h('span', 'Сообщать, когда загрузка готова', h('small', 'Всплывающее уведомление браузера, пока сайт открыт')), notif)),
      h('div.setting-card', h('h3', ic('disk'), 'Место'), usage),
      h('div.setting-card', h('h3', ic('user'), state.open ? 'Приложение' : 'Сеанс'),
        h('div.row', installEvent ? h('button.btn', { type: 'button', onclick: async () => { installEvent.prompt(); installEvent = null; } }, ic('download'), 'Установить как приложение') : null,
          state.open ? null : h('button.btn', { type: 'button', onclick: async () => { await post('/api/logout'); location.hash = '#/'; location.reload(); } }, ic('logout'), 'Выйти'),
          state.open ? null : h('button.btn.danger', { type: 'button', onclick: async () => { if (await confirmSheet({ title: 'Выйти везде?', text: 'Все устройства, где ты вошёл, потеряют доступ. Придётся войти заново.', ok: 'Выйти везде', danger: true })) { await post('/api/logout-all'); location.reload(); } } }, ic('stop'), 'Выйти на всех устройствах')),
        !state.secure ? h('p.muted.small', 'Подсказка: чтобы ставить сайт как приложение и пользоваться «Поделиться», запусти сервер командой «npm run https».') : null),
      state.isOwner() ? h('div.row', state.open ? null : h('a.btn', { href: '#/friends' }, ic('users'), 'Друзья и приглашения'), h('a.btn', { href: '#/settings' }, ic('settings'), 'Настройки сервера')) : null),
  );
  return () => {};
}

async function squareCrop(file) {
  const bmp = await createImageBitmap(file);
  const s = Math.min(bmp.width, bmp.height, 512);
  const c = document.createElement('canvas'); c.width = c.height = s;
  const side = Math.min(bmp.width, bmp.height);
  c.getContext('2d').drawImage(bmp, (bmp.width - side) / 2, (bmp.height - side) / 2, side, side, 0, 0, s, s);
  return new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('Не удалось обработать картинку'))), 'image/jpeg', 0.9));
}

// ───────────── друзья ─────────────
export function mountFriends(root) {
  const invBox = h('div.list'), usersBox = h('div.list');
  const newInv = h('button.btn.primary', { type: 'button', onclick: async () => { setBusy(newInv, true); try { const r = await post('/api/invites'); const link = `${location.origin}/#/invite/${r.code}`; await copyText(link); showInvite(link); await loadInv(); } catch (e) { toast(errorFriendly(e), { icon: 'warning' }); } setBusy(newInv, false); } }, ic('userplus'), 'Создать приглашение');
  root.append(
    h('div.page-head', h('div', h('h1', 'Друзья'), h('p', 'Регистрация только по приглашению: ссылка одноразовая и живёт 7 дней.')), newInv),
    h('section', h('div.section-head', h('h2', 'Приглашения')), invBox),
    h('section.section', h('div.section-head', h('h2', 'Пользователи')), usersBox),
  );
  function showInvite(link) {
    const s = sheet({ title: 'Приглашение создано', narrow: true, body: h('div.stack', h('p.muted.small', 'Ссылка уже в буфере. Отправь её другу — по ней он выберет имя и пароль. Работает один раз, 7 дней.'), h('input.input', { value: link, readonly: '', onfocus: (e) => e.target.select() })), foot: [h('button.btn', { type: 'button', onclick: () => copyText(link).then(() => toast('Скопировано', { icon: 'copy' })) }, ic('copy'), 'Копировать'), h('button.btn.primary', { type: 'button', onclick: () => s.close() }, 'Готово')] });
  }
  async function loadInv() {
    const { invites } = await get('/api/invites');
    invBox.replaceChildren(...(invites.length ? invites.map((i) => {
      const expired = i.expiresAt < Date.now() && !i.usedBy;
      return h('div.li', ic(i.usedBy ? 'check' : 'link'), h('div.grow', h('b', i.usedBy ? `Использовано: ${i.usedBy}` : expired ? 'Истекло' : 'Ждёт друга'), h('small.muted', i.usedBy ? fmtDate(i.usedAt) : `создано ${fmtRel(i.createdAt)} · до ${new Date(i.expiresAt).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' })}`)),
        !i.usedBy && !expired ? h('button.btn.sm', { type: 'button', onclick: async () => { await copyText(`${location.origin}/#/invite/${i.code}`); toast('Ссылка скопирована', { icon: 'copy' }); } }, ic('copy'), 'Ссылка') : null,
        !i.usedBy ? h('button.btn.sm.danger', { type: 'button', onclick: async () => { await del(`/api/invites/${i.code}`); loadInv(); } }, 'Отозвать') : null);
    }) : [h('p.muted.small', 'Приглашений пока нет.')]));
  }
  async function loadUsers() {
    const { users } = await get('/api/users');
    usersBox.replaceChildren(...users.map((u) => {
      const online = state.online.has(u.id);
      const lim = [u.quotaGB != null ? `${u.quotaGB} ГБ` : null, u.quotaDay != null ? `${u.quotaDay}/сутки` : null].filter(Boolean).join(' · ');
      return h('div.li', avatarEl({ ...u, avatarV: 0 }), h('div.grow', h('b', h('span', u.username), ' ', h('span', { class: `dot${online ? ' on' : ''}`, title: online ? 'в сети' : 'не в сети', style: { marginLeft: '6px' } })), h('small.muted', `${u.role === 'owner' ? 'владелец · ' : ''}${online ? 'в сети' : u.lastSeen ? 'был ' + fmtRel(u.lastSeen) : 'ещё не заходил'} · ${fmtBytes(u.used)} · ${u.jobs} ${plural(u.jobs, 'файл', 'файла', 'файлов')}${lim ? ' · лимит ' + lim : ''}`)),
        u.role !== 'owner' ? h('button.btn.sm', { type: 'button', onclick: () => limitsSheet(u) }, ic('settings'), 'Лимиты') : null,
        u.role !== 'owner' ? h('button.btn.sm.danger.icon', { type: 'button', 'aria-label': 'Удалить', onclick: async () => { if (await confirmSheet({ title: `Удалить «${u.username}»?`, text: 'Аккаунт и все его файлы будут удалены без возможности восстановления.', ok: 'Удалить', danger: true })) { await del(`/api/users/${u.id}`); toast('Пользователь удалён'); loadUsers(); } } }, ic('trash')) : null);
    }));
  }
  function limitsSheet(u) {
    const gb = h('input.input', { type: 'number', min: 0, step: 'any', value: u.quotaGB ?? '', placeholder: 'по умолчанию' }), day = h('input.input', { type: 'number', min: 0, step: 1, value: u.quotaDay ?? '', placeholder: 'по умолчанию' });
    const s = sheet({ title: `Лимиты: ${u.username}`, narrow: true, body: h('div.stack-sm', sheetField('Место на диске, ГБ', gb, '0 — без ограничений. Пусто — как в общих настройках.'), sheetField('Загрузок в сутки', day, '0 — без ограничений.')), foot: [h('button.btn.ghost', { type: 'button', onclick: () => s.close() }, 'Отмена'), h('button.btn.primary', { type: 'button', onclick: async () => { try { await patch(`/api/users/${u.id}`, { quotaGB: gb.value, quotaDay: day.value }); s.close(); toast('Сохранено'); loadUsers(); } catch (e) { toast(errorFriendly(e), { icon: 'warning' }); } } }, 'Сохранить')] });
  }
  loadInv(); loadUsers();
  const un = state.on('presence', loadUsers);
  return un;
}

// ───────────── настройки ─────────────
export function mountSettings(root) {
  const host = h('div.settings-grid');
  root.append(h('div.page-head', h('div', h('h1', 'Настройки'), h('p', 'Всё, что касается сервера. Видно только владельцу.'))), host);
  let S = null, data = null;

  async function load() {
    data = await get('/api/settings'); S = data.settings;
    draw();
  }
  async function save(partial, ok = 'Сохранено') {
    try { const r = await put('/api/settings', partial); S = r.settings; toast(ok); return true; } catch (e) { toast(errorFriendly(e), { icon: 'warning' }); return false; }
  }
  const num = (key, label, hint, step = 1) => { const i = h('input.input', { type: 'number', min: 0, step, value: S[key] }); i.addEventListener('change', () => save({ [key]: i.value })); return sheetField(label, i, hint); };
  const txt = (key, label, hint, ph = '') => { const i = h('input.input', { value: S[key] || '', placeholder: ph }); i.addEventListener('change', () => save({ [key]: i.value })); return sheetField(label, i, hint); };

  function draw() {
    const t = data.tools;
    const upd = h('button.btn', { type: 'button', onclick: async () => { setBusy(upd, true); try { const r = await post('/api/tools/update'); toast(r.ok ? (r.changed ? `Обновлено: ${r.before} → ${r.version}` : `Уже последняя версия: ${r.version}`) : `Не получилось: ${r.message}`, { icon: r.ok ? 'check' : 'warning', ms: 6000 }); await load(); } catch (e) { toast(errorFriendly(e), { icon: 'warning' }); } setBusy(upd, false); } }, ic('refresh'), 'Обновить сейчас');
    const ck = data.cookies;
    const ckInput = h('input', { type: 'file', accept: '.txt,text/plain', style: { display: 'none' }, onchange: async (e) => { const f = e.target.files[0]; if (!f) return; try { const text = await f.text(); await api('POST', '/api/settings/cookies', text, { type: 'text/plain' }); toast('cookies.txt загружен'); load(); } catch (er) { toast(errorFriendly(er), { icon: 'warning' }); } } });
    const free = data.free;
    host.replaceChildren(
      h('div.setting-card', h('h3', ic('download'), 'yt-dlp и инструменты'),
        h('div', h('div.kv', h('span', 'yt-dlp'), h('b', t.ytdlp.ok ? t.ytdlp.version : 'не установлен')), h('div.kv', h('span', 'ffmpeg'), h('b', t.ffmpeg.ok ? t.ffmpeg.version : 'не установлен')), h('div.kv', h('span', 'ffprobe'), h('b', t.ffprobe.ok ? t.ffprobe.version : 'не установлен')), h('div.kv', h('span', 'gallery-dl'), h('b', t.gallerydl.ok ? t.gallerydl.version : 'нет (необязательно)')), h('div.kv', h('span', 'gifski'), h('b', t.gifski.ok ? t.gifski.version : 'нет (необязательно)')), h('div.kv', h('span', 'Node.js'), h('b', t.node))),
        h('div.row', upd, h('label.row', { style: { gap: '10px' } }, sw(S.autoUpdate, (v) => save({ autoUpdate: v })), h('span.small', 'Проверять обновления раз в сутки'))),
        S.lastUpdateCheck ? h('p.muted.small', `Последняя проверка: ${fmtDate(S.lastUpdateCheck)}`) : null,
        !t.ytdlp.ok || !t.ffmpeg.ok ? h('p.small', 'Не хватает инструментов — выполни в папке проекта «npm run tools» и перезапусти сервер.') : null),
      h('div.setting-card', h('h3', ic('key'), 'Cookies (для входа на сайтах)'),
        h('p.muted.small', 'Нужны для Instagram, закрытых видео, возрастных ограничений и случаев «подтвердите, что вы не бот». Файл хранится только на сервере, друзьям не виден.'),
        h('div.kv', h('span', 'Статус'), h('b', ck.exists ? `загружен · ${ck.lines} строк · ${fmtRel(ck.mtime)}` : 'не загружен')),
        h('div.row', ckInput, h('button.btn', { type: 'button', onclick: () => ckInput.click() }, ic('upload'), ck.exists ? 'Заменить cookies.txt' : 'Загрузить cookies.txt'), ck.exists ? h('button.btn.danger', { type: 'button', onclick: async () => { await del('/api/settings/cookies'); toast('cookies.txt удалён'); load(); } }, ic('trash'), 'Удалить') : null),
        h('details.more', h('summary', ic('info'), 'Как выгрузить cookies.txt', ic('down')), h('div', h('ol.steps', h('li', 'Поставь в браузер расширение «Get cookies.txt LOCALLY» (Chrome, Edge, Firefox).'), h('li', 'Открой нужный сайт (например, youtube.com или instagram.com) и войди в аккаунт.'), h('li', 'Нажми на значок расширения → Export, сохрани файл cookies.txt.'), h('li', 'Загрузи этот файл сюда.')), h('p.muted.small', 'Cookies — это ключ от аккаунта. Лучше используй отдельный аккаунт, а не основной.'))),
        txt('cookiesBrowser', 'Или брать cookies прямо из браузера на этом компьютере', 'Например: chrome, firefox, edge. Работает, если cookies.txt не загружен.', 'chrome')),
      h('div.setting-card', h('h3', ic('queue'), 'Очередь и лимиты'), h('div.grid2', num('maxConcurrent', 'Одновременных загрузок', 'От 1 до 10. По умолчанию 3.'), num('maxTotalGB', 'Общий лимит, ГБ', '0 — без ограничений'), num('perUserGB', 'Лимит места на друга, ГБ', '0 — без ограничений. Для каждого можно задать свой.', 'any'), num('perUserPerDay', 'Загрузок в сутки на друга', '0 — без ограничений'), num('cleanupDays', 'Автоудаление старше, дней', '0 — не удалять'), num('shareHours', 'Ссылки «поделиться» живут, часов', 'По умолчанию для новых ссылок'))),
      h('div.setting-card', h('h3', ic('tag'), 'Файлы и качество'),
        h('div.grid2', txt('nameTemplate', 'Шаблон имени файла', 'Можно: {title} {uploader} {album} {id} {site} {date} {quality}', '{title}'),
          sheetField('Качество по умолчанию', (() => { const s = h('select.select', h('option', { value: 'best' }, 'Лучшее'), ...[2160, 1440, 1080, 720, 480, 360].map((n) => h('option', { value: String(n) }, `${n}p`))); s.value = S.defaultQuality; s.addEventListener('change', () => save({ defaultQuality: s.value })); return s; })()),
          sheetField('Контейнер видео', (() => { const s = h('select.select', ...['mp4', 'mkv', 'webm'].map((n) => h('option', { value: n }, n.toUpperCase()))); s.value = S.defaultContainer; s.addEventListener('change', () => save({ defaultContainer: s.value })); return s; })()),
          sheetField('Формат аудио', (() => { const s = h('select.select', ...[['best', 'Исходный'], ['mp3', 'MP3'], ['m4a', 'M4A'], ['opus', 'OPUS'], ['flac', 'FLAC']].map(([v, l]) => h('option', { value: v }, l))); s.value = S.defaultAudio; s.addEventListener('change', () => save({ defaultAudio: s.value })); return s; })())),
        txt('storageDir', 'Папка хранения', `Сейчас: ${data.root}. Пусто — стандартная. Новая папка действует для новых файлов; свободно сейчас ${fmtBytes(free)}.`, 'D:\\Zatsep')),
      h('div.setting-card', h('h3', ic('globe'), 'Сеть'), txt('proxy', 'Прокси', 'http://host:port или socks5://host:port. Пусто — без прокси. Помогает при ограничениях по стране.', 'socks5://127.0.0.1:1080')),
    );
  }
  load();
  return () => {};
}
void menu; void fmtDate;
