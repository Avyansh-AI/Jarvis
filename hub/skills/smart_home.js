'use strict';
/**
 * Smart home — Home Assistant REST API.
 * Lights, switches, thermostats (climate), covers, and locks (voice-verify gated).
 * Configure HA_URL + HA_TOKEN (env or Settings screen).
 */
const { httpRetry: http } = require('../net'); // retry+backoff by default for integrations

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Fail-safe actuation: after commanding a physical device we re-read its real
 * state and only confirm what HA actually reports. Ambiguity (HA down,
 * half-dead Z-wave, state mismatch) is ALWAYS reported as "unconfirmed —
 * check it physically", never as success. A door we can't prove unlocked is
 * announced as unknown — this is the "fail secure, fail visible" contract.
 */
async function confirmState(ctx, entityId, expectedStates, waitMs = 1100) {
  await sleep(waitMs); // HA/Z-wave propagation
  try {
    const list = await states(ctx);
    const ent = list.find((e) => e.entity_id === entityId);
    if (!ent) return { confirmed: false, state: 'unknown' };
    return { confirmed: expectedStates.includes(String(ent.state).toLowerCase()), state: String(ent.state).toLowerCase() };
  } catch (e) {
    return { confirmed: false, state: 'unreachable', error: e.message };
  }
}

async function ha(ctx, method, path, body) {
  const { url, token } = ctx.settings.homeAssistant || {};
  if (!url || !token) throw new Error('Home Assistant isn’t configured yet (Settings → Smart home).');
  const res = await http(url.replace(/\/$/, '') + '/api' + path, {
    method,
    headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  }, 10000);
  if (!res.ok) throw new Error('Home Assistant returned HTTP ' + res.status);
  return res.json();
}

async function states(ctx) { return ha(ctx, 'GET', '/states'); }

function findEntity(list, nameWanted, domains) {
  const wanted = nameWanted.toLowerCase().replace(/\s+/g, ' ').trim();
  let best = null, bestScore = 0;
  for (const e of list) {
    const [domain] = e.entity_id.split('.');
    if (domains && !domains.includes(domain)) continue;
    const friendly = (e.attributes?.friendly_name || e.entity_id).toLowerCase();
    let score = 0;
    for (const w of wanted.split(' ')) if (friendly.includes(w)) score += w.length;
    if (wanted && friendly.includes(wanted)) score += 10;
    if (score > bestScore) { best = e; bestScore = score; }
  }
  return bestScore > 0 ? best : null;
}

const SWITCHABLE = ['light', 'switch', 'fan', 'input_boolean'];

