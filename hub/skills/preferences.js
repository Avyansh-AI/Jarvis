'use strict';
/**
 * Personality & memory — tone slider by voice, long-term facts,
 * "what do you know about me", and forgetting on request.
 */
module.exports = {
  name: 'preferences',
  label: 'Personality & Memory',
  description: 'Tone slider (clinical ↔ playful), remembered facts, and memory review/forget.',
  intents: [
    {
      patterns: [/\bbe more (playful|funny|fun|serious|formal|clinical|professional)\b/i, /\b(?:tone|personality) (?:to |slider )?(\w+)/i],
      run: async (m, text, ctx) => {
        const playful = /playful|funny|fun/.test(text);
        const clinical = /serious|formal|clinical|professional/.test(text);
        const tone = playful ? 0.85 : clinical ? 0.15 : 0.5;
        ctx.memory.setPref(ctx.userId, 'tone', tone);
        return {
          say: tone > 0.6 ? 'You got it — dial turned toward playful. I promise only tasteful jokes.' :
            tone < 0.4 ? 'Understood. Crisp and clinical from here on.' : 'Back to balanced warmth.',
        };
      },
    },
    {
      patterns: [/\bremember (that )?(.+)/i, /\bmy favorite (\w+) is (.+)/i],
      run: async (m, text, ctx) => {
        // R-10: the second pattern matched with m[2]=just the value ("teal") and the
        // ternary never ran — "my favorite color is teal" stored a bare "teal".
        // Keep the full possessive phrase (the personal marker also protects it from
        // live-search overwrite in the grounding layer).
        const fav = /\bmy favorite (\w+) is (.+)/i.exec(text);
        const fact = (fav ? `my favorite ${fav[1]} is ${fav[2]}` : (m[2] || '')).trim();
        if (!fact || fact.length < 3) return { say: 'What should I remember?' };
        ctx.memory.addFact(ctx.userId, fact);
        return { say: `I'll remember that ${fact}.` };
      },
    },
    {
      patterns: [/\bforget (that |about )?(.+)/i, /\bforget everything\b/i],
      run: async (m, text, ctx) => {
        if (/everything/i.test(text)) {
          const u = ctx.memory.ensureUser(ctx.userId);
          u.facts = [];
          ctx.memory.store.save();
          return { say: 'All personal facts wiped. Fresh slate.' };
        }
        const n = ctx.memory.forgetFact(ctx.userId, (m[2] || '').trim());
        return { say: n ? `Forgot ${n} thing${n === 1 ? '' : 's'} about that.` : "I didn't have anything matching that." };
      },
    },
    {
      patterns: [/\bwhat do you know about me\b/i, /\bmy (profile|memory|facts)\b/i],
      run: async (m, text, ctx) => {
        const facts = ctx.memory.facts(ctx.userId);
        if (!facts.length) return { say: "I don't have any saved facts about you yet. Say 'remember that…' to teach me." };
        const last = facts.slice(-5).map((f) => f.fact);
        return { say: `Here's what I remember: ${last.join('; ')}.`, cards: [{ title: 'Memory', lines: facts.slice(-15).map((f) => f.fact) }] };
      },
    },
    {
      patterns: [/\bwho am i\b/i],
      run: async (m, text, ctx) => {
        const u = ctx.memory.ensureUser(ctx.userId);
        return { say: `You're ${u.name}${u.guest ? ' (guest profile)' : ''}. ${u.facts.length ? `I know ${u.facts.length} things about you.` : 'I haven’t learned any facts yet.'}` };
      },
    },
  ],
  tools: [
    {
      name: 'remember_fact',
      description: 'Persist a fact about the user to long-term memory (preferences, favorites, context).',
      input_schema: { type: 'object', properties: { fact: { type: 'string' } }, required: ['fact'] },
      run: async ({ fact }, ctx) => { ctx.memory.addFact(ctx.userId, fact); return { say: `Remembered: ${fact}.` }; },
    },
    {
      name: 'set_tone',
      description: 'Set the assistant tone: 0 = clinical, 1 = playful.',
      input_schema: { type: 'object', properties: { value: { type: 'number', minimum: 0, maximum: 1 } }, required: ['value'] },
      run: async ({ value }, ctx) => {
        ctx.memory.setPref(ctx.userId, 'tone', Math.max(0, Math.min(1, value)));
        return { say: value > 0.6 ? 'Playful mode on.' : value < 0.4 ? 'Clinical mode on.' : 'Balanced tone set.' };
      },
    },
  ],
};
