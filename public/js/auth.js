// Экраны входа и регистрации по приглашению
import { h, ic, setBusy, toast } from './ui.js';
import { post, get, loadMe } from './api.js';

function shell(card) {
  document.querySelector('.auth')?.remove();
  const el = h('div.auth', card);
  document.body.append(el);
  return el;
}
const brand = () => h('div.row', { style: { gap: '14px' } }, h('span.brand-mark', ic('logo')), h('b', { style: { fontSize: '22px', letterSpacing: '-.03em' } }, 'Зацеп'));

export function showLogin(onDone, { reason } = {}) {
  const user = h('input.input', { autocomplete: 'username', autocapitalize: 'off', 'aria-label': 'Имя', placeholder: 'Имя' });
  const pass = h('input.input', { type: 'password', autocomplete: 'current-password', 'aria-label': 'Пароль', placeholder: 'Пароль' });
  const err = h('div.err-text', { hidden: true, role: 'alert' });
  const btn = h('button.btn.primary.lg', { type: 'submit' }, 'Войти');
  const card = h('form.auth-card', { onsubmit: async (e) => {
    e.preventDefault(); err.hidden = true; setBusy(btn, true);
    try { await post('/api/login', { username: user.value, password: pass.value }, { quiet401: true }); await loadMe(); el.remove(); onDone(); }
    catch (er) { err.textContent = er.message; err.hidden = false; card.classList.remove('shake'); void card.offsetWidth; card.classList.add('shake'); pass.select(); }
    setBusy(btn, false);
  } }, brand(), h('div', h('h1', 'Вход'), h('p.muted', { style: { marginTop: '6px' } }, reason || 'Личный загрузчик видео и музыки. Регистрация — по приглашению владельца.')), h('div.stack-sm', user, pass), err, btn);
  const el = shell(card);
  setTimeout(() => user.focus(), 100);
}

export async function showInvite(code, onDone) {
  let valid = false;
  try { valid = (await get(`/api/invite/${encodeURIComponent(code)}`)).valid; } catch { /* оффлайн */ }
  if (!valid) {
    const el = shell(h('div.auth-card', brand(), h('div', h('h1', 'Приглашение не работает'), h('p.muted', { style: { marginTop: '6px' } }, 'Оно уже использовано или истекло. Попроси владельца создать новое.')), h('a.btn.primary.lg', { href: '#/', onclick: () => { el.remove(); location.hash = '#/'; location.reload(); } }, 'На вход')));
    return;
  }
  const user = h('input.input', { autocomplete: 'username', maxlength: 32, 'aria-label': 'Имя', placeholder: 'Как тебя зовут' });
  const pass = h('input.input', { type: 'password', autocomplete: 'new-password', 'aria-label': 'Пароль', placeholder: 'Пароль (от 8 знаков)' });
  const pass2 = h('input.input', { type: 'password', autocomplete: 'new-password', 'aria-label': 'Повтор пароля', placeholder: 'Повтори пароль' });
  const err = h('div.err-text', { hidden: true, role: 'alert' });
  const btn = h('button.btn.primary.lg', { type: 'submit' }, 'Создать аккаунт');
  const card = h('form.auth-card', { onsubmit: async (e) => {
    e.preventDefault(); err.hidden = true;
    if (pass.value !== pass2.value) { err.textContent = 'Пароли не совпадают'; err.hidden = false; return; }
    setBusy(btn, true);
    try { await post('/api/register', { code, username: user.value, password: pass.value }, { quiet401: true }); await loadMe(); el.remove(); history.replaceState(null, '', '#/'); onDone(); toast('Добро пожаловать!'); }
    catch (er) { err.textContent = er.message; err.hidden = false; card.classList.remove('shake'); void card.offsetWidth; card.classList.add('shake'); }
    setBusy(btn, false);
  } }, brand(), h('div', h('h1', 'Тебя пригласили'), h('p.muted', { style: { marginTop: '6px' } }, 'Придумай имя и пароль — и можно качать.')), h('div.stack-sm', user, pass, pass2), err, btn);
  const el = shell(card);
  setTimeout(() => user.focus(), 100);
}
