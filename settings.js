'use strict';
/** Settings store with privacy-by-default values. */
const { SecureStore } = require('./secure-store');

const DEFAULTS = {
  assistantName: 'Jarvis',
  language: 'en-US',
  timezone: process.env.TZ || 'Asia/Kolkata', // hub-local clock (IST for you)
  homeCity: '',                       // default city for weather/traffic
  personality: { tone: 0.5 },         // global default; per-user override in memory
  privacy: {
    stt: 'device',    // device | cloud
    tts: 'device',    // device | cloud
    llm: 'cloud',     // cloud | local  (defaults can be flipped — UI also offers it)
    vision: 'off',    // off | local | cloud
    camera: false,    // explicit opt-in
    mic: true,
    location: false,
    transcriptLogging: false,         // raw transcripts are never persisted unless true
    learning: true,                   // local-only adaptive learning (PERSONALIZATION.md); signals are metadata, never raw text
    localRouting: true,                 // sensitive topics + cloud outages route to the local model (announced plainly; cloud use for a sensitive topic always asks first)
    logRetentionDays: 30,             // event-log age cap — the hub forgets on schedule
    sensorTtlHours: 24,               // stale satellite sensor readings are dropped after this
  },
  proactive: { enabled: true, categories: { commute: true, weather: true, routines: true }, openers: true }, // openers: session-start 'where to start' suggestions (grounded only)
  guestMode: false,
  homeAssistant: { url: process.env.HA_URL || '', token: process.env.HA_TOKEN || '' },
  translateUrl: process.env.LIBRETRANSLATE_URL || 'https://libretranslate.com',
  newsFeed: process.env.NEWS_FEED || 'https://feeds.bbci.co.uk/news/rss.xml',
  emergencyContacts: [],              // [{name, phone, channel:'sms'|'call'}]
  emergencyWebhook: process.env.EMERGENCY_WEBHOOK || '',
  mediaHook: process.env.SPOTIFY_HOOK || '',
  vehicle: { provider: 'demo', token: process.env.TESLA_TOKEN || process.env.SMARTCAR_TOKEN || '' },
  cameras: [],                        // [{name, url}] dashboard thumbnails (local snapshots)
  /* v0.9.0 — service credentials (NOT LLM keys; LLM keys live only in openrouter.keys).
     Token-shaped fields here are masked in GET /api/settings by the SECRETY redactor. */
  integrations: {
    discordToken: process.env.DISCORD_BOT_TOKEN || '', // Discord bot credential (service, not LLM)
    ghToken: process.env.GH_TOKEN || '',               // GitHub fine-grained PAT (service credential, not LLM; scopes in docs/GITHUB.md)
    discordChannel: '',                                // channel id the bridge reads/notifies
    flightsKey: process.env.AVIATIONSTACK_KEY || '',   // optional free-tier key for flight status
  },
  features: {
    startupBriefing: false, // opt-in: daily briefing offered on first connect of the day
    screenRead: false,      // off by default — one-shot screen share on the Vision page
    gestureControl: false,  // off by default — NEVER auto-starts (regression-tested)
    remotePass: '',         // household PIN for the Jarvis Remote page (real auth remains MAX_TOKEN)
  },
  skills: {},                         // { skillName: false } => disabled
  update: { allow: process.env.ALLOW_SELF_UPDATE === '1', channel: 'stable' },
  openrouter: { keys: [], model: '' },  // UI-managed keys take precedence over .env
  security: {
    url: process.env.OLLAMA_URL || 'http://127.0.0.1:11434',
    model: process.env.OLLAMA_MODEL || 'hf.co/huihui-ai/Huihui-Qwythos-9B-Claude-Mythos-5-1M-abliterated-GGUF:Q4_K_M',
  },                                      // local uncensored brain for hacking mode
};

function maskStr(v) { return typeof v === 'string' && v ? '••••••' + v.slice(-4) : v; }

const SECRETY = /token|key|secret|webhook|pass/i;

function redact(obj) {
  if (obj === null || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(redact);
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (SECRETY.test(k)) {
      if (typeof v === 'string' && v) { out[k] = maskStr(v); continue; }
      if (Array.isArray(v)) { out[k] = v.map((x) => (typeof x === 'string' ? maskStr(x) : '[redacted]')); continue; }
    }
    out[k] = redact(v);
  }
  return out;
}

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const maskedStr = (v) => typeof v === 'string' && v.startsWith('••••');
const maskedArr = (v) => Array.isArray(v) && v.length && v.every((x) => maskedStr(x));

function deepMerge(base, patch, _depth = 0) {
  if (_depth > 32) return base; // nested-depth DoS guard
  for (const [k, v] of Object.entries(patch || {})) {
    if (FORBIDDEN_KEYS.has(k)) continue; // prototype pollution guard
    if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])) {
      deepMerge(base[k], v, _depth + 1);
    } else if (maskedStr(v)) {
      continue; // never overwrite secrets with masked readbacks
    } else if (maskedArr(v) && Array.isArray(base[k]) && base[k].length) {
      continue; // never CLOBBER a real secret list with its masked rendering
    } else {
      base[k] = v;
    }
  }
  return base;
}

/** Top-level patch guard: only known settings keys may be patched. Returns ignored key list. */
function validatePatch(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { ok: false, ignored: Object.keys(obj || {}) };
  const ignored = Object.keys(obj).filter((k) => !(k in DEFAULTS));
  return { ok: true, ignored };
}

function loadSettings() {
  const store = new SecureStore('settings');
  store.data = deepMerge(structuredClone(DEFAULTS), store.data || {});
  try { store.save(); } catch (e) { console.error('[settings] could not persist defaults — continuing in degraded mode:', e.message); }
  return {
    store,
    get data() { return store.data; },
    patch(obj) {
      const v = validatePatch(obj);
      if (!v.ok) throw new Error('patch must be an object');
      if (v.ignored.length) console.warn('[settings] ignored unknown keys:', v.ignored.join(', '));
      for (const k of v.ignored) delete obj[k];
      deepMerge(store.data, obj);
      try { store.save(); } catch (e) {
        const err = new Error('settings applied in memory but could not be saved to disk (' + (e.code || e.message) + ')');
        err.code = e.code;
        throw err; // caller surfaces a calm 500; the in-memory patch still stands
      }
      return store.data;
    },
    public() { return redact(store.data); },
  };
}

module.exports = { loadSettings, redact, deepMerge };
