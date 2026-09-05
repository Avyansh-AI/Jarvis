'use strict';
/** Daily briefing — weather + calendar + news + wellness, spoken aloud, on demand or scheduled. */
module.exports = {
  name: 'briefing',
  label: 'Daily Briefing',
  description: 'A spoken morning rundown: weather, calendar, headlines, sleep/activity, proactive nudges.',
  personalData: true,
  intents: [
    {
      patterns: [/\b(briefing|brief me|my morning|good morning|daily summary|catch me up)\b/i],
      run: async (m, text, ctx) => module.exports.build(ctx),
    },
  ],
  async build(ctx) {
    const parts = [];
    const h = new Date().getHours();
    const greet = h < 5 ? 'Burning the midnight oil' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
    parts.push(`${greet}${ctx.user.name ? ', ' + ctx.user.name : ''}. Here's your rundown.`);

    // weather
    try {
      if (ctx.net.online) {
        const weather = require('./weather');
        if (ctx.settings.homeCity) {
          const out = await weather.current(ctx.settings.homeCity);
          parts.push(out.say);
        }
      } else parts.push("I'm offline, so weather and news are skipped.");
    } catch { /* weather optional */ }

    // calendar
    try {
      const cal = require('./calendar');
      const list = cal.today();
      parts.push(list.length
        ? `Today you have ${list.length} event${list.length === 1 ? '' : 's'}: first up, ${list[0].title} at ${new Date(list[0].start).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}.`
        : 'Your calendar is clear today.');
    } catch {}

    // wellness (informational only)
    try {
      const well = require('./wellness');
      const w = well.latest(ctx.userId);
      if (w) parts.push(well.summarizeLatest(w).say);
    } catch {}

    // news
    try {
      if (ctx.net.online) {
        const search = require('./search');
        const res = await search.tools.find((t) => t.name === 'get_news').run({}, ctx);
        if (res && res.say) parts.push(res.say);
      }
    } catch {}

    // proactive nudges from preference learning
    try {
      const top = ctx.memory.topIntents(1);
      if (top.length && top[0][1] >= 5 && ctx.settings.proactive?.enabled) {
        parts.push(`By the way — you ask me about ${top[0][0]} a lot. I could start doing that proactively if you like.`);
      }
    } catch {}

    return { say: parts.join(' '), long: true };
  },
  tools: [
    {
      name: 'daily_briefing',
      description: 'Read the daily briefing: weather, calendar, headlines, wellness summary.',
      input_schema: { type: 'object', properties: {} },
      run: async (args, ctx) => module.exports.build(ctx),
    },
  ],
};
