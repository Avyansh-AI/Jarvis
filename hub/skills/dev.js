'use strict';
/**
 * Developer mode — explain repo files and run a small whitelist of safe,
 * sandboxed commands (no shell, no network, hard timeout, cwd jailed to repo).
 * In "hacking mode" (see orchestrator), LAN-scoped probes (nmap/ping against
 * private targets only) unlock for authorized security research on your own
 * network and lab machines.
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.normalize(path.join(__dirname, '..', '..'));
const ALLOWED = { ls: true, cat: true, echo: true, date: true, uptime: true, head: true, tail: true, wc: true, node: true };

/* Hacking-mode extras: network probes, STRICTLY limited to your own LAN/lab.
   Only RFC1918/loopback targets, only safe flag forms, hard timeouts. */
const LAB_BINS = { nmap: true, ping: true };
const PRIVATE_TARGET = /^(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}(?:\/(?:[12]?\d|3[0-2]))?|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}(?:\/(?:1[6-9]|2\d|3[0-2]))?|192\.168\.\d{1,3}\.\d{1,3}(?:\/(?:1[6-9]|2\d|3[0-2]))?|127\.\d{1,3}\.\d{1,3}\.\d{1,3}|localhost)$/;

function labCheck(bin, parts) {
  if (bin === 'ping') {
    if (parts[0] !== '-c' || !(parseInt(parts[1], 10) >= 1 && parseInt(parts[1], 10) <= 5)) {
      return 'in hacking mode ping is limited to: ping -c <1-5> <private-target>';
    }
    return PRIVATE_TARGET.test(parts[2] || '') ? null : 'ping targets must be private (your LAN/loopback) — 10.x, 172.16-31.x, 192.168.x, localhost.';
  }
  if (bin === 'nmap') {
    const joined = parts.join(' ');
    if (!/^-sn\s+\S+$/.test(joined) && !/^-sV --top-ports \d{1,3}\s+\S+$/.test(joined)) {
      return 'in hacking mode nmap is limited to: nmap -sn <lan>  |  nmap -sV --top-ports <1-100> <private-host>';
    }
    const tp = joined.match(/--top-ports (\d+)/);
    if (tp && parseInt(tp[1], 10) > 100) return 'top-ports is capped at 100';
    const target = joined.split(/\s+/).pop();
    return PRIVATE_TARGET.test(target) ? null : 'nmap targets must be private (your LAN/loopback) only.';
  }
  return 'not a lab command';
}

/** Paths the sandbox must never read — secrets/live data inside ROOT. */
const PROTECTED_RE = /(^|[\\/])\.env($|[.:\\/])|(^|[\\/])data($|[\\/])|\.master\.key($|[\\/])/i;

function safeJoin(rel) {
  const p = path.normalize(path.join(ROOT, rel || '.'));
  if (!p.startsWith(ROOT)) throw new Error('path escapes the repo — not allowed');
  if (rel && PROTECTED_RE.test(p)) throw new Error('that path is protected (secrets/live data) — not readable');
  return p;
}

/* Static (belt) + runtime (suspenders) guard for `node -e`:
   the prelude runs first in the child and neuters dangerous capabilities,
   then Node's --experimental-permission gives the kernel floor beneath it. */
const SANDBOX_READ_DIRS = ['hub', 'web', 'tools', 'docs', 'satellite', 'scripts']
  .map((d) => '--allow-fs-read=' + path.join(ROOT, d));
