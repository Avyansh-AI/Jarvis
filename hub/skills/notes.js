'use strict';
/**
 * Personal knowledge — quick notes + lightweight retrieval (RAG-lite).
 * Notes are chunked and scored with term-overlap (TF-IDF-ish) so answers can
 * be grounded and cite their source note. Swap in embeddings later if desired.
 */
const { storeFor } = require('../skill-data');

function notes(userId) {
  const st = storeFor('notes');
  st.data.notes = st.data.notes || {};
  st.data.notes[userId] = st.data.notes[userId] || [];
  return st;
}

function addNote(userId, text, title = null) {
  const st = notes(userId);
  const n = { id: 'n_' + Math.random().toString(36).slice(2, 9), title: title || text.split(/\s+/).slice(0, 5).join(' '), text, ts: Date.now() };
  st.data.notes[userId].push(n);
  if (st.data.notes[userId].length > 500) st.data.notes[userId] = st.data.notes[userId].slice(-500);
  st.save();
  return n;
}

function tokenize(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w.length > 2);
}

function searchNotes(userId, query, k = 3) {
  const q = new Set(tokenize(query));
  const all = notes(userId).data.notes[userId];
  const scored = [];
  for (const n of all) {
    const toks = tokenize(n.title + ' ' + n.text);
    const tf = {};
    toks.forEach((t) => (tf[t] = (tf[t] || 0) + 1));
    let score = 0;
    for (const w of q) if (tf[w]) score += tf[w] / Math.sqrt(toks.length);
    if (score > 0) scored.push({ note: n, score });
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, k);
}

module.exports = {
  name: 'notes',
  label: 'Personal Knowledge',
  description: 'Remember notes and docs, then answer questions grounded in them with citations.',
  personalData: true,
  addNote, searchNotes,
  intents: [
    {
      patterns: [/\b(take|make|add) (a )?note\b/i, /\bnote (this|down)\b/i, /\bremember that\b/i],
      run: async (m, text, ctx) => {
        const nm = text.match(/note[:\s]+(.+)/i) || text.match(/remember that (.+)/i);
        const body = nm ? nm[1].trim() : null;
        if (!body) return { say: 'What should I note down?', task: { step: 'note-body' } };
        const n = addNote(ctx.userId, body);
        return { say: `Noted: "${n.title}…".` };
      },
    },
    {
      patterns: [/\b(what do (i|you) have|search (my )?notes|find in my notes|look in my notes)\b/i, /\bdo (i|you) have (a )?note (on|about)\b/i],
      run: async (m, text, ctx) => {
        const qm = text.match(/(?:on|about|for)\s+(.+?)[?.!]?$/i);
        const q = qm ? qm[1] : '';
        if (!q) return { say: 'What should I search your notes for?' };
        const hits = searchNotes(ctx.userId, q, 3);
        if (!hits.length) return { say: `Nothing in your notes about "${q}".` };
        const top = hits[0];
        return {
          say: `From your note "${top.note.title}": ${top.note.text.split(/(?<=[.!?])\s+/).slice(0, 2).join(' ')}${hits.length > 1 ? ` (${hits.length - 1} more match${hits.length > 2 ? 'es' : ''})` : ''}`,
          cards: [{ title: `Notes on "${q}"`, lines: hits.map((h) => `📄 ${h.note.title} — ${h.note.text.slice(0, 80)}`), source: 'personal notes' }],
        };
      },
    },
    {
      patterns: [/\blist (my )?notes\b/i, /\bwhat notes\b/i],
      run: async (m, text, ctx) => {
        const all = notes(ctx.userId).data.notes[ctx.userId];
        if (!all.length) return { say: 'No notes yet. Say "take a note" to start.' };
        return { say: `You have ${all.length} notes. Recent: ${all.slice(-3).map((n) => n.title).join('; ')}.` };
      },
    },
  ],
  async continueTask(task, text, ctx) {
    if (task.step === 'note-body') {
      const n = addNote(ctx.userId, text);
      return { say: `Noted: "${n.title}…".` };
    }
    return { done: true, say: 'Hmm, lost that. Try again?' };
  },
  tools: [
    {
      name: 'add_note',
      description: 'Save a note/fact to the user’s personal knowledge base.',
      input_schema: { type: 'object', properties: { text: { type: 'string' }, title: { type: 'string' } }, required: ['text'] },
      run: async ({ text, title }, ctx) => {
        const n = addNote(ctx.userId, text, title);
        return { say: `Noted under "${n.title}".` };
      },
    },
    {
      name: 'search_notes',
      description: 'Answer from the user’s stored notes; include source titles as citations.',
      input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
      run: async ({ query }, ctx) => {
        const hits = searchNotes(ctx.userId, query, 3);
        if (!hits.length) return { say: `Your notes don't mention "${query}".` };
        return {
          say: `According to "${hits[0].note.title}": ${hits[0].note.text.slice(0, 220)}`,
          cards: [{ title: 'Sources', lines: hits.map((h) => h.note.title), source: 'personal notes' }],
        };
      },
    },
  ],
};
