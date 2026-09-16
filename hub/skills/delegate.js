'use strict';
/** Sub-agents — the silent staff of the v1.1.0 multi-brain architecture.
 *  The Host (OpenRouter rung) may hand ONE narrow mechanical task at a time to a
 *  fast executor running on Groq with its own .env-only key rotation
 *  (GROQ_KEY_1..n, model = SUBAGENT_MODEL). Results flow back to the Host,
 *  which integrates and presents them; the user never hears about the staff.
 *  The sub-agent has NO personality by design (owner spec, verbatim below) and
 *  never speaks to the user directly: this tool returns raw text for the Host
 *  only — no `say`, no cards. Availability is a Settings-visible capability
 *  line (counts only, same masking rules as every other key surface). */
const { KeyRing, loadKeysFor } = require('../keyring');

const SUBAGENT_SYSTEM =
  'You are a fast execution sub-agent inside a larger assistant system called JARVIS. ' +
  'You are NOT the user-facing personality — the Host model owns all conversation, tone, ' +
  'and character. Your job is purely functional.\n' +
  'RULES:\n' +
  '- Execute exactly the task given. No personality, jokes, or filler.\n' +
  '- Return output in the exact format requested. If none is specified, give the shortest clear answer.\n' +
  "- If the task is ambiguous or you're missing information, say so plainly in one line — don't guess silently.\n" +
  '- You are responding to the Host model, not the end user. Skip greetings, sign-offs, and pleasantries entirely.\n' +
  '- Optimize for speed and precision over conversation.';

const MAX_TASK = 6000;          // chars of task text (prompt-injection surface stays capped; output is untrusted data)
const OUT_CAP = 2400;           // chars of result handed back to the Host
const TIMEOUT_MS = 20000;

let _sig = '';
let _ring = null;
function ring() {
  const keys = loadKeysFor('GROQ', process.env);
  const sig = keys.join('|');
  if (!_ring || _sig !== sig) { _ring = new KeyRing(keys); _sig = sig; }
  return _ring;
}
const base = () => (process.env.GROQ_BASE || 'https://api.groq.com/openai/v1').replace(/\/$/, '');
const model = () => process.env.SUBAGENT_MODEL || 'qwen3-8-27b';

/** One call with key rotation; 401/402/403 hard-penalize the key, 429/5xx soft. */
async function callOnce(task) {
  const r = ring();
  if (!r.size) return { ok: false, why: 'no-keys' };
  let last = 'sub-agent unreachable';
  for (let attempt = 0, tries = Math.max(1, r.size); attempt < tries; attempt++) {
    const pick = r.next();
    if (!pick) break;
    let res;
    try {
      res = await fetch(base() + '/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + pick.key },
        body: JSON.stringify({
          model: model(),
          messages: [{ role: 'system', content: SUBAGENT_SYSTEM }, { role: 'user', content: task }],
          temperature: 0, max_tokens: 800,
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (e) {
      r.fail(pick.index, {});
      last = 'sub-agent network blip (' + (e.name || 'error') + ')';
      continue;
    }
    if (res.ok) {
      r.ok(pick.index);
      const data = await res.json().catch(() => null);
      const txt = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
      if (!txt) return { ok: false, why: 'empty-response' };
      return { ok: true, text: String(txt).trim().slice(0, OUT_CAP) };
    }
    const body = await res.text().catch(() => '');
    if (res.status === 401 || res.status === 402 || res.status === 403) {
      r.fail(pick.index, { hard: true });
      last = 'sub-agent key rejected (HTTP ' + res.status + ')';
      continue;
    }
    r.fail(pick.index, {});
    last = 'sub-agent upstream HTTP ' + res.status + (res.status === 400 && /model/.test(body) ? ` — check SUBAGENT_MODEL "${model()}"` : '');
  }
  return { ok: false, why: 'unreachable', last };
}

module.exports = {
  name: 'delegate',
  label: 'Sub-agents',
  description: 'Host delegates narrow mechanical tasks to silent Groq executors (results integrated by the Host; invisible to the user).',
  tools: [
    {
      name: 'delegate_task', sideEffect: 'read',
      description: 'Delegate ONE well-defined mechanical task (parse, extract, summarize, quick computation, format conversion) to a fast silent sub-agent. Give it full context in the task string and the exact output format you want. You integrate its answer yourself — never mention the delegation to the user. If unavailable, do the task yourself.',
      input_schema: {
        type: 'object',
        properties: {
          task: { type: 'string', description: `The complete task with all needed context, ≤${MAX_TASK} chars, including the exact output format wanted.` },
        },
        required: ['task'],
      },
      run: async (args) => {
        const task = String((args && args.task) || '').trim().slice(0, MAX_TASK);
        if (task.length < 3) return { text: 'no task given' };
        const out = await callOnce(task);
        if (out.ok) return { text: out.text };
        // honest, terse status for the Host — it must never surface a stack or a secret
        return { text: `[sub-agent unavailable: ${out.why === 'no-keys' ? 'no Groq keys configured in .env' : out.last || out.why}]` };
      },
    },
  ],
  /** Sync, cached, counts-only — rides Settings → Skills via registry.describe(). */
  status() {
    try {
      let n = 0;
      try { n = ring().size; } catch { n = 0; }
      return n ? `Sub-agents: ${n} Groq key${n > 1 ? 's' : ''} rotating (model ${model().slice(0, 40)})`
        : 'Sub-agents: off — add GROQ_KEY_1..n to .env';
    } catch { return null; }
  },
  _test: { callOnce, ring, base, model },
};
