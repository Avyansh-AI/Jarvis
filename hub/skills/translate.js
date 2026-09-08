'use strict';
/** Translation — LibreTranslate-compatible endpoint with a tiny offline phrasebook. */
const { http } = require('../net');

const LANGS = {
  spanish: 'es', french: 'fr', german: 'de', italian: 'it', portuguese: 'pt',
  hindi: 'hi', punjabi: 'pa', dutch: 'nl', japanese: 'ja', korean: 'ko', chinese: 'zh',
  arabic: 'ar', russian: 'ru', english: 'en',
};

const PHRASEBOOK = {
  es: { hello: 'hola', 'thank you': 'gracias', 'good morning': 'buenos días', goodbye: 'adiós', yes: 'sí', no: 'no' },
  fr: { hello: 'bonjour', 'thank you': 'merci', 'good morning': 'bonjour', goodbye: 'au revoir', yes: 'oui', no: 'non' },
  hi: { hello: 'नमस्ते', 'thank you': 'धन्यवाद', 'good morning': 'सुप्रभात', goodbye: 'अलविदा', yes: 'हाँ', no: 'नहीं' },
  de: { hello: 'hallo', 'thank you': 'danke', 'good morning': 'guten Morgen', goodbye: 'auf Wiedersehen', yes: 'ja', no: 'nein' },
};

async function translate(ctx, text, target) {
  const code = LANGS[target.toLowerCase()] || target.toLowerCase().slice(0, 2);
  const res = await http(ctx.settings.translateUrl.replace(/\/$/, '') + '/translate', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ q: text, source: 'auto', target: code, format: 'text' }),
  }, 15000);
  if (!res.ok) throw new Error('translator returned HTTP ' + res.status);
  const data = await res.json();
  return { translated: data.translatedText, code };
}

module.exports = {
  name: 'translate',
  label: 'Translation',
  description: 'Spoken translation between 15+ languages (LibreTranslate; phrasebook offline).',
  intents: [
    {
      patterns: [/\btranslate\s+(.+?)\s+(?:to|into|in)\s+(\w+)/i, /\bhow do (?:you|i) say\s+(.+?)\s+in\s+(\w+)/i],
      run: async (m, text, ctx) => {
        const [, phrase, lang] = m;
        const p = phrase.replace(/^['"]|['"]$/g, '').trim();
        if (ctx.net.online) {
          try {
            const { translated } = await translate(ctx, p, lang);
            return { say: `In ${lang}: ${translated}.` };
          } catch { /* fall through to phrasebook */ }
        }
        const book = PHRASEBOOK[(LANGS[lang.toLowerCase()] || '')] || {};
        const hit = book[p.toLowerCase()];
        return hit
          ? { say: `In ${lang}: ${hit}. (offline phrasebook)` }
          : { say: `I'm offline and only know a few ${lang} phrases by heart — sorry.` };
      },
    },
  ],
  tools: [
    {
      name: 'translate',
      description: 'Translate text into another language and speak it.',
      input_schema: { type: 'object', properties: { text: { type: 'string' }, target_language: { type: 'string' } }, required: ['text', 'target_language'] },
      run: async ({ text, target_language }, ctx) => {
        if (!ctx.net.online) return { say: "I'm offline — translation needs the network." };
        try {
          const { translated } = await translate(ctx, text, target_language);
          return { say: `In ${target_language}: ${translated}.` };
        } catch (e) { return { say: `Translation hiccup: ${e.message}` }; }
      },
    },
  ],
};
