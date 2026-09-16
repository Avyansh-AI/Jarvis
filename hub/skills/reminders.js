'use strict';
/** Reminders — persistent, recurring-capable, snoozable. */
const { parseDuration, parseAt, fmtDayTime } = require('./_timeparse');
const { nextOccurrence } = require('../scheduler');

function extractTask(text) {
  // B-11 fix: the time clause can come FIRST ("remind me in 2 minutes to stretch").
  // The two original forms below only absorb ONE token before "to", so that very
  // common phrasing fell through to "What should I remind you about?".
  const m = text.match(/remind me (?:in|at|on|tomorrow\b|tonight\b|every\b)\s.+?\s+to\s+(.+)$/i) ||
            text.match(/remind me(?:\s+\S+)? to (.+?)(?=\s+(?:in|at|on|tomorrow|every|tonight|this)\b|$)/i) ||
            text.match(/remind me to (.+)$/i);
  return m ? m[1].trim() : null;
}

function buildJob(text, label, userId) {
  const job = { kind: 'reminder', label: `Reminder: ${label}`, user: userId };
  const everyDay = /every\s*(day|morning|night|evening)/i.test(text);
  const everyWeekday = /every\s*weekday|weekdays/i.test(text);
  const everyWeek = text.match(/every\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)/i);
  if (everyDay || everyWeekday || everyWeek) {
    const p = parseAt(text) || { hour: /morning/i.test(text) ? 8 : /night|evening/i.test(text) ? 20 : 9, minute: 0 };
    job.hour = p.hour; job.minute = p.minute;
    job.repeat = everyDay ? 'daily' : everyWeekday ? 'weekdays' : 'weekly';
    if (everyWeek) {
      const { DOW } = require('./_timeparse');
      job.dow = DOW[everyWeek[1].toLowerCase()];
    }
    job.at = nextOccurrence(job);
    return job;
  }
  const dur = parseDuration(text);
  if (dur) { job.at = Date.now() + dur; return job; }
  const p = parseAt(text);
  if (p) { job.at = p.at; return job; }
  return null;
}

module.exports = {
  name: 'reminders',
  label: 'Reminders',
  description: 'One-shot and recurring reminders with snooze, persisted across restarts.',
  personalData: true,
  intents: [
    {
      patterns: [/\bremind me\b/i, /\bset (a )?reminder\b/i],
      run: async (m, text, ctx) => {
        const label = extractTask(text);
        if (!label || /^(at|in|on|tomorrow)\b/i.test(label)) {
          return { say: 'What should I remind you about?', task: { step: 'what' } };
        }
        const job = buildJob(text, label, ctx.userId);
        if (!job) return { say: `Okay — "${label}". When should I remind you?`, task: { step: 'when', label } };
        ctx.scheduler.add(job);
        return { say: `I'll remind you ${job.repeat ? job.repeat + ' ' : ''}${fmtDayTime(job.at)} to ${label}.` };
      },
    },
    {
      patterns: [/\b(clear|delete|cancel) (all )?(my )?reminders\b/i],
      run: async (m, text, ctx) => {
        const n = ctx.scheduler.clearKind('reminder');
        return { say: n ? `Cleared ${n} reminder${n === 1 ? '' : 's'}.` : 'There were no reminders to clear.' };
      },
    },
    {
      patterns: [/\bwhat('?s| are) (on|my) reminders\b/i, /\blist (my )?reminders\b/i, /\bmy reminders\b/i],
      run: async (m, text, ctx) => {
        const jobs = ctx.scheduler.list().filter((j) => j.kind === 'reminder');
        if (!jobs.length) return { say: "You don't have any reminders right now." };
        const parts = jobs.slice(0, 4).map((j) => j.label.replace(/^Reminder: /, '') + ' ' + fmtDayTime(j.at));
        return { say: `You have ${jobs.length} reminder${jobs.length === 1 ? '' : 's'}: ${parts.join('; ')}.` };
      },
    },
  ],
  async continueTask(task, text, ctx) {
    if (task.step === 'what') {
      return { say: `Got it — "${text.replace(/^to /, '')}". When should I remind you?`, done: false, task: { step: 'when', label: text.replace(/^to /, '') } };
    }
    if (task.step === 'when') {
      const job = buildJob(text, task.label, ctx.userId);
      if (!job) return { say: "When? For example 'in 20 minutes', 'at 6 pm', or 'every morning'.", done: false, task };
      ctx.scheduler.add(job);
      return { say: `I'll remind you ${job.repeat ? job.repeat + ' ' : ''}${fmtDayTime(job.at)} to ${task.label}.` };
    }
    return { done: true, say: 'Hmm, I lost that one — could you ask again?' };
  },
  tools: [
    {
      name: 'add_reminder',
      description: 'Create a reminder. Provide minutes_from_now OR a time (hour/minute), optional repeat.',
      input_schema: {
        type: 'object',
        properties: {
          task: { type: 'string' }, minutes_from_now: { type: 'number' },
          hour: { type: 'integer' }, minute: { type: 'integer' },
          repeat: { type: 'string', enum: ['daily', 'weekdays', 'weekly', 'once'] },
        },
        required: ['task'],
      },
      run: async ({ task, minutes_from_now, hour, minute = 0, repeat }, ctx) => {
        const job = { kind: 'reminder', label: 'Reminder: ' + task, user: ctx.userId };
        if (minutes_from_now) job.at = Date.now() + minutes_from_now * 60000;
        else if (hour != null) {
          job.hour = hour; job.minute = minute;
          if (repeat && repeat !== 'once') { job.repeat = repeat; job.at = nextOccurrence(job); }
          else {
            const now = new Date();
            const d = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute);
            if (d.getTime() < now.getTime()) d.setDate(d.getDate() + 1);
            job.at = d.getTime();
          }
        } else return { say: `Okay — "${task}". When should I remind you?`, task: { step: 'when', label: task } };
        ctx.scheduler.add(job);
        return { say: `Reminder set for ${fmtDayTime(job.at)}${job.repeat ? ', ' + job.repeat : ''}: ${task}.` };
      },
    },
    {
      name: 'list_reminders',
      description: 'List upcoming reminders.',
      input_schema: { type: 'object', properties: {} },
      run: async (args, ctx) => {
        const jobs = ctx.scheduler.list().filter((j) => j.kind === 'reminder');
        if (!jobs.length) return { say: 'No reminders set.' };
        return { say: jobs.slice(0, 5).map((j) => `${j.label.replace(/^Reminder: /, '')} — ${fmtDayTime(j.at)}`).join('; ') };
      },
    },
  ],
};
