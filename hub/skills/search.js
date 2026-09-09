'use strict';
/** Web search & facts — Wikipedia summaries + headline news, spoken style. */
const { httpRetry: http } = require('../net'); // retry+backoff for integrations

async function wikiSummary(query) {
  const s = await http(`https://en.wikipedia.org/w/api.php?action=opensearch&search=${encodeURIComponent(query)}&limit=1&format=json`);
  const [, titles] = await s.json();
  if (!titles || !titles.length) return null;
  const r = await http(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(titles[0])}`);
  if (!r.ok) return null;
  const data = await r.json();
  if (data.type === 'disambiguation' || !data.extract) return null;
  const text = data.extract.split(/(?<=[.!?])\s+/).slice(0, 2).join(' ');
  return { title: data.title, text, source: data.content_urls?.desktop?.page || 'Wikipedia' };
}

async function headlines(feedUrl, n = 3) {
  const res = await http(feedUrl, {}, 10000);
  const xml = await res.text();
  const items = [];
  const re = /<item>[\s\S]*?<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>[\s\S]*?<\/item>/g;
  let m;
  while ((m = re.exec(xml)) && items.length < n) {
    const t = m[1].replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/<[^>]+>/g, '').trim();
    if (t) items.push(t);
  }
  return items;
}

module.exports = {
  name: 'search',
  label: 'Search & News',
  description: 'Real-time facts (Wikipedia) and headline news, summarized for speaking.',
  intents: [
    {
      patterns: [
        // weather-domain questions are NOT encyclopedia lookups: "what is the weather like / in Paris / today"
        // must fall through to the weather skill — but concept questions ("what is the temperature of the sun",
        // "who is the weatherman") still belong here. Carve out only the weather-as-forecast idiom.
        /\b(who|what) (is|are|was|were)\s+(?!the\s+(?:weather|forecast|temperature)\b(?:\s+(?:like|today|tomorrow|now|outside|here|there)\b|\s+(?:in|for|at)\b|\s*[?.!,]*\s*$))(.+)/i,
        /\btell me about\s+(.+)/i, /\bsearch (for )?(.+)/i, /\blook up (.+)/i],
      run: async (m, text, ctx) => {
        if (!ctx.net.online) return { say: "I'm offline — no search right now." };
        const q = (m[3] || m[2] || m[1] || '').replace(/[?.!]+$/, '').trim();
        if (!q) return { say: 'What should I look up?' };
        try {
          const hit = await wikiSummary(q);
          if (!hit) return { say: `I couldn't find a good summary for "${q}".` };
          return { say: `${hit.text}`, cards: [{ title: hit.title, lines: [hit.text], source: hit.source }] };
        } catch (e) { return { say: 'Search hiccupped — try again in a moment.', error: true }; }
      },
    },
    {
      patterns: [/\b(news|headlines)\b/i],
      run: async (m, text, ctx) => {
        if (!ctx.net.online) return { say: "I'm offline — no news right now." };
        try {
          const hs = await headlines(ctx.settings.newsFeed, 3);
          if (!hs.length) return { say: "I couldn't read the news feed just now." };
          return { say: `Top headlines: ${hs.map((h) => h).join('. ')}.` };
        } catch { return { say: 'The news feed is being difficult — try later.', error: true }; }
      },
    },
  ],
  tools: [
    {
      name: 'web_search',
      description: 'Answer a factual question (who/what/where) using encyclopedic summaries. One or two sentences.',
      input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
      run: async ({ query }, ctx) => {
        if (!ctx.net.online) return { say: "I'm offline — search is unavailable." };
        try {
          const hit = await wikiSummary(query);
          return hit ? { say: hit.text, cards: [{ title: hit.title, lines: [hit.text], source: hit.source }] } : { say: `Nothing solid found for "${query}".` };
        } catch { return { say: 'Search failed just now.' }; }
      },
    },
    {
      name: 'get_news',
      description: 'Read the top news headlines.',
      input_schema: { type: 'object', properties: {} },
      run: async (args, ctx) => {
        if (!ctx.net.online) return { say: "I'm offline — no news right now." };
        try {
          const hs = await headlines(ctx.settings.newsFeed, 4);
          return { say: hs.length ? `Top headlines: ${hs.join('. ')}.` : 'The news feed came back empty.' };
        } catch { return { say: 'Could not fetch headlines.' }; }
      },
    },
  ],
};

/* helper exports for the grounding layer (memory + live search answering) —
   the skill definition above is untouched; tools/intents keep working as before */
module.exports.wikiSummary = wikiSummary;
module.exports.headlines = headlines;
