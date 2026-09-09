# Adding a Skill (the "marketplace" pattern)

A skill is a single CommonJS file in `hub/skills/`. Drop it in, restart the
hub — it appears in Settings → Skills, gets matched against voice/text input,
and its tools become available to the LLM brain automatically.

## Minimal example

`hub/skills/myhello.js`:

```js
'use strict';
module.exports = {
  name: 'myhello',
  label: 'My Hello',
  description: 'Says hello back.',
  priority: 0,            // higher wins when patterns overlap
  // access control (all optional)
  sensitive: false,       // true → requires voice verification
  personalData: false,    // true → hidden from guest profiles
  kidBlocked: false,      // true → hidden from kid profiles

  intents: [
    {
      patterns: [/^hello skill\b/i],
      run: async (match, text, ctx) => ({ say: `Hello back, ${ctx.user.name}!` }),
    },
  ],

  tools: [
    {
      name: 'say_hello',                    // ← what the LLM calls
      description: 'Greet the user by name.',
      input_schema: { type: 'object', properties: {} },
      run: async (args, ctx) => ({ say: `Hello, ${ctx.user.name}.` }),
    },
  ],
};
```

## The contract

**Return values**: `{ say: string }` at minimum. Optional fields:
`cards: [{ title, lines, source }]` (rich UI citations), `data` (arbitrary,
forwarded to the client), `task: { step, ...data }` (start a multi-turn task),
`verify: true` (ask the client to voice-verify first), `error: true`.

**Multi-turn tasks**: return `task` from any handler, then implement

```js
async continueTask(task, text, ctx) {
  // user replied while your task was pending
  return { say: '…', done: true };          // done:false keeps the task open
}
```

**`ctx`** gives you: `user`, `userId`, `verified`, `settings`, `memory`,
`scheduler`, `bus` (emit UI-wide events), `log`, `net` (`ctx.net.online`),
`http` (timeout-fetch), `env`, and `deny('guest'|'kid')`.

**Persistence**: `const { storeFor } = require('../skill-data');` gives an
AES-256-GCM-encrypted JSON store scoped to your skill:

```js
const st = storeFor('myhello');
st.data.count = (st.data.count || 0) + 1;
st.save();
```

**Filesystem helpers**: name shared helpers with a leading underscore
(`_timeparse.js`) — the registry skips `_*.js`.

**Rules of the road**
1. Never hardcode credentials — read `process.env` or `ctx.settings`.
2. Anything network-bound: check `ctx.net.online` and fail with a friendly
   `say`, never an exception trace.
3. Anything camera/mic/location-related: default off, check the matching
   `ctx.settings.privacy.*` flag.
4. Keep replies short — they are spoken aloud.
