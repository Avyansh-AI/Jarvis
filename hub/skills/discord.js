'use strict';
/** Discord bridge — send + receive via a Discord BOT credential.
 *  The bot token is a SERVICE credential (Settings → integrations.discordToken
 *  or DISCORD_BOT_TOKEN env) — it is NOT an LLM key and never touches the LLM
 *  keyring/rotation. Zero-dependency: outbound via Discord REST; inbound via a
 *  60 s REST poll of the configured channel (no Gateway needed at this scale).
 *  The token never appears in logs/events — verified by test. */
const { httpRetry: http } = require('../net');
const API = 'https://discord.com/api/v10';
let store = null, bus = null, timer = null, settingsRef = null, netRef = { online: true };

const creds = () => ({ token: settingsRef?.integrations?.discordToken || '', channel: settingsRef?.integrations?.discordChannel || '' });
const headers = (token) => ({ authorization: 'Bot ' + token, 'content-type': 'application/json' });

async function send(message) {
  const { token, channel } = creds();
  if (!token || !channel) return { say: 'Discord isn’t configured yet — bot token + channel id go in Settings → Integrations (service credentials, not an LLM key).' };
  if (!netRef.online) return { say: "I'm offline — Discord is unreachable." };
  try {
    const res = await http(`${API}/channels/${encodeURIComponent(channel)}/messages`, {
      method: 'POST', headers: headers(token), body: JSON.stringify({ content: String(message).slice(0, 1900) }),
    });
    if (res.status === 401 || res.status === 403) return { say: 'Discord rejected the bot token — check it in Settings → Integrations.', error: true };
    if (!res.ok) return { say: `Discord answered HTTP ${res.status}.`, error: true };
    return { say: 'Sent to Discord.' };
  } catch (e) { return { say: 'Discord send failed: ' + e.message, error: true }; }
}

async function pollOnce() {
  const { token, channel } = creds();
  if (!token || !channel || !netRef.online || !store) return;
  try {
    const res = await http(`${API}/channels/${encodeURIComponent(channel)}/messages?limit=1`, { headers: { authorization: 'Bot ' + token } });
    if (!res.ok) { if (res.status === 401 && store.data.lastErr !== 401) { store.data.lastErr = 401; store.saveSoon(); bus && bus.emit('discord.error', { status: 401 }); } return; }
    store.data.lastErr = 0;
    const msgs = await res.json();
    const m = Array.isArray(msgs) ? msgs[0] : null;
    if (!m || m.author?.bot) { if (m && !store.data.lastId) { store.data.lastId = m.id; store.saveSoon(); } return; }
    const seen = store.data.lastId ? BigInt(store.data.lastId) : 0n;
    if (seen && BigInt(m.id) <= seen) return; // snowflake ids are chronological
    store.data.lastId = m.id; store.saveSoon();
    bus && bus.emit('discord.message', { from: m.author?.username || 'someone', text: String(m.content || '').slice(0, 240) });
  } catch { /* network hiccup — next tick retries */ }
}

module.exports = {
  name: 'discord',
  label: 'Discord',
  description: 'Send/receive Discord messages via your bot (service credential, not an LLM key).',
  personalData: true,
  register(ctx) { // ctx: { bus, skillStore, settings, net }
    bus = ctx.bus; store = ctx.skillStore; settingsRef = ctx.settings; netRef = ctx.net;
    if (timer) clearInterval(timer);
    timer = setInterval(pollOnce, 60000);
    timer.unref && timer.unref();
  },
  stop() { if (timer) clearInterval(timer); timer = null; },
  _internals: { pollOnce, headers },
  tools: [
    {
      name: 'discord_send', sideEffect: 'write',
      description: 'Send a message to the configured Discord channel.',
      input_schema: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] },
      run: async ({ message }) => send(message),
    },
  ],
  intents: [
    {
      patterns: [/^(?:send (?:a message )?to discord|(?:discord|tell discord|post to discord))\s*[:\-–]?\s*(.+)$/i],
      run: async (m) => send(m[1]),
    },
    {
      patterns: [/^(?:check|read) discord$/i],
      run: async () => {
        if (!store || !store.data.lastId) return { say: creds().token ? 'Nothing new on Discord yet.' : 'Discord isn’t configured — see Settings → Integrations.' };
        return { say: 'You’re caught up on Discord.' };
      },
    },
  ],
};
