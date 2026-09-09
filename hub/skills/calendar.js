'use strict';
/**
 * Calendar — local encrypted event store + optional read-only ICS import
 * (Google Calendar: Settings → "Secret address in iCal format").
 */
const { storeFor } = require('../skill-data');
const { parseAt, fmtDayTime } = require('./_timeparse');
const { httpRetry: http } = require('../net'); // retry+backoff for integrations

function events() {
  const st = storeFor('calendar');
  st.data.events = st.data.events || [];
  return st;
}

function addEvent({ title, start, end = null, user = 'default' }) {
  const st = events();
  const ev = { id: 'e_' + Math.random().toString(36).slice(2, 9), title, start, end: end || start + 3600e3, user, created: Date.now() };
  st.data.events.push(ev);
  st.save();
  return ev;
}

function removeEvent(id) {
  const st = events();
  const i = st.data.events.findIndex((e) => e.id === id);
  if (i < 0) return false;
  st.data.events.splice(i, 1);
  st.save();
  return true;
}

function upcoming(withinMs = 7 * 864e5, now = Date.now()) {
  return events().data.events.filter((e) => e.start >= now - 3600e3 && e.start <= now + withinMs).sort((a, b) => a.start - b.start);
}

function today() {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  return events().data.events.filter((e) => e.start >= start && e.start < start + 864e5).sort((a, b) => a.start - b.start);
}

/** Minimal ICS parser (VEVENT SUMMARY/DTSTART/DTEND) for read-only imports. */
async function importICS(url) {
  const res = await http(url, {}, 15000);
  const ics = await res.text();
  let count = 0;
  const re = /BEGIN:VEVENT([\s\S]*?)END:VEVENT/g;
  let m;
  while ((m = re.exec(ics))) {
    const block = m[1];
    const sum = block.match(/SUMMARY[^:]*:(.+)/);
    const dt = block.match(/DTSTART[^:]*:(\d{8}T\d{6})Z?/);
    if (!sum || !dt) continue;
    const s = dt[1];
    const start = Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8), +s.slice(9, 11), +s.slice(11, 13));
    if (start < Date.now() - 864e5 || start > Date.now() + 90 * 864e5) continue;
    const title = sum[1].replace(/\\,/g, ',').trim();
    if (!events().data.events.some((e) => e.title === title && Math.abs(e.start - start) < 60000)) {
      addEvent({ title, start, user: 'ics' });
      count++;
    }
  }
  return count;
}

module.exports = {
  name: 'calendar',
  label: 'Calendar & Email',
  description: 'Local calendar with optional Google ICS import; triage and scheduling by voice.',
  personalData: true,
  addEvent, removeEvent, upcoming, today, importICS,
  intents: [
    {
      patterns: [/\b(what('?s| is)|any|show|list)\b.*\b(calendar|schedule|events|appointments|meetings)\b/i, /\bmy day\b/i, /\bfree (today|tomorrow)\b/i],
      run: async (m, text, ctx) => {
        const list = /tomorrow/i.test(text)
          ? upcoming(1728e5).filter((e) => e.start >= new Date().setHours(23, 59, 59))
          : today();
        if (!list.length) return { say: /tomorrow/i.test(text) ? 'Tomorrow looks clear.' : "Nothing on your calendar today — it's all yours." };
        const parts = list.slice(0, 4).map((e) => `${e.title} at ${new Date(e.start).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`);
        return { say: `You have ${list.length}: ${parts.join('; ')}.`, cards: [{ title: 'Calendar', lines: list.slice(0, 8).map((e) => `${fmtDayTime(e.start)} — ${e.title}`) }] };
      },
    },
    {
      patterns: [/\b(add|schedule|create)\b.*\b(event|appointment|meeting)\b/i, /\bbook\b.*\b(appointment|meeting)\b/i],
      run: async (m, text, ctx) => {
        const tm = text.match(/(?:event|appointment|meeting)\s+(?:called\s+|for\s+|with\s+)?(.+?)(?=\s+(?:at|on|in|tomorrow|next|tonight|morning|afternoon|evening|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b|$)/i);
        const title = tm ? tm[1].trim() : null;
        const p = parseAt(text);
        if (!title) return { say: 'What should I call the event?', task: { step: 'event-title' } };
        if (!p) return { say: `Okay — "${title}". When is it?`, task: { step: 'event-when', title } };
        addEvent({ title, start: p.at, user: ctx.userId });
        return { say: `"${title}" is on the calendar for ${fmtDayTime(p.at)}.` };
      },
    },
    {
      patterns: [/\bimport\b.*\b(calendar|ics)\b/i],
      run: async (m, text, ctx) => {
        const urlm = text.match(/https?:\/\/\S+/i);
        if (!urlm) return { say: 'Paste your calendar ICS link (Google: Settings → secret iCal address) after the word "import".' };
        try {
          const n = await importICS(urlm[0]);
          return { say: n ? `Imported ${n} upcoming events.` : 'No new upcoming events found in that feed.' };
        } catch { return { say: "I couldn't read that ICS feed — check the link.", error: true }; }
      },
    },
  ],
  async continueTask(task, text, ctx) {
    if (task.step === 'event-title') return { say: `When is "${text}"?`, done: false, task: { step: 'event-when', title: text } };
    if (task.step === 'event-when') {
      const p = parseAt(text);
      if (!p) return { say: "When? Like 'Friday at 3 pm' or 'tomorrow at 10'.", done: false, task };
      addEvent({ title: task.title, start: p.at, user: ctx.userId });
      return { say: `Done — "${task.title}" on ${fmtDayTime(p.at)}.` };
    }
    return { done: true, say: "Sorry, I lost that thread." };
  },
  tools: [
    {
      name: 'add_event',
      description: 'Add a calendar event.',
      input_schema: {
        type: 'object',
        properties: { title: { type: 'string' }, iso_start: { type: 'string', description: 'ISO 8601 local datetime' } },
        required: ['title', 'iso_start'],
      },
      run: async ({ title, iso_start }, ctx) => {
        const at = new Date(iso_start).getTime();
        if (isNaN(at)) return { say: 'That date did not parse — try again.' };
        addEvent({ title, start: at, user: ctx.userId });
        return { say: `"${title}" scheduled for ${fmtDayTime(at)}.` };
      },
    },
    {
      name: 'list_events',
      description: "List today's (or upcoming) calendar events.",
      input_schema: { type: 'object', properties: { days_ahead: { type: 'integer' } } },
      run: async ({ days_ahead = 1 }) => {
        const list = days_ahead <= 1 ? today() : upcoming(days_ahead * 864e5);
        if (!list.length) return { say: 'Nothing scheduled.' };
        return { say: list.slice(0, 5).map((e) => `${e.title} — ${fmtDayTime(e.start)}`).join('; ') };
      },
    },
  ],
};
