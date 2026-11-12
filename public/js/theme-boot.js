// Ставит тему до отрисовки, чтобы не было мигания
try {
  var t = localStorage.getItem('theme');
  if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
} catch (e) { /* без localStorage — тема по системе */ }
