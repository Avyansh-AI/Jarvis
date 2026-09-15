'use strict';
/**
 * Budget — manual voice-first ledger + spend summaries + bill reminders.
 * Read-only bank sync (Plaid-style) is a documented integration point:
 * drop transactions into the same store via POST /api/finance/import.
 */
const { storeFor } = require('../skill-data');
const { nextOccurrence } = require('../scheduler');
const { parseAt } = require('./_timeparse');

function ledger(userId) {
  const st = storeFor('finance');
  st.data.entries = st.data.entries || {};
  st.data.entries[userId] = st.data.entries[userId] || [];
  return st;
}

function addExpense(userId, amount, what) {
  const st = ledger(userId);
  const e = { id: 'x_' + Math.random().toString(36).slice(2, 9), amount: Math.round(amount * 100) / 100, what, ts: Date.now() };
  st.data.entries[userId].push(e);
  st.save();
  return e;
}

function spendSummary(userId, days = 7) {
  const since = Date.now() - days * 864e5;
  const list = ledger(userId).data.entries[userId].filter((e) => e.ts >= since);
  const total = list.reduce((s, e) => s + e.amount, 0);
  return { count: list.length, total: Math.round(total * 100) / 100, days };
}

module.exports = {
  name: 'finance',
  label: 'Budget & Bills',
  description: 'Voice ledger, weekly spend summaries, bill reminders. Read-only; no banking credentials stored.',
  personalData: true,
  sensitive: true, // gated by voice verification — money is personal
  addExpense, spendSummary,
  intents: [
    {
      patterns: [/\b(add|log|record)\b.*\b(expense|spent|spending|cost)\b/i, /\bi spent\b/i, /\bspent (\d+)/i],
      run: async (m, text, ctx) => {
        const am = text.match(/(?:rs\.?|₹|\$|€|£)?\s*(\d+(?:\.\d{1,2})?)/);
        const whatM = text.match(/(?:on|for)\s+(.+?)(?:\s+(?:today|yesterday)\b|[?.!]?$)/i);
        if (!am) return { say: 'How much did you spend, and on what?', task: { step: 'expense' } };
        const e = addExpense(ctx.userId, parseFloat(am[1]), whatM ? whatM[1].trim() : 'misc');
        return { say: `Logged ${e.amount} for ${e.what}.` };
      },
    },
    {
      patterns: [/\bhow much (did i|have i) spen[dt]\b/i, /\bspending (summary|this week|this month)\b/i, /\bmy expenses\b/i],
      run: async (m, text, ctx) => {
        const days = /month/i.test(text) ? 30 : /today/i.test(text) ? 1 : 7;
        const s = spendSummary(ctx.userId, days);
        return { say: s.count ? `In the last ${s.days} day${s.days > 1 ? 's' : ''} you logged ${s.total} across ${s.count} expense${s.count === 1 ? '' : 's'}.` : `No expenses logged in the last ${s.days} day${s.days > 1 ? 's' : ''}.` };
      },
    },
    {
      patterns: [/\bbill reminder\b/i, /\bremind me (about|of) (the )?(\w+) bill/i],
      run: async (m, text, ctx) => {
        const p = parseAt(text) || { hour: 9, minute: 0 };
        const job = { kind: 'reminder', label: 'Reminder: bill payment due', hour: p.hour, minute: p.minute, repeat: 'daily', user: ctx.userId };
        job.at = nextOccurrence(job);
        ctx.scheduler.add(job);
        return { say: `Bill reminder set for ${new Date(job.at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })} daily. Say "clear reminders" to remove it.` };
      },
    },
  ],
  async continueTask(task, text, ctx) {
    if (task.step === 'expense') {
      const am = text.match(/(\d+(?:\.\d{1,2})?)/);
      if (!am) return { say: 'Give me an amount, like "120 for groceries".', done: false, task };
      const whatM = text.match(/(?:on|for)\s+(.+)/i);
      const e = addExpense(ctx.userId, parseFloat(am[1]), whatM ? whatM[1].trim() : 'misc');
      return { say: `Logged ${e.amount} for ${e.what}.` };
    }
    return { done: true, say: 'Lost that one — try again?' };
  },
  tools: [
    {
      name: 'add_expense',
      description: 'Log an expense.',
      input_schema: { type: 'object', properties: { amount: { type: 'number' }, what: { type: 'string' } }, required: ['amount'] },
      run: async ({ amount, what = 'misc' }, ctx) => {
        const n = Number(amount);
        if (!Number.isFinite(n) || n <= 0 || n > 10000000) return { say: 'Give me a sensible amount (more than zero, less than ten million).' };
        const e = addExpense(ctx.userId, n, String(what || 'misc').slice(0, 80));
        return { say: `Logged ${e.amount} for ${e.what}.` };
      },
    },
    {
      name: 'spend_summary',
      description: 'Summarize spending over N days.',
      input_schema: { type: 'object', properties: { days: { type: 'integer' } } },
      run: async ({ days = 7 }, ctx) => {
        const d = Math.min(366, Math.max(1, parseInt(days, 10) || 7));
        const s = spendSummary(ctx.userId, d);
        return { say: s.count ? `You've logged ${s.total} over the last ${s.days} days (${s.count} entries).` : `Nothing logged in the last ${days} days.` };
      },
    },
  ],
};
