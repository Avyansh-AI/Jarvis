'use strict';
/** Clock — time/date, timers, alarms (persistent via scheduler). */
const { parseDuration, parseAt, fmtDuration, fmtDayTime } = require('./_timeparse');
const { nextOccurrence } = require('../scheduler');

function upcomingWord(ms) { return ms < 3600e3 ? `in ${fmtDuration(ms)}` : 'at ' + fmtDayTime(Date.now() + ms); }

module.exports = {
  name: 'clock',
  label: 'Clock & Timers',
  description: 'Time, date, timers, and alarms (one-shot or recurring).',
  intents: [
    {
      patterns: [/\bwhat(?:'s| is)( the)? (time|date|day)\b/i, /\bwhat (time|date) is it\b/i, /\bwhat day is (it|today)\b/i, /^time\??$/i, /\bcurrent (time|date)\b/i],
      run: async () => {
        const n = new Date();
        return { say: `It's ${n.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })} on ${n.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}.` };
      },
    },
    {
      patterns: [/\bset (a |an )?timer\b/i, /\btimer for\b/i],
      run: async (m, text, ctx) => {
        const ms = parseDuration(text);
        if (!ms) return { say: 'For how long?', task: { step: 'timer-length' } };
        const labelM = text.match(/timer.*?for (?:the |my )?(.*)$/i);
        const label = (labelM && labelM[1] && !parseDuration(labelM[1])) ? `Timer: ${labelM[1]}` : 'Timer';
        ctx.scheduler.add({ kind: 'timer', label, at: Date.now() + ms, user: ctx.userId });
        return { say: `Timer set for ${fmtDuration(ms)}. I'll let you know.` };
      },
    },
    {
      patterns: [/\b(set (an )?alarm|wake me)\b/i],
      run: async (m, text, ctx) => {
        const p = parseAt(text);
        if (!p) return { say: 'What time should the alarm go off?', task: { step: 'alarm-time' } };
        const repeat = /weekdays?/.test(text) ? 'weekdays' : /every\s*(day|morning|night)/i.test(text) ? 'daily' : (/every\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)/i.test(text) ? 'weekly' : null);
        const job = { kind: 'alarm', label: 'Alarm', hour: p.hour, minute: p.minute, user: ctx.userId };
        if (repeat) { job.repeat = repeat; if (repeat === 'weekly') job.dow = p.dow ?? new Date(p.at).getDay(); job.at = nextOccurrence(job); }
        else job.at = p.at;
        ctx.scheduler.add(job);
        return { say: `Alarm set for ${fmtDayTime(job.at)}${repeat ? ', repeating ' + repeat : ''}.` };
      },
    },
    {
      patterns: [/\b(cancel|clear|stop)\b.*\b(timer|timers|alarm|alarms)\b/i],
      run: async (m, text, ctx) => {
        const kind = /timer/i.test(text) ? 'timer' : 'alarm';
        const n = ctx.scheduler.clearKind(kind);
        return { say: n ? `Cleared ${n} ${kind}${n === 1 ? '' : 's'}.` : `You have no ${kind}s right now.` };
      },
    },
    {
      patterns: [/\bwhat (timers|alarms)|list (my )?(timers|alarms)|any (timers|alarms)/i],
      run: async (m, text, ctx) => {
        const jobs = ctx.scheduler.list().filter((j) => j.kind === 'timer' || j.kind === 'alarm');
        if (!jobs.length) return { say: 'No timers or alarms set.' };
        const parts = jobs.slice(0, 4).map((j) => `${j.kind} ${j.repeat ? j.repeat + ' ' : ''}${fmtDayTime(j.at)}`);
        return { say: `You have ${jobs.length}: ${parts.join('; ')}.` };
      },
    },
  ],
  async continueTask(task, text, ctx) {
    if (task.step === 'timer-length') {
      const ms = parseDuration(text);
      if (!ms) return { say: "Sorry, how long? Like '5 minutes'.", done: false, task };
      ctx.scheduler.add({ kind: 'timer', label: 'Timer', at: Date.now() + ms, user: ctx.userId });
      return { say: `Timer set for ${fmtDuration(ms)}.` };
    }
    if (task.step === 'alarm-time') {
      const p = parseAt(text);
      if (!p) return { say: "What time? Like '7 am' or '18:30'.", done: false, task };
      ctx.scheduler.add({ kind: 'alarm', label: 'Alarm', at: p.at, user: ctx.userId });
      return { say: `Alarm set for ${fmtDayTime(p.at)}.` };
    }
    return { say: 'Lost the thread there — try again?', done: true };
  },
  tools: [
    {
      name: 'set_timer',
      description: 'Start a countdown timer (e.g. for cooking).',
      input_schema: { type: 'object', properties: { minutes: { type: 'number' }, label: { type: 'string' } }, required: ['minutes'] },
      run: async ({ minutes, label }, ctx) => {
        ctx.scheduler.add({ kind: 'timer', label: label || 'Timer', at: Date.now() + minutes * 60000, user: ctx.userId });
        return { say: `Timer set for ${fmtDuration(minutes * 60000)}.` };
      },
    },
    {
      name: 'cancel_scheduled',
      description: 'Cancel/clear timers or alarms (all of one kind, or a specific one by id).',
      input_schema: { type: 'object', properties: { kind: { type: 'string', enum: ['timer', 'alarm', 'all'] }, id: { type: 'string' } }, required: ['kind'] },
      run: async ({ kind, id }, ctx) => {
        if (id) return { say: ctx.scheduler.remove(id) ? 'Cancelled.' : "Couldn't find that one." };
        if (kind === 'all') {
          const n = ctx.scheduler.clearKind('timer') + ctx.scheduler.clearKind('alarm');
          return { say: n ? `Cleared ${n} timer${n === 1 ? '' : 's'}/alarm${n === 1 ? '' : 's'}.` : 'Nothing was set.' };
        }
        const n = ctx.scheduler.clearKind(kind);
        return { say: n ? `Cleared ${n} ${kind}${n === 1 ? '' : 's'}.` : `There were no ${kind}s to clear.` };
      },
    },
    {
      name: 'list_scheduled',
      description: "List the user's upcoming timers and alarms (and when they fire).",
      input_schema: { type: 'object', properties: { kind: { type: 'string', enum: ['timer', 'alarm', 'all'] } } },
      run: async ({ kind = 'all' }, ctx) => {
        let jobs = ctx.scheduler.list().filter((j) => j.kind === 'timer' || j.kind === 'alarm');
        if (kind !== 'all') jobs = jobs.filter((j) => j.kind === kind);
        if (!jobs.length) return { say: `No ${kind === 'all' ? 'timers or alarms' : kind + 's'} set right now.` };
        return { say: jobs.slice(0, 5).map((j) => `${j.kind}${j.label !== 'Timer' && j.label !== 'Alarm' ? ' "' + j.label + '"' : ''} at ${fmtDayTime(j.at)}${j.repeat ? ' (' + j.repeat + ')' : ''}`).join('; ') };
      },
    },
    {
      name: 'set_alarm',
      description: 'Set an alarm for a specific time; optionally recurring (daily/weekdays/weekly).',
      input_schema: {
        type: 'object',
        properties: { hour: { type: 'integer' }, minute: { type: 'integer' }, repeat: { type: 'string', enum: ['daily', 'weekdays', 'weekly', 'once'] } },
        required: ['hour'],
      },
      run: async ({ hour, minute = 0, repeat }, ctx) => {
        const job = { kind: 'alarm', label: 'Alarm', hour, minute, user: ctx.userId };
        if (repeat && repeat !== 'once') { job.repeat = repeat; job.at = nextOccurrence(job); }
        else {
          const now = new Date();
          const d = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute);
          if (d.getTime() < now.getTime()) d.setDate(d.getDate() + 1);
          job.at = d.getTime();
        }
        ctx.scheduler.add(job);
        return { say: `Alarm set for ${fmtDayTime(job.at)}${job.repeat ? ', repeating ' + job.repeat : ''}.` };
      },
    },
  ],
};
