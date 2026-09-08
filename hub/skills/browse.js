'use strict';
/** Browse — read pages from the web. READ-ONLY by design (toolSideEffect 'read'):
 *  everything it returns is wrapped as untrusted data, and under the Round-5
 *  rules no page content can ever trigger a write/action — only the owner's
 *  live trusted channel can. SSRF-guarded: http(s) only, public hosts only.
 *  (Interactive browsing via Playwright is an optional future adapter — the
 *  trust rule above is load-bearing for either backend.) */
const { httpRetry: http } = require('../net');
const PRIVATE_HOST = /^(localhost|127\.|0\.0\.0\.0|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|169\.254\.|\[?::1)/i;

function validateUrl(raw) {
  let u;
  try { u = new URL(String(raw || '')); } catch { return { error: 'that’s not a URL I can open' }; }
  if (!/^https?:$/.test(u.protocol)) return { error: 'I only open http/https pages' };
  if (PRIVATE_HOST.test(u.hostname)) return { error: 'I won’t open private/local network addresses' };
  return { u };
}

function stripHtml(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ').trim();
}

async function readPage(rawUrl, online) {
  if (online === false) return { say: "I'm offline — no browsing right now." };
  const v = validateUrl(rawUrl);
  if (v.error) return { error: v.error };
  try {
    const res = await http(v.u.href, { headers: { 'user-agent': 'Jarvis/1.0 (+personal assistant; read-only)' } });
    if (!res.ok) return { error: `that page answered HTTP ${res.status}` };
    const html = (await res.text()).slice(0, 400 * 1024);
    const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || v.u.hostname;
    const text = stripHtml(html).slice(0, 3200);
    if (!text) return { error: 'the page loaded but had no readable text' };
    return { title: stripHtml(title).slice(0, 140), url: v.u.href, excerpt: text };
  } catch (e) { return { error: 'couldn’t open the page: ' + e.message }; }
}

module.exports = {
  name: 'browse',
  label: 'Web Browse',
  description: 'Read a web page aloud (read-only; page content can never trigger actions).',
  _internals: { validateUrl, stripHtml },
  tools: [
    {
      name: 'browse_page', sideEffect: 'read',
      description: 'Open a public http(s) page and return its title + readable text excerpt. Informational only.',
      input_schema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
      run: async ({ url }, ctx) => readPage(url, ctx.net.online),
    },
  ],
  intents: [
    {
      patterns: [/\b(?:browse|read|open|visit)\s+(https?:\/\/\S+)/i],
      run: async (m, text, ctx) => {
        const out = await readPage(m[1].replace(/[),.]+$/, ''), ctx.net.online);
        if (out.error) return { say: out.error, error: true };
        return { say: `${out.title} — ${out.excerpt.slice(0, 220)}${out.excerpt.length > 220 ? '…' : ''}`, data: out };
      },
    },
  ],
};