module.exports = {
  name: 'smart_home',
  label: 'Smart Home',
  description: 'Home Assistant: lights, plugs, thermostat, covers; locks gated behind voice verification.',
  intents: [
    {
      patterns: [/\bturn (on|off)\b\s+(?:the\s+)?(.+)/i, /\b(lights|light) (on|off)\b/i, /\bswitch (on|off)\s+(?:the\s+)?(.+)/i],
      run: async (m, text, ctx) => {
        const on = (m[1] && /on/i.test(m[1])) || (m[2] && /on/i.test(m[2]));
        const name = (m[2] && !/^(on|off)$/i.test(m[2]) ? m[2] : m[3] || (/(lights|light)/i.test(text) ? 'lights' : '')).replace(/please/g, '').trim();
        try {
          const list = await states(ctx);
          const target = /^(lights|light)$/i.test(name) && !/bedroom|kitchen|living|hall|office/i.test(name)
            ? findEntity(list, 'light', ['light']) : findEntity(list, name, SWITCHABLE);
          if (!target) return { say: `I couldn't find a device matching "${name}" in Home Assistant.` };
          const [domain] = target.entity_id.split('.');
          await ha(ctx, 'POST', `/services/${domain}/turn_${on ? 'on' : 'off'}`, { entity_id: target.entity_id });
          return { say: `${target.attributes?.friendly_name || target.entity_id} is now ${on ? 'on' : 'off'}.` };
        } catch (e) { return { say: `Smart home hiccup: ${e.message}`, error: true }; }
      },
    },
    {
      patterns: [/\bset (?:the )?(?:thermostat|temperature|heat|ac)\b.*?(\d{2})/i, /\bthermostat to (\d{2})/i],
      run: async (m, text, ctx) => {
        const temp = parseInt(m[1], 10);
        if (temp < 5 || temp > 35) return { say: 'That temperature sounds off — try between 5 and 35.' };
        try {
          const list = await states(ctx);
          const target = findEntity(list, '', ['climate']);
          if (!target) return { say: 'No thermostat found in Home Assistant.' };
          await ha(ctx, 'POST', '/services/climate/set_temperature', { entity_id: target.entity_id, temperature: temp });
          return { say: `Thermostat set to ${temp} degrees.` };
        } catch (e) { return { say: `Thermostat hiccup: ${e.message}`, error: true }; }
      },
    },
    {
      patterns: [/\b(lock|unlock)\b\s+(?:the\s+)?(.+)/i],
      run: async (m, text, ctx) => {
        if (!ctx.verified) {
          if (ctx.lockSec > 0) return { say: `Sensitive actions are frozen for about ${Math.ceil(ctx.lockSec / 60)} more minutes after repeated failed verifications.`, locked: true };
          return { say: 'Locks are sensitive — please verify your voice first.', verify: true };
        }
        const locking = /lock/i.test(m[1]) && !/unlock/i.test(m[1]);
        const name = (m[2] || 'door').replace(/please/g, '').trim();
        try {
          const list = await states(ctx);
          const target = findEntity(list, name === 'door' || name === 'the door' ? '' : name, ['lock']);
          if (!target) return { say: `I couldn't find a lock matching "${name}".` };
          await ha(ctx, 'POST', `/services/lock/${locking ? 'lock' : 'unlock'}`, { entity_id: target.entity_id });
          const label = target.attributes?.friendly_name || 'The door';
          const chk = await confirmState(ctx, target.entity_id, [locking ? 'locked' : 'unlocked']);
          if (!chk.confirmed) {
            ctx.log?.write('actuator.unconfirmed', { entity: target.entity_id, wanted: locking ? 'locked' : 'unlocked', seen: chk.state });
            return { say: `I sent the ${locking ? 'lock' : 'unlock'} command to ${label}, but I can't confirm its state${chk.state && chk.state !== 'unknown' && chk.state !== 'unreachable' ? ` — it still shows "${chk.state}"` : ''}. Please check it physically; I'm treating it as NOT ${locking ? 'locked' : 'unlocked'}.`, unconfirmed: true };
          }
          return { say: `${label} is now ${locking ? 'locked' : 'unlocked'} — confirmed.` };
        } catch (e) { return { say: `Lock hiccup: ${e.message}`, error: true }; }
      },
    },
    {
      patterns: [/\b(open|close)\b\s+(?:the\s+)?(blinds|curtains|cover|garage)/i],
      run: async (m, text, ctx) => {
        const opening = /open/i.test(m[1]);
        if (/garage/i.test(m[2]) && !ctx.verified) {
          if (ctx.lockSec > 0) return { say: `Sensitive actions are frozen for about ${Math.ceil(ctx.lockSec / 60)} more minutes after repeated failed verifications.`, locked: true };
          return { say: 'The garage is sensitive — please verify your voice first.', verify: true };
        }
        try {
          const list = await states(ctx);
          const target = findEntity(list, m[2], ['cover']);
          if (!target) return { say: `No ${m[2]} cover found in Home Assistant.` };
          await ha(ctx, 'POST', `/services/cover/${opening ? 'open' : 'close'}_cover`, { entity_id: target.entity_id });
          const label = target.attributes?.friendly_name || m[2];
          const isGarage = /garage/i.test(m[2]);
          if (isGarage) { // security-relevant cover: confirm like a lock
            const chk = await confirmState(ctx, target.entity_id, opening ? ['open', 'opening'] : ['closed', 'closing']);
            if (!chk.confirmed) {
              ctx.log?.write('actuator.unconfirmed', { entity: target.entity_id, wanted: opening ? 'open' : 'closed', seen: chk.state });
              return { say: `I sent the command to the garage, but I can't confirm it's ${opening ? 'open' : 'closed'}. Please check it physically — I'm treating it as unconfirmed.`, unconfirmed: true };
            }
            return { say: `The garage is ${opening ? 'open' : 'closed'} — confirmed.` };
          }
          return { say: `${label} ${opening ? 'opening' : 'closing'}.` };
        } catch (e) { return { say: `Cover hiccup: ${e.message}`, error: true }; }
      },
    },
  ],
  tools: [
    {
      name: 'home_control',
      description: 'Control a Home Assistant device: turn on/off lights, switches, fans; set thermostat temperature; open/close covers.',
      input_schema: {
        type: 'object',
        properties: {
          device: { type: 'string', description: 'What the user called it, e.g. "living room lights"' },
          action: { type: 'string', enum: ['turn_on', 'turn_off', 'set_temperature', 'open_cover', 'close_cover'] },
          temperature: { type: 'number' },
        },
        required: ['device', 'action'],
      },
      run: async ({ device, action, temperature }, ctx) => {
        const dev = String(device || '');
        // sensitive surfaces stay gated on THIS path too (intents already check; tools must as well)
        if (/garage/i.test(dev) && !ctx.verified) {
          if (ctx.lockSec > 0) return { say: `Sensitive actions are frozen for about ${Math.ceil(ctx.lockSec / 60)} more minutes after repeated failed verifications.`, locked: true };
          return { say: 'The garage is sensitive — please verify your voice first.', verify: true };
        }
        if (action === 'set_temperature' && (!Number.isFinite(temperature) || temperature < 5 || temperature > 35)) {
          return { say: 'That temperature sounds off — try between 5 and 35 degrees.' };
        }
        try {
          const list = await states(ctx);
          const domains = action === 'set_temperature' ? ['climate'] : action.includes('cover') ? ['cover'] : SWITCHABLE;
          const target = findEntity(list, dev === 'thermostat' ? '' : dev, domains);
          if (!target) return { say: `I couldn't find "${device}" in Home Assistant.` };
          const [domain] = target.entity_id.split('.');
          const body = { entity_id: target.entity_id };
          if (action === 'set_temperature') body.temperature = temperature;
                await ha(ctx, 'POST', `/services/${domain}/${action}`, body);
          const name = target.attributes?.friendly_name || target.entity_id;
          if (/garage/i.test(dev) && action.includes('cover')) { // security-relevant: confirm, never bluff
            const want = action === 'open_cover' ? ['open', 'opening'] : ['closed', 'closing'];
            const chk = await confirmState(ctx, target.entity_id, want);
            if (!chk.confirmed) {
              ctx.log?.write('actuator.unconfirmed', { entity: target.entity_id, wanted: want[0], seen: chk.state });
              return { say: `Command sent to the garage, but I can't confirm it — please check it physically. I'm treating it as unconfirmed.`, unconfirmed: true };
            }
            return { say: `The garage is ${want[0]} — confirmed.` };
          }
          return { say: action === 'set_temperature' ? `${name} set to ${temperature} degrees.` : `${name}: ${action.replace(/_/g, ' ')} — done.` };
        } catch (e) { return { say: `Smart home hiccup: ${e.message}` }; }
      },
    },
    {
      name: 'home_lock',
      description: 'Lock or unlock a door lock. Sensitive action — requires voice verification.',
      input_schema: { type: 'object', properties: { device: { type: 'string' }, lock: { type: 'boolean' } }, required: ['lock'] },
      run: async ({ device = '', lock }, ctx) => {
        if (!ctx.verified) {
          if (ctx.lockSec > 0) return { say: `Sensitive actions are frozen for about ${Math.ceil(ctx.lockSec / 60)} more minutes after repeated failed verifications.`, locked: true };
          return { say: 'Locks need voice verification first.', verify: true };
        }
        try {
          const list = await states(ctx);
          const target = findEntity(list, device === 'door' ? '' : device, ['lock']);
          if (!target) return { say: `No lock found matching "${device || 'door'}".` };
          await ha(ctx, 'POST', `/services/lock/${lock ? 'lock' : 'unlock'}`, { entity_id: target.entity_id });
          const chk = await confirmState(ctx, target.entity_id, [lock ? 'locked' : 'unlocked']);
          if (!chk.confirmed) {
            ctx.log?.write('actuator.unconfirmed', { entity: target.entity_id, wanted: lock ? 'locked' : 'unlocked', seen: chk.state });
            return { say: `Command sent, but I can't confirm the door ${lock ? 'locked' : 'unlocked'}${chk.state && chk.state !== 'unknown' && chk.state !== 'unreachable' ? ` (it still shows "${chk.state}")` : ''}. Please check it physically — I'm treating it as NOT ${lock ? 'locked' : 'unlocked'}.`, unconfirmed: true };
          }
          return { say: lock ? 'Locked — confirmed. Sleep tight.' : 'Unlocked — confirmed.' };
        } catch (e) { return { say: `Lock hiccup: ${e.message}` }; }
      },
    },
  ],
};
