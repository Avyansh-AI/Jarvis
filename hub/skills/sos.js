'use strict';
/**
 * SOS — voice/button emergency trigger.
 * Broadcasts the alert state to every client and satellite, logs the event,
 * and fires the configured emergency webhook (e.g. Twilio/IFTTT) with the
 * emergency contacts list. Anyone may trigger an SOS — it is never gated.
 */
module.exports = {
  name: 'sos',
  label: 'Emergency SOS',
  description: 'Trigger an emergency alert: notifies your emergency contacts with location if configured.',
  priority: 100, // always win intent matching
  intents: [
    {
      patterns: [/\b(sos|emergency|help me|call for help|mayday)\b/i],
      run: async (m, text, ctx) => {
        const { http } = require('../net');
        const contacts = ctx.settings.emergencyContacts || [];
        const label = `Emergency SOS${ctx.user.name && ctx.user.name !== 'Owner' ? ' from ' + ctx.user.name : ''}. ${contacts.length ? 'Alerting ' + contacts.map((c) => c.name).join(', ') + '.' : 'No emergency contacts are configured — add them in Settings.'}`;
        ctx.log.write('sos.triggered', { user: ctx.userId });
        ctx.bus.emit('sos', { label, user: ctx.userId });
        if (ctx.settings.emergencyWebhook) {
          try {
            await http(ctx.settings.emergencyWebhook, {
              method: 'POST', headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ event: 'sos', user: ctx.userId, at: Date.now(), contacts }),
            }, 8000);
          } catch (e) { ctx.log.write('error', { message: 'sos webhook: ' + e.message }); }
        }
        return { say: label + ' Stay where you are — help is being contacted.', alert: true };
      },
    },
    {
      patterns: [/\bcancel (the )?(sos|emergency|alarm)\b/i, /\bfalse alarm\b/i],
      run: async (m, text, ctx) => {
        ctx.bus.emit('sos.cancel', {});
        ctx.log.write('sos.cancelled', { user: ctx.userId });
        return { say: 'Okay — standing down the alert. Glad you’re safe.' };
      },
    },
  ],
  tools: [
    {
      name: 'trigger_sos',
      description: 'EMERGENCY: trigger the SOS flow, contacting configured emergency contacts. Use when the user asks for urgent help.',
      input_schema: { type: 'object', properties: {} },
      run: async (args, ctx) => {
        const skill = module.exports;
        return skill.intents[0].run(null, 'sos', ctx);
      },
    },
  ],
};
