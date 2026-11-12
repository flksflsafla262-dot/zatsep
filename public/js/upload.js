// Загрузка своих файлов кусками по 8 МБ с докачкой после обрыва
import { h, ic, sheet, fmtBytes, toast } from './ui.js';
import { api, get, post } from './api.js';

const CHUNK = 8 * 1024 * 1024;
const keyOf = (f) => `up:${f.name}:${f.size}:${f.lastModified}`;
const ls = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
};

function putChunk(id, offset, blob, onProgress) {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open('PUT', `/api/upload/${id}?offset=${offset}`);
    x.upload.onprogress = (e) => onProgress?.(e.loaded);
    x.onload = () => { let d = {}; try { d = JSON.parse(x.responseText); } catch { /* ignore */ } if (x.status === 200) resolve(d); else reject(Object.assign(new Error(d.message || 'Ошибка загрузки'), { status: x.status, data: d })); };
    x.onerror = () => reject(Object.assign(new Error('Нет связи с сервером'), { network: true }));
    x.send(blob);
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function uploadOne(file, onProgress) {
  const key = keyOf(file);
  let id = ls.get(key), received = 0;
  if (id) { try { received = (await get(`/api/upload/${id}`)).received; } catch { id = null; ls.del(key); } }
  if (!id) { const r = await post('/api/upload', { name: file.name, size: file.size }); id = r.id; received = 0; ls.set(key, id); }
  let fails = 0;
  while (received < file.size) {
    const blob = file.slice(received, Math.min(received + CHUNK, file.size));
    try {
      const r = await putChunk(id, received, blob, (l) => onProgress?.(received + l, file.size));
      received = r.received; fails = 0;
      onProgress?.(received, file.size);
    } catch (e) {
      if (e.status === 409 && e.data?.received != null) { received = e.data.received; continue; }
      if (e.status && e.status < 500) throw e;
      if (++fails > 8) throw e;
      await sleep(Math.min(8000, 700 * 2 ** fails));
      try { received = (await get(`/api/upload/${id}`)).received; } catch { /* повторим цикл */ }
    }
  }
  const r = await post(`/api/upload/${id}/finish`);
  ls.del(key);
  return r.job;
}

export function uploadFiles(files) {
  files = [...files].filter((f) => f.size > 0);
  if (!files.length) return;
  const rows = files.map((f) => {
    const bar = h('i'), st = h('small.muted', 'ждёт очереди');
    return { f, bar, st, el: h('div.upload-row', h('div.row', { style: { justifyContent: 'space-between', flexWrap: 'nowrap' } }, h('b.ellip', f.name), h('small.muted', fmtBytes(f.size))), h('div.up-bar', bar), st) };
  });
  let busy = true;
  const s = sheet({ title: files.length > 1 ? `Загрузка файлов (${files.length})` : 'Загрузка файла', narrow: true, body: h('div.stack-sm', rows.map((r) => r.el), h('p.muted.small', 'Файл уходит кусками по 8 МБ. Если связь оборвётся — докачается с того же места.')), foot: [h('button.btn.primary', { type: 'button', onclick: () => s.close() }, 'Свернуть')] });
  (async () => {
    let ok = 0;
    for (const r of rows) {
      r.st.textContent = 'загружается…';
      try {
        await uploadOne(r.f, (a, t) => { r.bar.style.width = (a / t) * 100 + '%'; r.st.textContent = `${Math.floor((a / t) * 100)}%`; });
        r.bar.style.width = '100%'; r.st.textContent = 'готово — файл в «Загрузках»'; ok++;
      } catch (e) { r.st.textContent = 'не получилось: ' + (e.message || 'ошибка'); }
    }
    busy = false;
    if (ok) toast(ok > 1 ? `Загружено файлов: ${ok}` : 'Файл загружен', { icon: 'upload' });
    void busy;
  })();
  return s;
}

export function pickFiles() {
  const inp = h('input', { type: 'file', multiple: '', accept: 'video/*,audio/*,image/*,.mkv,.flac,.opus,.m4a,.webm', style: { display: 'none' } });
  inp.onchange = () => { uploadFiles(inp.files); inp.remove(); };
  document.body.append(inp); inp.click();
}
void api; void ic;