const SANDBOX_SCAN = /\bimport\s*\(|require\s*\(\s*[`'"]+(?:node:)?(?:child_process|http|https|net|tls|dgram|dns|cluster|worker_threads|v8|inspector)[`'"]|process\.(?:binding|dlopen|env)/i;
const SANDBOX_PRELUDE = [
  "const Module=require('module');const _load=Module._load;",
  "const BLOCKED=new Set(['child_process','http','https','net','tls','dgram','dns','cluster','worker_threads','v8','inspector'].flatMap(m=>[m,'node:'+m]));",
  "const GUARD=/(^|[\\/\\\\])\\.env($|[\\/\\\\.])|\\.master\\.key$|[\\/\\\\]data[\\/\\\\]/i;",
  "Module._load=function(request,parent,isMain){",
  "  if(BLOCKED.has(request))throw new Error('module blocked in sandbox: '+request);",
  "  const m=_load.call(this,request,parent,isMain);",
  "  if(request==='fs'||request==='node:fs'||request==='fs/promises'||request==='node:fs/promises'){",
  "    try{const wrap=(fn)=>typeof fn==='function'?function(p,...a){if(GUARD.test(String(p)))throw new Error('path protected in sandbox: '+p);return fn.call(this,p,...a);}:fn;",
  "      ['readFileSync','readFile','readFileSync','readdirSync','writeFileSync','createReadStream','open','openSync'].forEach(k=>{if(k in m)m[k]=wrap(m[k]);});",
  "      if(m.promises){for(const k of ['readFile','readdir','writeFile','open']){if(k in m.promises)m.promises[k]=wrap(m.promises[k]);}}",
  "    }catch{}",
  "  }",
  "  return m;",
  "};",
  "Object.defineProperty(process,'binding',{get(){throw new Error('process.binding blocked in sandbox');}});",
  "Object.defineProperty(process,'dlopen',{get(){throw new Error('process.dlopen blocked in sandbox');}});",
].join('\n');

function runSafe(command, ctx, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const raw = String(command).trim();
    const parts = raw.split(/\s+/).filter(Boolean);
    const bin = parts.shift();
    if (!ALLOWED[bin]) {
      if (LAB_BINS[bin] && ctx && ctx.mode === 'security') {
        const err = labCheck(bin, parts);
        if (err) { resolve({ ok: false, output: err }); return; }
        timeoutMs = bin === 'nmap' ? 45000 : 8000;
      } else if (LAB_BINS[bin]) {
        resolve({ ok: false, output: `"${bin}" unlocks in hacking mode — say "go hacking" first (LAN/lab targets only).` });
        return;
      } else {
        resolve({ ok: false, output: `"${bin}" isn't whitelisted. Allowed: ${Object.keys(ALLOWED).join(', ')}.` });
        return;
      }
    }
    let args;
    if (bin === 'node') {
      // `node -e "..."` only — the whole tail is the script, size-limited, scan + prelude hardened,
      // PLUS a real kernel floor: Node's permission model (fs allow-list, no writes, no spawn).
      const m = raw.match(/^node\s+-e\s+([\s\S]+)$/);
      let script = m && m[1] ? m[1].trim() : '';
      if (/^(['"]).*\1$/s.test(script)) script = script.slice(1, -1); // strip one surrounding quote pair
      if (!script || script.length > 2000) { resolve({ ok: false, output: 'Only `node -e "<script>"` (≤2000 chars) is allowed.' }); return; }
      if (SANDBOX_SCAN.test(script)) { resolve({ ok: false, output: 'That script pattern is blocked in the sandbox (network/child-process/import/process internals).' }); return; }
      args = [
        '--experimental-permission', '--no-warnings',
        ...SANDBOX_READ_DIRS,
        '-e', SANDBOX_PRELUDE + '\n' + script,
      ];
    } else {
      args = parts.map((a) => (a.includes('..') ? a : a)).slice(0, 6);
      if (bin === 'cat' || bin === 'head' || bin === 'tail' || bin === 'wc' || bin === 'ls') {
        try { if (args[0]) safeJoin(args[0]); } catch (e) { resolve({ ok: false, output: e.message }); return; }
      }
    }
    // Keep secrets out of the child, but preserve PATH so allowlisted binaries can be found.
    const child = spawn(bin, args, { cwd: ROOT, env: { PATH: process.env.PATH || '' }, timeout: timeoutMs });
    let out = '';
    const cap = (d) => { if (out.length < 4000) out += d; };
    child.stdout.on('data', cap);
    child.stderr.on('data', cap);
    child.on('error', (e) => resolve({
      ok: false,
      output: e.code === 'ENOENT'
        ? `"${bin}" isn't installed on this machine. Install it (e.g. \`sudo apt install ${bin}\` / \`winget install ${bin}\`) and try again.`
        : e.message,
    }));
    child.on('close', (code) => resolve({ ok: code === 0, output: out || `(exit ${code})` }));
  });
}

function explainFile(rel) {
  const file = safeJoin(rel);
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new Error(`no such file: ${rel}`);
  const src = fs.readFileSync(file, 'utf8');
  const lines = src.split('\n').length;
  const header = src.split('\n').slice(0, 12).filter((l) => /^\s*(\/\*\*?|\*|\/\/)/.test(l)).map((l) => l.replace(/^\s*\/\**\s?|\s*\*\/$/g, '').replace(/^\s*\*\s?/, '').replace(/^\s*\/\/\s?/, '')).filter(Boolean).join(' ');
  const funcs = (src.match(/function\s+\w+|const\s+\w+\s*=\s*(?:async\s*)?\(|^\s+(?:async\s+)?\w+\(/gm) || []).slice(0, 8).map((s) => s.trim().slice(0, 60));
  return {
    say: header ? `${rel}: ${header} It has about ${lines} lines.` : `${rel} is about ${lines} lines with ${funcs.length} functions.`,
    cards: [{ title: rel, lines: [`${lines} lines`, ...funcs] }],
  };
}

module.exports = {
  name: 'dev',
  _runSafe: runSafe, _labCheck: labCheck, // exported for offline tests
  label: 'Developer Mode',
  description: 'Explain code in the repo and run whitelisted sandboxed commands.',
  kidBlocked: true,
  intents: [
    {
      patterns: [/\b(read|explain|describe|open)\s+(?:the\s+)?(?:file|code)\s+([\w./-]+)/i, /\bexplain\s+([\w./-]+\.js)\b/i],
      run: async (m) => {
        const rel = m[2] || m[1];
        try { return explainFile(rel); } catch (e) { return { say: e.message }; }
      },
    },
    {
      patterns: [/\brun\s+(.+)/i, /\bexecute\s+(.+)/i],
      run: async (m, text, ctx) => {
        const r = await runSafe(m[1], ctx);
        const short = r.output.length > 300 ? r.output.slice(0, 300) + '…' : r.output;
        return { say: r.ok ? `Ran it. Output: ${short}` : `It failed: ${short}`, data: r };
      },
    },
    {
      patterns: [/\blist (the )?(skills|plugins|modules)\b/i],
      run: async (m, text, ctx) => {
        const files = fs.readdirSync(path.join(__dirname)).filter((f) => f.endsWith('.js') && !f.startsWith('_') && f !== 'registry.js');
        return { say: `${files.length} skill modules installed: ${files.map((f) => f.replace('.js', '')).join(', ')}.` };
      },
    },
  ],
  tools: [
    {
      name: 'repo_explain',
      description: 'Summarize a source file in the Jarvis repo.',
      input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      run: async ({ path: rel }) => { try { return explainFile(rel); } catch (e) { return { say: e.message }; } },
    },
    {
      name: 'run_command',
      description: 'Run a whitelisted read-only command in the repo sandbox (ls, cat, head, tail, wc, node -e ...). In hacking mode also: nmap -sn / -sV and ping -c, private targets only.',
      input_schema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
      run: async ({ command }, ctx) => {
        const r = await runSafe(command, ctx);
        return { say: r.ok ? `Output: ${r.output.slice(0, 250)}` : `Failed: ${r.output.slice(0, 250)}`, data: r };
      },
    },
  ],
};
