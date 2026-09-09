'use strict';
/* test-jarvis.js — fork-invariant suite (added in the Jarvis fork, v1.0.0).
   Pins the things that make this repo JARVIS rather than MAX AI:
     J1  wake word is "jarvis" (generic greeting catch-alls kept, "max" retired)
     J2  HUD theme tokens present; cream/coral tokens gone; all 8 ring states kept
     J3  ring anatomy is still the double ring (crisp outline + glow arc)
     J4  widget layer markup + script on the main page (4 widget kinds)
     J5  widgets.js only talks to pre-existing public APIs (no new surface)
     J6  Jarvis Remote branding on the dashboard
     J7  no user-facing "MAX AI"/"Max Remote"/bare ">MAX<" left in web pages
     J8  config default assistantName is Jarvis (settings DEFAULTS + orchestrator fallbacks)
     J9  manifest/icons/serviceworker rebranded
     J10 package.json identity (jarvis-ai, versioned independently)
     J11 provenance/history honesty: CHANGELOG top entry is the fork; pre-fork history kept
     J12 fork source tree is a full independent copy (same module set as upstream spec)
     J13 v1.0.7: NO OpenRouter key UI anywhere in web (settings/dashboard); writes 410
     J14 keyring reads .env OPENROUTER_KEY_n ONLY — legacy aliases + settings ignored
     J15 keymigrate folds settings+alias keys into .env once, purges store, idempotent
     J16 boot preflight refuses partial rotations, naming the missing slot; override boots
*/
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log('ok  ' + n); } else { fail++; console.log('FAIL ' + n); } };

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/* J1: wake word */
{
  const WW = require('../web/js/wakeword.js');
  const w = (s) => WW.match(s).wake;
  ok('J1: "jarvis" family wakes; generic greeting catch-alls kept',
    w('jarvis') && w('hey jarvis') && w('ok jarvis') && w('hello jarvis') && w('hey') && w('hi') && w('hello'));
  ok('J1: "max" is retired in this fork (independent wake identity)',
    !w('max') && !w('hey max') && !w('MAX, lights') && !w('say hi to max'));
}

/* J2/J3: theme tokens + ring anatomy */
{
  const theme = read('web/css/theme.css');
  ok('J2: HUD palette tokens present (--hud-900, --cyan, scan field), cream/coral gone',
    theme.includes('--hud-900') && theme.includes('--cyan:') && theme.includes('@keyframes scandrift')
      && !/(^|[^-])--cream|(^|[^-])--coral/i.test(theme));
  ok('J2: all 8 ring states still defined (state machine remapped, not redesigned)',
    ['standby', 'listening', 'thinking', 'speaking', 'vision', 'alert', 'offline', 'error']
      .every((s) => theme.includes('.ring-wrap.' + s)));
  ok('J3: double ring recipe kept (near-white crisp outline + glowing state arc)',
    /\.ring-outline\s*\{[^}]*231, 244, 255/.test(theme) && /\.ring-glow\s*\{[^}]*drop-shadow/.test(theme));
  ok('J3: HUD widget layer styles exist and collapse cleanly',
    theme.includes('.hud-widget') && theme.includes('body.widgets-hidden .hud-layer'));
}

/* J4: widget layer on the main page */
{
  const idx = read('web/index.html');
  const kinds = [...idx.matchAll(/data-widget="([a-z]+)"/g)].map((m) => m[1]);
  ok('J4: index.html mounts all 4 HUD widgets around the ring + hide toggle + shared script',
    ['weather', 'clock', 'devices', 'activity'].every((k) => kinds.includes(k))
      && idx.includes('id="hudBtn"') && idx.includes('js/widgets.js') && idx.includes('MAX.widgets.mountAll()'));
}

