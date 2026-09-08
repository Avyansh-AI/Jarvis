'use strict';
/** Flights — two honest paths, documented in README:
 *  - "flights overhead <city>" → OpenSky live states, NO key (anonymous tier).
 *  - "flight status XY123"   → AviationStack, needs a FREE-tier signup key in
 *    Settings → integrations.flightsKey (service credential, not an LLM key). */
const { httpRetry: http } = require('../net');

async function geocode(city) {
  const res = await http(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=en`);
  if (!res.ok) throw new Error('geocoding failed');
  const d = await res.json();
  if (!d.results || !d.results.length) throw new Error(`couldn't find "${city}"`);
  return d.results[0];
}
const FLIGHT_CODE = /^[A-Z0-9]{2,3}\s?\d{1,4}[A-Z]?$/i;

async function overhead(city, online) {
  if (!online) return { say: "I'm offline — can't reach flight data." };
  try {
    const p = await geocode(city);
    const d = 0.9; // ~100 km box
    const res = await http(`https://opensky-network.org/api/states/all?lamin=${p.latitude - d}&lomin=${p.longitude - d}&lamax=${p.latitude + d}&lomax=${p.longitude + d}`);
    if (!res.ok) return { say: `OpenSky answered HTTP ${res.status} — anonymous tier may be busy; try in a minute.` };
    const data = await res.json();
    const n = (data.states || []).length;
    const sample = (data.states || []).slice(0, 5).map((s) => (s[1] || '').trim()).filter(Boolean);
    return { say: n ? `${n} aircraft over ${p.name} right now${sample.length ? ' — e.g. ' + sample.join(', ') : ''}.` : `No tracked aircraft over ${p.name} at the moment.`, data: { count: n, sample } };
  } catch (e) { return { say: 'flight lookup hiccupped: ' + e.message, error: true }; }
}

async function status(code, online, key) {
  if (!online) return { say: "I'm offline — can't reach flight data." };
  if (!FLIGHT_CODE.test(code)) return { say: 'That doesn’t look like a flight code — try something like LH 762.' };
  if (!key) return { say: 'Flight status needs a free AviationStack key (free-tier signup, not an LLM key) — add it in Settings → Integrations. Meanwhile you can ask "flights overhead <city>" — that one needs no key.' };
  try {
    const res = await http(`https://api.aviationstack.com/v1/flights?access_key=${encodeURIComponent(key)}&flight_iata=${encodeURIComponent(code.replace(/\s/g, ''))}&limit=1`);
    if (!res.ok) return { say: `the flight service answered HTTP ${res.status} — check the key in Settings.` };
    const d = await res.json();
    const f = (d.data || [])[0];
    if (!f) return { say: `No live record for ${code.toUpperCase()} right now.` };
    return { say: `${f.flight.iata}: ${f.airline.name}, ${f.departure.airport} → ${f.arrival.airport}, status ${f.flight_status}.`, data: f };
  } catch (e) { return { say: 'flight status hiccupped: ' + e.message, error: true }; }
}

module.exports = {
  name: 'flights',
  label: 'Flights',
  description: 'Live air traffic (OpenSky, no key) + flight status (free-tier key).',
  tools: [
    { name: 'flights_overhead', sideEffect: 'read', description: 'Count/sample of aircraft currently over a city (OpenSky, anonymous, no key).',
      input_schema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
      run: async ({ city }, ctx) => overhead(city, ctx.net.online) },
    { name: 'flight_status', sideEffect: 'read', description: 'Status of one flight by IATA code (needs free AviationStack key in Settings).',
      input_schema: { type: 'object', properties: { code: { type: 'string' } }, required: ['code'] },
      run: async ({ code }, ctx) => status(code, ctx.net.online, ctx.settings.integrations && ctx.settings.integrations.flightsKey) },
  ],
  intents: [
    { patterns: [/\bflights? overhead\b/i, /\b(?:planes?|aircraft) (?:over|above|near)\b/i],
      run: async (m, text, ctx) => {
        const cm = text.match(/\b(?:over|above|near)\s+([a-z][a-z\s'.-]+?)[?.!]*$/i);
        const city = cm ? cm[1].trim() : ctx.settings.homeCity;
        const out = await overhead(city, ctx.net.online);
        return { say: out.say || out.error, data: out.data };
      } },
    { patterns: [/\bflight\s+(?:status\s+)?([a-z0-9]{2,3}\s?\d{1,4}[a-z]?)\b/i],
      run: async (m, text, ctx) => {
        const out = await status(m[1], ctx.net.online, ctx.settings.integrations && ctx.settings.integrations.flightsKey);
        return { say: out.say || out.error, data: out.data };
      } },
  ],
};
