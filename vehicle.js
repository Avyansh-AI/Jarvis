'use strict';
/**
 * Vehicle — lock/unlock, climate pre-conditioning, charge status, location.
 * Providers: 'demo' (built-in simulated car), 'tesla' / 'smartcar' via token.
 * ALL remote actions are sensitive: voice verification required.
 */
const { storeFor } = require('../skill-data');

function demoCar() {
  const st = storeFor('vehicle');
  st.data.demo = st.data.demo || { locked: true, climateOn: false, tempC: 21, chargePct: 68, pluggedIn: true, location: 'Home' };
  return st;
}

async function callProvider(ctx, action, args) {
  const v = ctx.settings.vehicle || { provider: 'demo' };
  if (v.provider === 'demo' || !v.token) {
    const car = demoCar().data.demo;
    switch (action) {
      case 'lock': car.locked = true; break;
      case 'unlock': car.locked = false; break;
      case 'climate_on': car.climateOn = true; break;
      case 'climate_off': car.climateOn = false; break;
      case 'status': break;
    }
    demoCar().save();
    return { mode: 'demo', car };
  }
  // Real providers: proxy through their documented HTTPS APIs.
  // Tesla Fleet API / SmartCar both use bearer tokens; endpooints differ — keep generic:
  const base = v.provider === 'tesla' ? 'https://fleet-api.prd.na.vn.cloud.tesla.com/api/1/vehicles' : 'https://api.smartcar.com/v2.0/vehicles';
  throw new Error(`Real provider "${v.provider}" needs its vehicle id wired in hub/skills/vehicle.js (base ${base} is ready, token set). Demo mode still works.`);
}

function describe(car) {
  return `${car.locked ? 'locked' : 'unlocked'}, climate ${car.climateOn ? 'running at ' + car.tempC + '°C' : 'off'}, charge ${car.chargePct}%${car.pluggedIn ? ' (plugged in)' : ''}, at ${car.location}.`;
}

module.exports = {
  name: 'vehicle',
  label: 'Vehicle',
  description: 'Car lock/climate/charge/location via demo provider, Tesla Fleet or SmartCar. Voice-verify gated.',
  personalData: true,
  sensitive: true,
  kidBlocked: true,
  intents: [
    {
      patterns: [/\b(lock|unlock)\s+(?:the\s+)?car\b/i, /\bcar (lock|unlock)\b/i, /\b(is the car|car) locked\b/i],
      run: async (m, text, ctx) => {
        if (/locked\??$/.test(text) && !/^(lock|unlock)/i.test(text.split(' ')[0])) {
          const r = await callProvider(ctx, 'status', {});
          return { say: `The car is ${describe(r.car)}` };
        }
        const lock = /lock/i.test(m[1]) && !/unlock/i.test(m[1]);
        try {
          await callProvider(ctx, lock ? 'lock' : 'unlock', {});
          return { say: lock ? 'Car locked.' : 'Car unlocked.' };
        } catch (e) { return { say: e.message }; }
      },
    },
    {
      patterns: [/\b(pre-?condition|warm up|cool (down|the car)|heat) \b.*\bcar\b/i, /\bcar climate (on|off)\b/i],
      run: async (m, text, ctx) => {
        const off = /off/i.test(m[1] || '');
        try {
          await callProvider(ctx, off ? 'climate_off' : 'climate_on', {});
          return { say: off ? 'Car climate off.' : 'Pre-conditioning the car — give it a few minutes.' };
        } catch (e) { return { say: e.message }; }
      },
    },
    {
      patterns: [/\b(car |ev )?charge\b/i, /\bhow (much|’s|'?s) (the )?(car |battery|charge)\b/i, /\bwhere('?s| is) (the |my )?car\b/i],
      run: async (m, text, ctx) => {
        try {
          const r = await callProvider(ctx, 'status', {});
          if (/where/i.test(text)) return { say: `The car is at ${r.car.location}.` };
          return { say: `Charge is at ${r.car.chargePct}%${r.car.pluggedIn ? ' and it’s plugged in' : ''}.` };
        } catch (e) { return { say: e.message }; }
      },
    },
  ],
  tools: [
    {
      name: 'vehicle_action',
      description: 'Car action: lock/unlock, climate on/off, or status (charge, location). Sensitive.',
      input_schema: { type: 'object', properties: { action: { type: 'string', enum: ['lock', 'unlock', 'climate_on', 'climate_off', 'status'] } }, required: ['action'] },
      run: async ({ action }, ctx) => {
        if (!ctx.verified) return { say: 'Car control needs voice verification first.', verify: true };
        try {
          const r = await callProvider(ctx, action, {});
          if (action === 'status') return { say: `The car is ${describe(r.car)}` };
          return { say: { lock: 'Car locked.', unlock: 'Car unlocked.', climate_on: 'Climate pre-conditioning started.', climate_off: 'Climate off.' }[action] || 'Done.' };
        } catch (e) { return { say: e.message }; }
      },
    },
  ],
};
