// Проверка доступа: друг не видит чужое, ссылки «поделиться» работают без входа и отзываются.
const BASE = process.env.BASE || 'http://localhost:3000';
const jar = (n) => ({ n, cookie: '' });
async function call(who, method, url, body) {
  const r = await fetch(BASE + url, { method, headers: { origin: BASE, cookie: who.cookie, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' });
  const sc = r.headers.get('set-cookie'); if (sc) who.cookie = sc.split(';')[0];
  const t = await r.text(); let d = null; try { d = JSON.parse(t); } catch { /* */ }
  return { s: r.status, d };
}
const res = [];
const check = (name, ok, extra = '') => { res.push(ok); console.log(`${ok ? '✓' : '✗'} ${name} ${extra}`); };
(async () => {
  const owner = jar('owner'), friend = jar('friend'), anon = jar('anon');
  await call(owner, 'POST', '/api/login', { username: 'Пользователь', password: process.env.TEST_PASS || '12345678' });
  const jobs = (await call(owner, 'GET', '/api/jobs')).d.jobs.filter((j) => j.status === 'done' && j.userId === 1);
  const job = jobs[0];
  const inv = (await call(owner, 'POST', '/api/invites')).d.code;
  const reg = await call(friend, 'POST', '/api/register', { code: inv, username: 'Друг' + Date.now() % 1000, password: 'friendpass1' });
  check('друг регистрируется по приглашению', reg.s === 200);
  check('повторное использование приглашения отклонено', (await call(jar('x'), 'POST', '/api/register', { code: inv, username: 'Ещё', password: 'friendpass1' })).s === 400);
  check('друг не видит чужие загрузки', (await call(friend, 'GET', '/api/jobs')).d.jobs.length === 0);
  check('файл владельца без входа → 401', (await call(anon, 'GET', `/api/files/${job.id}`)).s === 401);
  check('файл владельца под другом → 404', (await call(friend, 'GET', `/api/files/${job.id}`)).s === 404);
  check('друг не открывает настройки', (await call(friend, 'GET', '/api/settings')).s === 403);
  check('друг не создаёт приглашения', (await call(friend, 'POST', '/api/invites')).s === 403);
  check('чужой Origin отклонён', (await fetch(BASE + '/api/jobs/bulk', { method: 'POST', headers: { origin: 'http://evil.example', cookie: owner.cookie, 'content-type': 'application/json' }, body: '{}' })).status === 403);
  const sh = (await call(owner, 'POST', `/api/jobs/${job.id}/share`, { hours: 1 })).d;
  const open = await fetch(BASE + sh.path, { headers: { range: 'bytes=0-9' } });
  check('ссылка «поделиться» открывается без входа (Range)', open.status === 206);
  await call(owner, 'DELETE', `/api/shares/${sh.token}`);
  check('после отзыва ссылка не работает', (await fetch(BASE + sh.path)).status === 404);
  const bad = await Promise.all(Array.from({ length: 7 }, () => call(jar('b'), 'POST', '/api/login', { username: 'Пользователь', password: 'wrong-pass' })));
  check('перебор пароля блокируется (429)', bad.some((x) => x.s === 429));
  console.log(res.every(Boolean) ? '\nВсё ок' : '\nЕсть провалы');
})();
