'use strict';
/**
 * Health & wellness — OPTIONAL, informational only, never medical advice.
 * Accepts exported summaries (Apple Health / Google Fit / Oura style JSON)
 * via POST /api/wellness and weaves sleep/activity into the daily briefing.
 */
const { storeFor } = require('../skill-data');

function latest(userId) {
  const st = storeFor('wellness');
  st.data.byUser = st.data.byUser || {};
  const arr = st.data.byUser[userId] || [];
  return arr.length ? arr[arr.length - 1] : null;
}

function summarizeLatest(w) {
  const parts = [];
  if (w.sleepHours != null) parts.push(`You slept about ${Number(w.sleepHours).toFixed(1)} hours`);
  if (w.restingHr != null) parts.push(`resting heart rate ${w.restingHr}`);
  if (w.steps != null) parts.push(`and took ${Number(w.steps).toLocaleString()} steps yesterday`);
  if (!parts.length) return { say: '' };
  return { say: parts.join(', ') + '. (Just info, not medical advice.)' };
}

module.exports = {
  name: 'wellness',
  label: 'Health & Wellness',
  description: 'Optional wearable summaries (sleep/steps). Informational only — never medical advice.',
  personalData: true,
  sensitive: false,
  latest, summarizeLatest,
  ingest(userId, payload) {
    const st = storeFor('wellness');
    st.data.byUser = st.data.byUser || {};
    st.data.byUser[userId] = st.data.byUser[userId] || [];
    st.data.byUser[userId].push({ ...payload, at: Date.now() });
    if (st.data.byUser[userId].length > 90) st.data.byUser[userId] = st.data.byUser[userId].slice(-90);
    st.save();
  },
  intents: [
    {
      patterns: [/\bhow did i sleep\b/i, /\b(my )?(steps|activity|wellness|health) (summary|today|yesterday)?\b/i, /\bsleep summary\b/i],
      run: async (m, text, ctx) => {
        const w = latest(ctx.userId);
        if (!w) return { say: "I don't have any wellness data yet — you can import a summary from your wearable app." };
        const s = summarizeLatest(w).say;
        return { say: s || 'The last wellness entry was empty.' };
      },
    },
  ],
  tools: [
    {
      name: 'get_wellness',
      description: 'Summarize the latest sleep/activity data (informational only, never medical advice).',
      input_schema: { type: 'object', properties: {} },
      run: async (args, ctx) => {
        const w = latest(ctx.userId);
        if (!w) return { say: 'No wellness data imported yet.' };
        return { say: summarizeLatest(w).say || 'Nothing useful in the last entry.' };
      },
    },
  ],
};
