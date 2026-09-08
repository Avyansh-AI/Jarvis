'use strict';
/** YouTube — "summarize this video". No API key: video title/author via the
 *  public oEmbed endpoint; spoken-style summary by the existing brain from
 *  captions when they're fetchable (best-effort timedtext scrape — degrades
 *  to title-only gracefully). Tool output is UNTRUSTED data by declaration. */
const { httpRetry: http } = require('../net');

function videoId(u) {
  const m = String(u || '').match(/(?:youtube\.com\/(?:watch\?[^#]*v=|shorts\/|embed\/)|youtu\.be\/)([\w-]{6,20})/i);
  return m ? m[1] : null;
}

async function fetchInfo(url, online) {
  if (!online) return { error: "I'm offline — can't reach YouTube." };
  const id = videoId(url);
  if (!id) return { error: 'that doesn’t look like a YouTube link' };
  try {
    const r = await http('https://www.youtube.com/oembed?url=' + encodeURIComponent('https://youtu.be/' + id) + '&format=json');
    const meta = r.ok ? await r.json() : {};
    const out = { id, title: meta.title || '(title unavailable)', author: meta.author_name || 'unknown channel' };
    // best-effort captions: watch-page HTML → captionTracks → timedtext XML
    try {
      const w = await http('https://www.youtube.com/watch?v=' + id, { headers: { 'user-agent': 'Mozilla/5.0 (Jarvis; summary-bot)' } });
      const html = w.ok ? await w.text() : '';
      const m = html.match(/"captionTracks":(\[.*?\])/);
      if (m) {
        const tracks = JSON.parse(m[1]);
        const t = tracks.find((x) => /en/i.test(x.languageCode || '')) || tracks[0];
        if (t && t.baseUrl) {
          const xr = await http(t.baseUrl);
          const xml = xr.ok ? await xr.text() : '';
          const words = [...xml.matchAll(/<text[^>]*>([\s\S]*?)<\/text>/g)]
            .map((x) => x[1].replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim())
            .filter(Boolean).join(' ').slice(0, 6000);
          if (words.length > 80) out.transcript_excerpt = words;
        }
      }
    } catch { /* captions are best-effort — title still comes back */ }
    return out;
  } catch (e) { return { error: 'YouTube lookup hiccupped: ' + e.message }; }
}

module.exports = {
  name: 'youtube',
  label: 'YouTube',
  description: 'YouTube video info + caption-grounded summaries (no API key).',
  _internals: { videoId },
  tools: [
    {
      name: 'youtube_summary', sideEffect: 'read',
      description: 'Fetch a YouTube video\'s title/channel and caption excerpt so you can summarize it.',
      input_schema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
      run: async ({ url }, ctx) => {
        const out = await fetchInfo(url, ctx.net.online);
        if (out.error) return { error: out.error };
        return out;
      },
    },
  ],
  intents: [
    {
      patterns: [/\b(?:summari[sz]e|what'?s (?:in|this)|tell me about)\s+(?:this\s+)?(?:youtube\s+)?(?:video[:\s]+)?(https?:\/\/(?:[\w-]+\.)?(?:youtube\.com|youtu\.be)\/\S+)/i],
      run: async (m, text, ctx) => {
        const out = await fetchInfo(m[1].replace(/[),.]+$/, ''), ctx.net.online);
        if (out.error) return { say: out.error, error: true };
        const more = out.transcript_excerpt
          ? ` I pulled the captions — here's the gist: ${out.transcript_excerpt.slice(0, 260)}… (ask for a fuller summary with the cloud brain on)`
          : ' Captions weren’t fetchable, so I only have the title — ask again with the cloud brain on and I can try harder.';
        return { say: `That's "${out.title}" by ${out.author}.${more}`, data: out };
      },
    },
  ],
};
