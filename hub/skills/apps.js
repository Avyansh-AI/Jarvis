'use strict';
/**
 * Apps — open, close, and list desktop applications on the machine the hub
 * runs on. Cross-platform (linux / darwin / win32).
 *
 * Safety:
 *   - App names are sanitized (word chars, spaces, . + # @ ( ) - only, ≤64).
 *   - No shell string interpolation: everything goes through spawn args or
 *     spawnSync with an argument array. The one place a shell is needed
 *     (Windows `start`) receives only the sanitized name as a single arg.
 */
const { spawn, spawnSync } = require('child_process');

const PLAT = process.platform;
const SAFE = /^[\w .+#@()\-]{2,64}$/;
/** Smart-home words — those belong to the smart_home skill, not here. */
const DEVICE_WORDS = /\b(door|doors|light|lights|lamp|lock|locks|garage|blinds?|curtains?|fan|ac\b|heater|thermostat|tv|television|plug|socket)\b/i;

const ALIASES = {
  chrome: { linux: ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'], darwin: ['Google Chrome'], win32: ['chrome'] },
  firefox: { linux: ['firefox'], darwin: ['Firefox'], win32: ['firefox'] },
  edge: { linux: ['microsoft-edge', 'microsoft-edge-stable'], darwin: ['Microsoft Edge'], win32: ['msedge'] },
  code: { linux: ['code'], darwin: ['Visual Studio Code'], win32: ['code'] },
  notepad: { linux: ['gedit', 'kate', 'mousepad', 'xed'], darwin: ['TextEdit'], win32: ['notepad'] },
  terminal: { linux: ['x-terminal-emulator', 'gnome-terminal', 'konsole', 'xterm', 'kitty', 'alacritty'], darwin: ['Terminal'], win32: ['cmd'] },
  files: { linux: ['nautilus', 'dolphin', 'thunar', 'pcmanfm', 'nemo'], darwin: ['Finder'], win32: ['explorer'] },
  calculator: { linux: ['gnome-calculator', 'kcalc', 'galculator'], darwin: ['Calculator'], win32: ['calc'] },
  spotify: { linux: ['spotify'], darwin: ['Spotify'], win32: ['spotify'] },
  vlc: { linux: ['vlc'], darwin: ['VLC'], win32: ['vlc'] },
  discord: { linux: ['discord'], darwin: ['Discord'], win32: ['discord'] },
  slack: { linux: ['slack'], darwin: ['Slack'], win32: ['slack'] },
  obs: { linux: ['obs'], darwin: ['OBS'], win32: ['obs64'] },
  gimp: { linux: ['gimp'], darwin: ['GIMP'], win32: ['gimp'] },
};
ALIASES['google chrome'] = ALIASES.chrome;
ALIASES.chromium = ALIASES.chrome;
ALIASES.vscode = ALIASES.code;
ALIASES['vs code'] = ALIASES.code;
ALIASES['visual studio code'] = ALIASES.code;
ALIASES['file manager'] = ALIASES.files;
ALIASES.explorer = ALIASES.files;
ALIASES.calc = ALIASES.calculator;
ALIASES.cmd = ALIASES.terminal;
ALIASES.console = ALIASES.terminal;

function sanitizeName(raw) {
  const name = String(raw || '').trim().replace(/\s+/g, ' ').replace(/[.?!,;:'"]+$/g, '').replace(/^(?:the|app|application)\s+/i, '').trim();
  if (!SAFE.test(name)) throw new Error(`"${String(raw).slice(0, 40)}" isn't a usable app name — letters, digits, spaces and . + # only.`);
  return name;
}

/** Candidate binaries/app names for a friendly name on this platform. */
function resolveCandidates(name) {
  const low = name.toLowerCase();
  const plat = PLAT === 'win32' ? 'win32' : PLAT === 'darwin' ? 'darwin' : 'linux';
  const alias = ALIASES[low];
  const list = alias ? alias[plat].slice() : [];
  if (!list.map((x) => x.toLowerCase()).includes(low)) list.push(name); // raw name as last try
  return list;
}

function which(bin) {
  if (PLAT === 'win32') {
    const r = spawnSync('where', [bin], { encoding: 'utf8', timeout: 4000 });
    return r.status === 0 && r.stdout.trim() ? r.stdout.split('\n')[0].trim() : null;
  }
  const r = spawnSync('which', [bin], { encoding: 'utf8', timeout: 4000 });
  return r.status === 0 ? r.stdout.split('\n')[0].trim() : null;
}

function exeForTaskkill(name) {
  const low = name.toLowerCase();
  const win = (ALIASES[low] && ALIASES[low].win32 && ALIASES[low].win32[0]) || name;
  return /\.exe$/i.test(win) ? win : win + '.exe';
}

async function openApp(raw, ctx) {
  const name = sanitizeName(raw);
  ctx.log.write('apps.open', { user: ctx.userId, app: name });
  const cands = resolveCandidates(name);
  if (PLAT === 'darwin') {
    for (const c of cands) {
      const r = spawnSync('open', ['-a', c], { encoding: 'utf8', timeout: 8000 });
      if (r.status === 0) return { say: `Opening ${c}.` };
    }
    throw new Error(`couldn't open "${name}" — tried: ${cands.join(', ')}.`);
  }
  if (PLAT === 'win32') {
    for (const c of cands) {
      if (!which(c)) continue;
      try {
        const child = spawn('cmd', ['/c', 'start', '""', c], { detached: true, stdio: 'ignore' });
        child.on('error', () => {});
        child.unref();
        return { say: `Opening ${c}.` };
      } catch { /* try next */ }
    }
    throw new Error(`couldn't find "${name}" on PATH — tried: ${cands.join(', ')}.`);
  }
  // linux
  for (const c of cands) {
    if (!which(c)) continue;
    try {
      const child = spawn(c, [], { detached: true, stdio: 'ignore' });
      child.on('error', () => {});
      child.unref();
      return { say: `Opening ${c}.` };
    } catch { /* try next */ }
  }
  throw new Error(`couldn't find "${name}" — no binary among: ${cands.join(', ')}. Install it or teach me its exact command.`);
}

async function closeApp(raw, ctx) {
  const name = sanitizeName(raw);
  ctx.log.write('apps.close', { user: ctx.userId, app: name });
  const cands = resolveCandidates(name);
  if (PLAT === 'win32') {
    const exe = exeForTaskkill(name);
    const r = spawnSync('taskkill', ['/IM', exe, '/F'], { encoding: 'utf8', timeout: 8000 });
    if (r.status === 0) return { say: `Closed ${exe}.` };
    throw new Error(`${exe} doesn't seem to be running.`);
  }
  if (PLAT === 'darwin') {
    for (const c of cands) {
      const r = spawnSync('osascript', ['-e', `tell application "${c.replace(/"/g, '')}" to quit`], { encoding: 'utf8', timeout: 8000 });
      if (r.status === 0) return { say: `Closed ${c}.` };
    }
    throw new Error(`${name} doesn't seem to be running (or won't take a quit).`);
  }
  // linux: pkill exact, then prefix fallback
  const procs = [];
  for (const c of cands) {
    const base = c.split('/').pop();
    const r = spawnSync('pgrep', ['-x', base], { encoding: 'utf8', timeout: 4000 });
    if (r.status === 0) procs.push(base);
  }
  if (!procs.length) throw new Error(`${name} doesn't seem to be running.`);
  for (const p of procs) spawnSync('pkill', ['-x', p], { timeout: 4000 });
  return { say: `Closed ${procs.join(', ')}.` };
}

async function listApps() {
  let names = [];
  if (PLAT === 'win32') {
    const r = spawnSync('tasklist', ['/FO', 'CSV', '/NH'], { encoding: 'utf8', timeout: 8000 });
    names = String(r.stdout || '').split('\n').map((l) => (l.match(/^"([^"]+)"/) || [])[1]).filter(Boolean);
  } else {
    const r = spawnSync('ps', ['-eo', 'comm='], { encoding: 'utf8', timeout: 8000 });
    names = String(r.stdout || '').split('\n').map((l) => l.trim()).filter(Boolean);
  }
  const seen = new Set();
  const out = [];
  for (const n of names) { if (!seen.has(n)) { seen.add(n); out.push(n); } if (out.length >= 25) break; }
  if (!out.length) throw new Error('could not list processes on this platform.');
  return { say: `Running now: ${out.slice(0, 12).join(', ')}${out.length > 12 ? ', …' : ''}.`, apps: out };
}

module.exports = {
  name: 'apps',
  label: 'Apps',
  description: 'Open, close, and list desktop applications on this machine.',
  kidBlocked: true,
  intents: [
    {
      patterns: [/^(?:please\s+)?(?:can you\s+)?(?:open|launch|start|fire up|bring up)\s+(.+)$/i],
      run: async (m, text, ctx) => {
        const name = String(m[1] || '').trim();
        if (DEVICE_WORDS.test(name)) return { say: `That sounds like a smart-home device — say "turn on" / "open" with the device name and I'll use the home skill.` };
        try { return await openApp(name, ctx); } catch (e) { return { say: `Sorry — ${e.message}` }; }
      },
    },
    {
      patterns: [/^(?:please\s+)?(?:can you\s+)?(?:close|quit|exit|kill|shut(?:\s+it)?)\s+(.+)$/i],
      run: async (m, text, ctx) => {
        const name = String(m[1] || '').trim();
        if (DEVICE_WORDS.test(name)) return { say: `That sounds like a smart-home device — I'll leave devices to the home skill.` };
        try { return await closeApp(name, ctx); } catch (e) { return { say: `Sorry — ${e.message}` }; }
      },
    },
    {
      patterns: [/\b(?:what|which)\s+apps?\s+(?:are\s+)?(?:running|open)/i, /\blist\s+(?:running\s+)?apps\b/i, /\bshow\s+running\b/i],
      run: async () => { try { return await listApps(); } catch (e) { return { say: `Sorry — ${e.message}` }; } },
    },
  ],
  tools: [
    {
      name: 'apps_open',
      description: 'Open/launch a desktop application on the user\'s own machine (e.g. Chrome, VS Code, notepad, terminal, calculator, files, Spotify).',
      input_schema: { type: 'object', properties: { name: { type: 'string', description: 'App name, friendly or binary (e.g. "chrome", "code").' } }, required: ['name'] },
      run: async ({ name }, ctx) => { try { return await openApp(name, ctx); } catch (e) { return { say: `Sorry — ${e.message}`, error: e.message }; } },
    },
    {
      name: 'apps_close',
      description: 'Close/quit a running desktop application on the user\'s own machine.',
      input_schema: { type: 'object', properties: { name: { type: 'string', description: 'App name (friendly names ok).' } }, required: ['name'] },
      run: async ({ name }, ctx) => { try { return await closeApp(name, ctx); } catch (e) { return { say: `Sorry — ${e.message}`, error: e.message }; } },
    },
    {
      name: 'apps_list',
      description: 'List applications/processes currently running on this machine.',
      input_schema: { type: 'object', properties: {} },
      run: async () => { try { return await listApps(); } catch (e) { return { say: `Sorry — ${e.message}`, error: e.message }; } },
    },
  ],
  _internals: { sanitizeName, resolveCandidates, exeForTaskkill, ALIASES },
};
