// Свой видеоплеер: перемотка с буфером, громкость, скорость, полный экран, PiP, клавиши, двойной тап, субтитры.
import { h, ic, fmtTime, menu, toast } from './ui.js';
import { state } from './api.js';
import { audio } from './audio.js';

const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } },
};
const VC = { h264: 'avc1.640028', hevc: 'hvc1.1.6.L120.90', vp9: 'vp09.00.40.08', av1: 'av01.0.08M.08', vp8: 'vp8' };
const AC = { aac: 'mp4a.40.2', mp3: 'mp3', opus: 'opus', vorbis: 'vorbis', flac: 'flac' };

function canPlayOriginal(job) {
  const v = document.createElement('video');
  const mime = job.ext === 'webm' ? 'video/webm' : job.ext === 'mkv' ? 'video/x-matroska' : 'video/mp4';
  const codecs = [VC[job.vcodec], job.acodec ? AC[job.acodec] : null].filter(Boolean).join(',');
  const r = v.canPlayType(codecs ? `${mime}; codecs="${codecs}"` : mime);
  if (job.ext === 'mkv') return r === 'probably';
  return r !== '';
}

let current = null;
export function closeVideo() { current?.close(); }

export function openVideo(job) {
  closeVideo();
  audio.pause();
  const hasPip = !!(document.pictureInPictureEnabled || document.createElement('video').webkitSetPresentationMode);
  const video = h('video', { playsinline: '', 'webkit-playsinline': '', preload: 'metadata', crossorigin: 'use-credentials' });
  const bigplay = h('button.bigplay', { type: 'button', 'aria-label': 'Смотреть' }, ic('play'));
  const flashL = h('div.flash.l'), flashR = h('div.flash.r');
  const spinner = h('div.spin', { hidden: true });
  const buf = h('i.buf'), cur = h('i.cur'), knob = h('i.knob'), tip = h('div.tip', '0:00');
  const seek = h('div.seek', { role: 'slider', tabindex: '0', 'aria-label': 'Перемотка' }, h('div.trk', buf, cur, knob), tip);
  const playBtn = h('button.ib', { type: 'button', 'aria-label': 'Играть или пауза' }, ic('play'));
  const muteBtn = h('button.ib', { type: 'button', 'aria-label': 'Звук' }, ic('volume'));
  const vol = h('input.rng', { type: 'range', min: 0, max: 1, step: 0.02, value: store.get('vol', 1), 'aria-label': 'Громкость' });
  const time = h('span.time', '0:00 / 0:00');
  const ccBtn = h('button.ib', { type: 'button', 'aria-label': 'Субтитры', hidden: !(job.meta?.subs || []).length }, ic('subtitles'));
  const spdBtn = h('button.ib.spd', { type: 'button', 'aria-label': 'Скорость' }, '1×');
  const pipBtn = h('button.ib', { type: 'button', 'aria-label': 'Картинка в картинке', hidden: !hasPip }, ic('pip'));
  const fsBtn = h('button.ib', { type: 'button', 'aria-label': 'Во весь экран' }, ic('fullscreen'));
  const closeBtn = h('button.ib', { type: 'button', 'aria-label': 'Закрыть' }, ic('close'));
  const root = h('div.vp.paused', { role: 'dialog', 'aria-label': job.title },
    video, h('div.shade'),
    h('div.vtop', closeBtn, h('div.ttl.ellip', job.title)),
    flashL, flashR, bigplay, spinner,
    h('div.vbar', seek, h('div.vrow', playBtn, h('div.vol', muteBtn, vol), time, h('div.grow'), ccBtn, spdBtn, pipBtn, fsBtn)),
  );
  document.getElementById('overlays').append(root);
  document.body.style.overflow = 'hidden';
  requestAnimationFrame(() => requestAnimationFrame(() => root.classList.add('in')));

  // ── источник ──
  let usingCompat = false;
  const orig = `/api/files/${job.id}?inline=1`;
  const compat = `/api/files/${job.id}/compat`;
  let note = null;
  const say = (t, ms = 4500) => { note?.remove(); note = h('div.note', t); root.append(note); if (ms) setTimeout(() => note?.remove(), ms); };
  let latest = job;
  function choose(j) {
    latest = j;
    const playable = canPlayOriginal(j);
    if (j.compat === 'ready' && (!playable || (j.vcodec && j.vcodec !== 'h264' && /Version\/\d+.*Safari/.test(navigator.userAgent) && !/Chrome|Chromium/.test(navigator.userAgent)))) return setSrc(compat, true);
    if (!playable && j.compat === 'pending') { say('Этот формат не играет в браузере. Готовлю совместимую версию — включится сама, а оригинал останется для скачивания.', 0); return setSrc(orig, false); }
    return setSrc(orig, false);
  }
  function setSrc(url, isCompat) {
    if (video.getAttribute('data-src') === url) return;
    const t = video.currentTime || 0, wasPlaying = !video.paused;
    video.setAttribute('data-src', url);
    video.src = url;
    usingCompat = isCompat;
    if (isCompat) say('Включена совместимая версия — она играет в любом браузере и на iPhone', 4000);
    if (t > 0) video.addEventListener('loadedmetadata', () => { video.currentTime = t; if (wasPlaying) video.play().catch(() => {}); }, { once: true });
  }
  for (const s of job.meta?.subs || []) video.append(h('track', { kind: 'subtitles', srclang: s.lang.split('-')[0], label: s.lang, src: `/api/files/${job.id}/subs/${encodeURIComponent(s.lang)}` }));
  choose(job);
  video.volume = +vol.value; video.muted = false;
  const rate = store.get('rate', 1); video.playbackRate = rate; spdBtn.textContent = `${rate}×`;
  const unsub = state.on('job', ({ job: j }) => {
    if (j.id !== job.id) return;
    if (j.compat === 'ready' && !usingCompat && (video.error || !canPlayOriginal(j))) { note?.remove(); choose(j); video.play().catch(() => {}); }
    latest = j;
  });
  const saved = store.get(`pos:${job.id}`, 0);
  if (saved > 10) video.addEventListener('loadedmetadata', () => { if (saved < video.duration - 10) video.currentTime = saved; }, { once: true });
  video.play().catch(() => { /* ждём нажатия */ });

  // ── состояние ──
  const dur = () => (Number.isFinite(video.duration) ? video.duration : 0);
  const paint = () => {
    const d = dur(), t = video.currentTime;
    const p = d ? (t / d) * 100 : 0;
    cur.style.width = p + '%'; knob.style.left = p + '%';
    time.textContent = `${fmtTime(t)} / ${fmtTime(d)}`;
    seek.setAttribute('aria-valuenow', String(Math.floor(t))); seek.setAttribute('aria-valuemax', String(Math.floor(d)));
  };
  const paintBuf = () => {
    const d = dur(); if (!d) return;
    let end = 0;
    for (let i = 0; i < video.buffered.length; i++) if (video.buffered.start(i) <= video.currentTime + 0.5) end = Math.max(end, video.buffered.end(i));
    buf.style.width = (end / d) * 100 + '%';
  };
  const paintPlay = () => { const p = video.paused; root.classList.toggle('paused', p); playBtn.replaceChildren(ic(p ? 'play' : 'pause')); bigplay.replaceChildren(ic('play')); resetIdle(); };
  const paintVol = () => { const m = video.muted || video.volume === 0; muteBtn.replaceChildren(ic(m ? 'mute' : 'volume')); vol.value = video.muted ? 0 : video.volume; vol.style.setProperty('--p', (video.muted ? 0 : video.volume) * 100 + '%'); };
  let lastSave = 0;
  video.addEventListener('timeupdate', () => { paint(); const n = Date.now(); if (n - lastSave > 5000) { lastSave = n; store.set(`pos:${job.id}`, video.currentTime); } });
  video.addEventListener('progress', paintBuf); video.addEventListener('loadedmetadata', () => { paint(); paintBuf(); });
  video.addEventListener('play', paintPlay); video.addEventListener('pause', paintPlay);
  video.addEventListener('ended', () => { store.set(`pos:${job.id}`, 0); });
  video.addEventListener('volumechange', paintVol);
  video.addEventListener('waiting', () => { spinner.hidden = false; }); video.addEventListener('playing', () => { spinner.hidden = true; }); video.addEventListener('canplay', () => { spinner.hidden = true; });
  video.addEventListener('error', () => {
    spinner.hidden = true;
    if (!usingCompat) { if (latest.compat === 'ready') { choose(latest); video.play().catch(() => {}); } else if (latest.compat === 'pending') say('Браузер не умеет играть этот кодек. Совместимая версия готовится — подожди немного.', 0); else say('Этот файл не играет в браузере. Скачай его и открой в плеере на устройстве.', 0); }
    else say('Не удалось воспроизвести. Попробуй скачать файл.', 0);
  });
  paintVol(); paint();

  const toggle = () => { if (video.paused) video.play().catch(() => {}); else video.pause(); };
  playBtn.onclick = toggle; bigplay.onclick = (e) => { e.stopPropagation(); toggle(); };
  muteBtn.onclick = () => { video.muted = !video.muted; };
  vol.oninput = () => { video.muted = false; video.volume = +vol.value; store.set('vol', +vol.value); };
  closeBtn.onclick = () => close();

  // ── перемотка ──
  let dragging = false;
  const ratioAt = (e) => { const r = seek.getBoundingClientRect(); return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)); };
  const skip = (d) => { video.currentTime = Math.max(0, Math.min(dur() || 1e9, video.currentTime + d)); };
  seek.addEventListener('pointerdown', (e) => { dragging = true; seek.classList.add('drag'); seek.setPointerCapture(e.pointerId); video.currentTime = ratioAt(e) * dur(); paint(); });
  seek.addEventListener('pointermove', (e) => { const r = ratioAt(e); tip.style.left = r * 100 + '%'; tip.textContent = fmtTime(r * dur()); if (dragging) { video.currentTime = r * dur(); paint(); } });
  seek.addEventListener('pointerup', () => { dragging = false; seek.classList.remove('drag'); });
  seek.addEventListener('keydown', (e) => { if (e.key === 'ArrowLeft') { skip(-5); e.stopPropagation(); e.preventDefault(); } if (e.key === 'ArrowRight') { skip(5); e.stopPropagation(); e.preventDefault(); } });

  // ── скорость, субтитры, PiP, полный экран ──
  spdBtn.onclick = () => menu(spdBtn, [0.5, 0.75, 1, 1.25, 1.5, 2].map((r) => ({ label: `${r}×${r === 1 ? ' — обычная' : ''}`, onClick: () => { video.playbackRate = r; spdBtn.textContent = `${r}×`; store.set('rate', r); } })));
  ccBtn.onclick = () => {
    const tracks = [...video.textTracks];
    menu(ccBtn, [{ label: 'Выключить', onClick: () => tracks.forEach((t) => { t.mode = 'disabled'; }) }, ...tracks.map((t) => ({ label: t.label || t.language, icon: 'subtitles', onClick: () => tracks.forEach((x) => { x.mode = x === t ? 'showing' : 'disabled'; }) }))]);
  };
  pipBtn.onclick = async () => {
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else if (video.requestPictureInPicture) await video.requestPictureInPicture();
      else video.webkitSetPresentationMode?.('picture-in-picture');
    } catch { toast('Картинка в картинке здесь недоступна', { icon: 'info' }); }
  };
  const isFs = () => document.fullscreenElement === root || document.webkitFullscreenElement === root;
  const toggleFs = () => {
    if (isFs()) { (document.exitFullscreen || document.webkitExitFullscreen).call(document); return; }
    const req = root.requestFullscreen || root.webkitRequestFullscreen;
    if (req) req.call(root).catch?.(() => {});
    else if (video.webkitEnterFullscreen) video.webkitEnterFullscreen(); // iPhone
  };
  fsBtn.onclick = toggleFs;
  const onFs = () => fsBtn.replaceChildren(ic(isFs() ? 'exitfs' : 'fullscreen'));
  document.addEventListener('fullscreenchange', onFs); document.addEventListener('webkitfullscreenchange', onFs);
  if (!root.requestFullscreen && !root.webkitRequestFullscreen && !video.webkitEnterFullscreen) fsBtn.hidden = true;

  // ── скрытие контролов ──
  let idleT;
  function resetIdle() { root.classList.remove('idle'); clearTimeout(idleT); if (!video.paused) idleT = setTimeout(() => { if (!document.querySelector('.vp .menu')) root.classList.add('idle'); }, 2800); }
  root.addEventListener('pointermove', resetIdle);
  root.addEventListener('pointerdown', resetIdle);

  // ── тап / двойной тап ──
  let lastTap = 0, lastSide = 0, singleT;
  const flash = (el, txt) => { el.innerHTML = `<span style="font-size:22px">${txt}</span><small>10 с</small>`; el.classList.remove('go'); void el.offsetWidth; el.classList.add('go'); };
  video.addEventListener('pointerup', (e) => {
    if (e.pointerType === 'mouse') return;
    const r = root.getBoundingClientRect(), x = e.clientX - r.left;
    const side = x < r.width / 3 ? -1 : x > (r.width * 2) / 3 ? 1 : 0;
    const t = Date.now();
    if (t - lastTap < 320 && side && side === lastSide) {
      clearTimeout(singleT); skip(side * 10); flash(side < 0 ? flashL : flashR, side < 0 ? '« −' : '+ »'); lastTap = 0; return;
    }
    lastTap = t; lastSide = side;
    clearTimeout(singleT);
    singleT = setTimeout(() => { if (root.classList.contains('idle')) { root.classList.remove('idle'); resetIdle(); } else toggle(); }, 320);
  });
  video.addEventListener('click', (e) => { if (e.detail && e.pointerType !== 'touch' && matchMedia('(pointer:fine)').matches) toggle(); });
  video.addEventListener('dblclick', () => { if (matchMedia('(pointer:fine)').matches) toggleFs(); });

  // ── клавиши ──
  const onKey = (e) => {
    if (e.target.closest?.('input[type=text],textarea')) return;
    const k = e.key.toLowerCase();
    const used = () => { e.preventDefault(); e.stopPropagation(); resetIdle(); };
    if (k === ' ' || k === 'k') { used(); toggle(); }
    else if (e.key === 'ArrowLeft') { used(); skip(-5); flash(flashL, '« −'); }
    else if (e.key === 'ArrowRight') { used(); skip(5); flash(flashR, '+ »'); }
    else if (k === 'j') { used(); skip(-10); } else if (k === 'l') { used(); skip(10); }
    else if (e.key === 'ArrowUp') { used(); video.muted = false; video.volume = Math.min(1, video.volume + 0.1); }
    else if (e.key === 'ArrowDown') { used(); video.volume = Math.max(0, video.volume - 0.1); }
    else if (k === 'f' || k === 'а') { used(); toggleFs(); }
    else if (k === 'm' || k === 'ь') { used(); video.muted = !video.muted; }
    else if (k === 'c' || k === 'с') { used(); if (!ccBtn.hidden) ccBtn.click(); }
    else if (e.key === 'Escape') { if (!isFs() && !document.querySelector('.vp .menu')) { used(); close(); } }
  };
  document.addEventListener('keydown', onKey, true);

  function close() {
    if (current !== api) return;
    current = null;
    store.set(`pos:${job.id}`, video.ended ? 0 : video.currentTime);
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('fullscreenchange', onFs); document.removeEventListener('webkitfullscreenchange', onFs);
    unsub(); clearTimeout(idleT); clearTimeout(singleT);
    if (isFs()) (document.exitFullscreen || document.webkitExitFullscreen).call(document);
    if (document.pictureInPictureElement === video) document.exitPictureInPicture().catch(() => {});
    video.pause(); video.removeAttribute('src'); video.load();
    root.classList.remove('in');
    document.body.style.overflow = '';
    setTimeout(() => root.remove(), 320);
  }
  const api = { close };
  current = api;
  resetIdle();
  return api;
}
