/* Jarvis — shared client helpers (all pages). */
window.Jarvis = (() => {
  const LS = {
    get: (k, d = null) => { try { const v = JSON.parse(localStorage.getItem('max.' + k)); return v ?? d; } catch { return d; } },
    set: (k, v) => localStorage.setItem('max.' + k, JSON.stringify(v)),
  };

  const user = () => LS.get('user', 'default');
  const token = () => LS.get('token', '');

  function qs(path) {
    const p = [];
    if (token()) p.push('token=' + encodeURIComponent(token()));
    return p.length ? (path.includes('?') ? '&' : '?') + p.join('&') : '';
  }

  async function api(path, method = 'GET', body) {
    const res = await fetch(path + qs(path), {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'HTTP ' + res.status);
    return data;
  }
  const get = (path) => api(path);
  const post = (path, body = {}) => api(path, 'POST', body);

  function wsUrl(path) {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    return `${proto}://${location.host}${path}?user=${encodeURIComponent(user())}${token() ? '&token=' + encodeURIComponent(token()) : ''}`;
  }

  function applyPrefs() {
    const html = document.documentElement;
    if (LS.get('highContrast', false)) html.dataset.contrast = 'high';
    if (LS.get('reducedMotion', false)) html.dataset.motion = 'reduced';
  }

  /* ---- TTS (device voices; "Jarvis" default picked in Settings) ---- */
  let voices = [];
  function loadVoices() { voices = ('speechSynthesis' in window && window.speechSynthesis) ? window.speechSynthesis.getVoices() : []; }
  if ('speechSynthesis' in window) { loadVoices(); speechSynthesis.onvoiceschanged = loadVoices; }

  function speak(text, { onstart, onend, pacing } = {}) {
    if (!('speechSynthesis' in window) || LS.get('textOnly', false)) { onstart && onstart(); onend && onend(); return; }
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    const wanted = LS.get('voice', '');
    const v = voices.find((x) => x.name === wanted) ||
      voices.find((x) => /en[-_]/i.test(x.lang) && /female|zira|samantha/i.test(x.name)) ||
      voices.find((x) => /en[-_]/i.test(x.lang)) || voices[0];
    if (v) u.voice = v;
    const base = LS.get('rate', 1);
    u.rate = pacing === 'calm' ? Math.max(0.7, base - 0.2) : base;
    u.pitch = LS.get('pitch', 1);
    u.onstart = () => onstart && onstart();
    u.onend = () => onend && onend();
    u.onerror = () => onend && onend();
    speechSynthesis.speak(u);
  }
  function stopSpeaking() { if ('speechSynthesis' in window) speechSynthesis.cancel(); }

  async function notify(title, body) {
    if (LS.get('notifications', false) && 'Notification' in window) {
      if (Notification.permission === 'granted') new Notification(title, { body });
      else if (Notification.permission !== 'denied') await Notification.requestPermission();
    }
  }

  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  /* ---- drop-in brand assets: assets/logo.* and assets/background.* are used
     automatically when present on the hub; defaults remain when absent. ---- */
  function applyCustomAssets() {
    const wordmark = document.querySelector('.wordmark');
    if (wordmark) {
      const img = new Image();
      img.onload = () => {
        img.alt = 'Jarvis';
        img.style.cssText = 'height:30px;width:auto;display:block';
        wordmark.textContent = '';
        wordmark.appendChild(img);
      };
      img.src = '/assets/logo.png?ts=' + Date.now();
    }
    const bg = new Image();
    bg.onload = () => {
      const st = document.createElement('style');
      st.textContent = 'body::before{content:"";position:fixed;inset:0;z-index:0;background:url(/assets/background.png) center/cover fixed no-repeat;opacity:.35;pointer-events:none}';
      document.head.appendChild(st);
    };
    bg.src = '/assets/background.png?ts=' + Date.now();
  }

  applyPrefs();
  applyCustomAssets();

  return { LS, user, token, api, get, post, wsUrl, speak, stopSpeaking, notify, applyPrefs, get voices() { loadVoices(); return voices; } };
})();
