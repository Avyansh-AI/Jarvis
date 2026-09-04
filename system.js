'use strict';
/** System — hub health, satellites, network, self-update info. */
const os = require('os');

module.exports = {
  name: 'system',
  label: 'System',
  description: 'Hub status: uptime, network, satellites, version, update channel.',
  intents: [
    {
      patterns: [/\b(system|hub) (status|health)\b/i, /\bstatus report\b/i, /\bdiagnostics\b/i],
      run: async (m, text, ctx) => {
        const sats = ctx.bus.listenerCount('noop'); // placeholder no-op to keep ctx use
        const up = Math.round(process.uptime());
        const hh = Math.floor(up / 3600), mm = Math.floor((up % 3600) / 60);
        const mem = Math.round(process.memoryUsage().rss / 1e6);
        return {
          say: `Hub is ${ctx.net.online ? 'online' : 'offline — running local fallback'}. ` +
            `Uptime ${hh ? hh + ' hours ' : ''}${mm} minutes, using ${mem} megabytes, on Node ${process.version}. Check the logs dashboard for details.`,
          data: { uptime: up, memMB: mem, online: ctx.net.online, load: os.loadavg()[0] },
        };
      },
    },
    {
      patterns: [/\bwhat version\b/i, /\babout (you|this|max)\b/i],
      run: async (m, text, ctx) => {
        const pkg = require('../../package.json');
        return { say: `I'm ${ctx.settings.assistantName}, version ${pkg.version} — running locally on your hub with privacy-first defaults.` };
      },
    },
  ],
  tools: [
    {
      name: 'system_status',
      description: 'Report hub health: network, uptime, memory, version.',
      input_schema: { type: 'object', properties: {} },
      run: async (args, ctx) => {
        const up = Math.round(process.uptime());
        return { say: `${ctx.net.online ? 'Online' : 'Offline (local fallback)'}. Uptime ${Math.floor(up / 60)} minutes, ${Math.round(process.memoryUsage().rss / 1e6)} MB memory.` };
      },
    },
  ],
};
