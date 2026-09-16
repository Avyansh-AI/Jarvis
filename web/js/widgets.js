/* Jarvis HUD widget layer (shared). Mounts compact glass panels around the
   ring on the main page; the same panel style renders inside Jarvis Remote.
   Pure additive client layer — every read goes through existing public APIs
   (weather / home devices / activity / health); nothing new is exposed, no
   hub logic changes. Widgets degrade to a quiet "hub offline" note and
   recover on the next tick.

   Usage: <div class="hud-widget tl" data-widget="weather"></div>
          MAX.widgets.mountAll();   // scans [data-widget]
*/
window.MAX = window.MAX || {};
MAX.widgets = (() => {
  'use strict';
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const relTime = (ts) => {
    const d = Math.max(0, Date.now() - ts);
    return d < 60e3 ? 'now' : d < 3600e3 ? Math.round(d / 60e3) + 'm' : d < 86400e3 ? Math.round(d / 3600e3) + 'h' : new Date(ts).toLocaleDateString();
  };
  const offline = (el, note) => { el.innerHTML = `<div class="hud-empty">${note || 'hub offline — retrying…'}</div>`; };

  /* ---- date & time (fully local — no hub needed) ---- */
  function clock(el) {
    const paint = () => {
      const n = new Date();
      el.innerHTML =
        `<div class="hud-clock">${esc(n.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }))}</div>` +
        `<div class="hud-sub">${esc(n.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' }))}</div>`;
    };
    paint();
    return setInterval(paint, 1000);
  }

  /* ---- weather (current conditions + short outlook) ---- */
  function weather(el) {
    const load = () => MAX.get('/api/weather').then((w) => {
      el.innerHTML =
        `<div class="hud-big">${esc(w.tempC)}<span class="unit">°C</span></div>` +
        `<div class="hud-sub">${esc(w.desc)} · feels ${esc(w.feelsC)}° · H ${esc(w.highC)}° / L ${esc(w.lowC)}°</div>` +
        `<div class="hud-sub">rain ${esc(w.rainPct)}% · wind ${esc(w.windKph)} km/h · ${esc(w.city)}</div>`;
    }).catch(() => offline(el));
    load();
    return setInterval(load, 120000);
  }

  /* ---- quick devices: at-a-glance on/off, tap-to-toggle -------------------
     Taps route through the FULL voice pipeline (/api/utterance), so
     voice-gated devices (locks/garage) stay gated — same trust path as the
     Home card in Jarvis Remote. ---- */
  function devices(el) {
    async function load() {
      try {
        const h = await MAX.get('/api/home/devices');
        if (!h.configured) { offline(el, 'no smart home configured — Settings → Smart home'); return; }
        if (h.error) { offline(el, 'HA: ' + esc(h.error)); return; }
        if (!h.devices.length) { offline(el, 'no lights/fans/plugs found'); return; }
        el.innerHTML = '<ul>' + h.devices.slice(0, 6).map((d) =>
          `<li><span class="hud-label">${esc(d.name)}</span>` +
          `<button class="hud-dotbtn ${d.state === 'on' ? 'on' : ''}" data-id="${esc(d.id)}" data-on="${d.state === 'on' ? 1 : 0}">${esc(d.state)}</button></li>`
        ).join('') + '</ul>';
        el.querySelectorAll('button').forEach((b) => {
          b.onclick = async () => {
            b.disabled = true;
            try {
              const name = b.closest('li').querySelector('.hud-label').textContent;
              const r = await MAX.post('/api/utterance', { user: MAX.user(), text: (b.dataset.on === '1' ? 'turn off ' : 'turn on ') + name });
              if (r && r.verify) {
                const row = b.closest('li').querySelector('.hud-label');
                row.innerHTML = `${esc(name)} <span class="hud-flag">voice-gated</span>`;
              }
              setTimeout(load, 1200);
            } catch { } finally { b.disabled = false; }
          };
        });
      } catch { offline(el); }
    }
    load();
    return setInterval(load, 60000);
  }

  /* ---- notification / activity feed ----------------------------------------
     Reuses the Jarvis Remote activity feed data (/api/activity — sanitized,
     transcript-free). Entries that usually mean "needs the owner" (attention
     flags, security events, integration failures) get a NEEDS YOU chip.
     NOTE: parked voice confirmations live in hub RAM only by design
     (BUG_BACKLOG L-02) — they surface here once resolved, not while parked. */
  const ACT_ICON = { interaction: '💬', 'schedule.fired': '⏰', notify: '🔔', attention: '❗', 'security.lockdown': '🔒', 'security.denied': '🚫', 'satellite.swap': '🛰', 'llm.key.fail': '🔑', 'sos.triggered': '🆘', 'injection.guard': '🛡', 'voiceprint.enrolled': '🎙', 'learn.rerank': '🧠', 'gh.write': '🐙' };
  const FLAG_TYPES = new Set(['attention', 'security.lockdown', 'security.denied', 'llm.key.fail', 'sos.triggered', 'injection.guard']);
  const actLabel = (e) => e.message || (e.skill ? (e.ok === false ? e.skill + ' slipped' : e.skill + ' handled a request') : e.type);
  function activity(el) {
    const load = () => MAX.get('/api/activity?n=8').then((r) => {
      const items = r.items || [];
      el.innerHTML = items.length ? '<ul>' + items.map((e) =>
        `<li><span aria-hidden="true">${ACT_ICON[e.type] || '·'}</span>` +
        `<span class="hud-label">${esc(actLabel(e))}</span>` +
        (FLAG_TYPES.has(e.type) ? '<span class="hud-flag">needs you</span>' : '') +
        `<span class="hud-ago">${relTime(e.ts)}</span></li>`
      ).join('') + '</ul>' : '<div class="hud-empty">quiet so far — activity appears here</div>';
    }).catch(() => offline(el));
    load();
    return setInterval(load, 12000);
  }

  const RENDERERS = { clock, weather, devices, activity };
  let timers = [];

  function mountAll(root) {
    (root || document).querySelectorAll('[data-widget]').forEach((el) => {
      const kind = el.dataset.widget;
      const fn = RENDERERS[kind];
      if (!fn || el._hudMounted) return;
      el._hudMounted = true;
      if (!el.querySelector('h4')) {
        const h = document.createElement('h4');
        h.textContent = { clock: 'Time', weather: 'Weather', devices: 'Devices', activity: 'Activity' }[kind] || kind;
        el.insertBefore(h, el.firstChild);
      }
      const body = document.createElement('div');
      el.appendChild(body);
      timers.push(fn(body));
    });
  }

  /* pause polling while the tab is hidden, resume fresh on return */
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { timers.forEach(clearInterval); timers = []; document.querySelectorAll('[data-widget]').forEach((el) => { el._hudMounted = false; }); }
    else { document.querySelectorAll('[data-widget]').forEach((el) => { el.innerHTML = ''; }); mountAll(); }
  });

  return { mountAll };
})();