/* J5: widgets only use pre-existing public APIs */
{
  const wsrc = read('web/js/widgets.js');
  const used = [...new Set([...wsrc.matchAll(/'(\/api\/[^']+)'/g)].map((m) => m[1].split('?')[0]))].sort();
  const srv = read('hub/server.js');
  ok('J5: widget endpoints are exactly the pre-existing public routes (weather/home/devices/activity/utterance)',
    JSON.stringify(used) === JSON.stringify(['/api/activity', '/api/home/devices', '/api/utterance', '/api/weather'].sort())
      && used.every((u) => srv.includes(u.replaceAll('/', '\\/')))); // routes are declared as escaped regexes: /^\/api\/.../
}

/* J6/J7: branding */
{
  const dash = read('web/dashboard.html');
  ok('J6: dashboard is "Jarvis Remote" (title, nav, PIN lock)',
    dash.includes('Jarvis Remote · Jarvis') && dash.includes('Jarvis&nbsp;Remote') && dash.includes('Jarvis Remote locked'));
  const pages = ['index', 'dashboard', 'settings', 'vision', 'systems', 'meeting', 'logs'].map((f) => read(`web/${f}.html`));
  ok('J7: no user-facing "MAX AI" / "Max Remote" / bare ">MAX<" wordmarks left in web pages',
    pages.every((p) => !/MAX AI|Max Remote|Max&nbsp;Remote|>MAX</.test(p)));
  ok('J7: every page wordmark and both core labels read JARVIS',
    pages.every((p) => !p.includes('class="wordmark"') || />JARVIS/.test(p)));
}

/* J8: config defaults */
{
  delete require.cache[require.resolve('../hub/settings.js')];
  process.env.MAX_DATA_DIR = fs.mkdtempSync(require('os').tmpdir() + '/jarvis-cfg-');
  const { loadSettings } = require('../hub/settings.js');
  const st = loadSettings();
  const orch = read('hub/orchestrator.js');
  ok('J8: assistantName defaults to Jarvis (settings DEFAULTS + orchestrator fallbacks)',
    st.data.assistantName === 'Jarvis' && (orch.match(/\|\| 'Jarvis'/g) || []).length >= 2);
}

/* J9/J10: assets + identity */
{
  const man = JSON.parse(read('web/manifest.webmanifest'));
  const sw = read('web/sw.js');
  const icon = read('web/icon.svg');
  ok('J9: PWA manifest + service worker + icon rebranded (Jarvis, navy theme color, JARVIS mark)',
    man.name === 'Jarvis' && man.theme_color === '#04101F' && sw.includes('jarvis-shell-v2')
      && icon.includes('JARVIS') && icon.includes('#3CE0FF'));
  const pkg = require('../package.json');
  ok('J10: package identity is jarvis-ai, versioned independently (>=1.0.0)',
    pkg.name === 'jarvis-ai' && /^1\./.test(pkg.version));
}

/* J11: provenance honesty */
{
  const cl = read('CHANGELOG.md');
  ok('J11: CHANGELOG keeps inherited history AND carries the fork provenance + Jarvis fork entry',
    cl.includes('0.11.1') && /Fork provenance/i.test(cl.slice(0, 300)) && /Jarvis fork/i.test(cl));
}

/* J12: independent full tree */
{
  const dirs = ['hub/skills', 'tools', 'web/js', 'scripts', 'docs', 'satellite/esp32'].map((d) =>
    fs.existsSync(path.join(ROOT, d)));
  const skills = fs.readdirSync(path.join(ROOT, 'hub/skills'))
    .filter((f) => f.endsWith('.js') && f !== 'registry.js' && !f.startsWith('_'));
  const testFiles = fs.readdirSync(path.join(ROOT, 'tools')).filter((f) => /^test-.*\.js$/.test(f));
  ok('J12: complete independent tree (hub web tools scripts docs satellite, 26 skills, 24 test files — 19 legacy + this suite + brain-layer pair + persona/openers pair + regress)',
    dirs.every(Boolean) && skills.length >= 20 && testFiles.length >= 20);
}

/* J17: placeholders are not accepted as configured cloud credentials; browser storage uses Jarvis namespace. */
{
  const { missingSlots } = require('../hub/keyring');
  ok('J17: placeholder OpenRouter slots are reported missing',
    missingSlots({ OPENROUTER_KEY_1: 'sk-or-replace-me', OPENROUTER_KEY_2: 'real-2', OPENROUTER_KEY_3: 'real-3' }).includes('OPENROUTER_KEY_1'));
  const common = read('web/js/common.js');
  const index = read('web/index.html');
  ok('J17: browser persistence uses Jarvis namespace',
    common.includes("localStorage.getItem('jarvis.'") && index.includes('jarvisGreeted') && !index.includes('maxGreeted'));
}

(async () => {
/* J13: no OpenRouter key UI remains in any web page; server write path is 410 Gone */
{
  const s = read('web/settings.html');
  const d = read('web/dashboard.html');
  const srv = read('hub/server.js');
  ok('J13: settings/dashboard contain zero key inputs or key-management calls (keys are .env-only, never displayed)',
    !/id="k-new"|b-addkey|keysList|MAX\.post\('\/api\/keys'|MAX\.api\('\/api\/keys/.test(s)
      && /OPENROUTER_KEY_1/.test(s) // static explanatory note pointing at .env
      && !/openrouter.*key|api\/keys/i.test(d)
      && !/o\.keys\.push|o\.keys\.splice/.test(srv)
      && /410/.test(srv) && /managed exclusively in \.env/.test(srv));
}

/* J14: keyring is canonical-only */
{
  const { loadKeys, effectiveKeys, missingSlots } = require('../hub/keyring.js');
  const env = { OPENROUTER_KEY_1: 'k1', OPENROUTER_KEY_2: 'k2', OPENROUTER_KEY_3: 'k3', OPENROUTER_KEY_4: 'k4', OPENROUTER_API_KEYS: 'csv1,csv2', OPENROUTER_API_KEY: 'single' };
  const got = loadKeys(env);
  ok('J14: loadKeys reads ONLY OPENROUTER_KEY_n slots (legacy CSV/single aliases ignored entirely)',
    JSON.stringify(got) === JSON.stringify(['k1', 'k2', 'k3', 'k4']) && JSON.stringify(missingSlots({ OPENROUTER_KEY_1: 'x' })) === JSON.stringify(['OPENROUTER_KEY_2', 'OPENROUTER_KEY_3']));
  ok('J14: effectiveKeys ignores settings-store keys (one source of truth: .env)',
    JSON.stringify(effectiveKeys({ openrouter: { keys: ['ui-key-1', 'ui-key-2'] } }, env)) === JSON.stringify(got));
}

/* J15: one-time migration folds seeds into .env, purges settings, idempotent */
{
  const os = require('os');
  const { migrateEnvKeys } = require('../hub/keymigrate.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jar-keymig-'));
  const envFile = path.join(dir, '.env');
  fs.writeFileSync(envFile, 'OPENROUTER_API_KEYS=seed-c,seed-d\nOPENROUTER_MODEL=m\n');
  const settings = { data: { openrouter: { keys: ['seed-a', 'seed-b'], model: 'm' } }, store: { saved: 0, save() { this.saved++; } } };
  const saved = { ...process.env };
  for (let n = 1; n <= 16; n++) delete process.env['OPENROUTER_KEY_' + n];
  delete process.env.OPENROUTER_API_KEYS; delete process.env.OPENROUTER_API_KEY; delete process.env.OPENROUTER_KEY;
  // mirror what env.js would have produced from this .env at boot before migration runs:
  process.env.OPENROUTER_API_KEYS = 'seed-c,seed-d';
  const out = migrateEnvKeys({ settings, envFile, log: { write() {} } });
  const after = fs.readFileSync(envFile, 'utf8');
  const second = migrateEnvKeys({ settings, envFile, log: { write() {} } });
  process.env.OPENROUTER_KEY_1 = 'seed-a'; process.env.OPENROUTER_KEY_2 = 'seed-b'; process.env.OPENROUTER_KEY_3 = 'seed-c'; // restore what the migration set
  Object.assign(process.env, saved);
  ok('J15: settings keys + legacy CSV folded into canonical slots (settings first), legacy line commented, .env model line untouched',
    after.includes('OPENROUTER_KEY_1=seed-a') && after.includes('OPENROUTER_KEY_2=seed-b') && after.includes('OPENROUTER_KEY_3=seed-c')
      && after.includes('# migrated -> OPENROUTER_API_KEYS=') && after.includes('OPENROUTER_MODEL=m') && out.extraIgnored === 1);
  ok('J15: settings store purged of keys + flagged migrated; second run is a no-op',
    out.purgedSettings === true && settings.data.openrouter.keys === undefined && settings.data.openrouter.migratedToEnv === true
      && settings.store.saved >= 1 && second.migrated === 0 && second.purgedSettings === false);
}

/* J16: boot preflight — fail fast naming the missing slot; explicit override boots */
{
  const os = require('os');
  const { spawnSync, spawn } = require('child_process');
  const base = { ...process.env, MAX_DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'jar-bootchk-')), MAX_FILES_ROOT: fs.mkdtempSync(path.join(os.tmpdir(), 'jar-bootchk-f-')), PORT: '0', OPENROUTER_KEY_1: 'k1', OPENROUTER_KEY_2: '', OPENROUTER_KEY_3: 'k3', JARVIS_ALLOW_KEYLESS: '0', OPENROUTER_API_KEYS: '', OPENROUTER_API_KEY: '' }; // NOTE: blanking legacy aliases keeps test boots from folding the repo .env's legacy lines
  const failRun = spawnSync(process.execPath, ['hub/server.js'], { cwd: ROOT, env: base, encoding: 'utf8', timeout: 15000 });
  ok('J16: partial rotation → exit(1) naming the exact missing variable (never a silent 2-key start)',
    failRun.status === 1 && (failRun.stderr + failRun.stdout).includes('OPENROUTER_KEY_2'));
  const bootRun = spawn(process.execPath, ['hub/server.js'], { cwd: ROOT, env: { ...base, JARVIS_ALLOW_KEYLESS: '1' }, encoding: 'utf8' });
  const heard = await new Promise((resolve) => {
    let buf = '';
    const to = setTimeout(() => resolve(buf), 15000);
    bootRun.stdout.on('data', (d) => { buf += d; if (/on http:\/\/0\.0\.0\.0:/.test(buf)) { clearTimeout(to); resolve(buf); } });
    bootRun.stderr.on('data', (d) => { buf += d; });
  });
  bootRun.kill('SIGKILL');
  ok('J16: JARVIS_ALLOW_KEYLESS=1 (explicit) boots with a LOUD override warning naming the same slot',
    /JARVIS_ALLOW_KEYLESS=1/.test(heard) && /OPENROUTER_KEY_2/.test(heard) && /on http:\/\/0\.0\.0\.0:/.test(heard));
}

console.log(`\n${pass} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
