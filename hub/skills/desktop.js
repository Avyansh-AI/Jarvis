'use strict';
/** Desktop — file management under a jailed root. THE strictest skill in the
 *  system: `sensitive: true` (every call, including reads, requires a fresh
 *  voice-verified token — see the orchestrator gate), all paths jailed to
 *  MAX_FILES_ROOT (default <repo>/files), per-op size caps, no execution of
 *  any kind, and symlink-escape defense. Write ops mutate state, so the
 *  Round-5 trust rules also park them after any untrusted read. */
const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.resolve(process.env.MAX_FILES_ROOT || path.join(__dirname, '..', '..', 'files'));
const MAX_READ = 256 * 1024, MAX_WRITE = 64 * 1024, MAX_LIST = 500;
try { fs.mkdirSync(ROOT_DIR, { recursive: true }); } catch {}

const BAD = /(^|[\\/])\.\.([\\/]|$)|\0/;
function join(name) {
  const rel = String(name || '').replace(/^[\\/]+/, '');
  if (BAD.test(rel) || rel.length > 200) return null;
  const p = path.resolve(ROOT_DIR, rel);
  if (p !== ROOT_DIR && !p.startsWith(ROOT_DIR + path.sep)) return null;
  return p;
}
function realJoin(name) { // symlink-escape defense: resolve through the real fs
  const p = join(name);
  if (!p) return null;
  const rootReal = fs.realpathSync(ROOT_DIR);
  try {
    const real = fs.realpathSync(p);
    if (real !== ROOT_DIR && !real.startsWith(rootReal + path.sep)) return null;
    return p;
  } catch {
    // target doesn't exist yet (write path): the nearest EXISTING ancestor must
    // still be real-safe, so a pre-planted symlinked dir can't redirect the write
    let dir = path.dirname(p);
    while (dir !== ROOT_DIR && dir.startsWith(ROOT_DIR + path.sep)) {
      try {
        if (!fs.realpathSync(dir).startsWith(rootReal)) return null;
        return p;
      } catch { dir = path.dirname(dir); }
    }
    return p; // directly under ROOT_DIR, which is known-real
  }
}
const clean = (s, n) => String(s == null ? '' : s).slice(0, n);
const txt = (p) => {
  const st = fs.statSync(p);
  if (st.size > MAX_READ) return { error: `file too big (${Math.round(st.size / 1024)} KB > ${MAX_READ / 1024} KB cap)` };
  return { text: fs.readFileSync(p, 'utf8').slice(0, MAX_READ) };
};

async function op(action, params) {
  const { name = '', to = '', content = '' } = params || {};
  const p = realJoin(name);
  if (!p) return { error: 'path refused — files stay inside the files folder' };
  try {
    switch (action) {
      case 'list': {
        const dir = fs.existsSync(p) && fs.statSync(p).isDirectory() ? p : ROOT_DIR;
        const ents = fs.readdirSync(dir, { withFileTypes: true }).slice(0, MAX_LIST)
          .map((e) => ({ name: e.name, dir: e.isDirectory(), size: e.isDirectory() ? null : fs.statSync(path.join(dir, e.name)).size }));
        return { path: path.relative(ROOT_DIR, dir) || '.', entries: ents };
      }
      case 'read': return { path: path.relative(ROOT_DIR, p), ...txt(p) };
      case 'write': {
        const data = clean(content, MAX_WRITE);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, data, 'utf8');
        return { ok: true, path: path.relative(ROOT_DIR, p), bytes: Buffer.byteLength(data) };
      }
      case 'mkdir': fs.mkdirSync(p, { recursive: true }); return { ok: true, path: path.relative(ROOT_DIR, p) || '.' };
      case 'rename': {
        const q = realJoin(to);
        if (!q) return { error: 'destination refused — stays inside the files folder' };
        fs.mkdirSync(path.dirname(q), { recursive: true });
        fs.renameSync(p, q);
        return { ok: true, from: path.relative(ROOT_DIR, p), to: path.relative(ROOT_DIR, q) };
      }
      case 'delete': {
        if (p === ROOT_DIR) return { error: 'refusing to delete the whole files folder' };
        fs.rmSync(p, { recursive: false });
        return { ok: true, deleted: path.relative(ROOT_DIR, p) };
      }
      default: return { error: 'unknown file action' };
    }
  } catch (e) { return { error: 'file op failed: ' + (e.code || e.message) }; }
}

const NAME_SCHEMA = { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] };

module.exports = {
  name: 'desktop',
  label: 'Desktop Files',
  description: 'File management inside the jailed files folder (voice-verify required).',
  sensitive: true, // EVERY call needs voice verification — the strictest gate in the system
  _internals: { join, realJoin, ROOT_DIR, MAX_READ, MAX_WRITE }, // test hooks
  tools: [
    {
      name: 'file_manage', sideEffect: 'write',
      description: 'Manage files in the user\'s files folder: list/read/write/mkdir/rename/delete. Never executes anything.',
      input_schema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'read', 'write', 'mkdir', 'rename', 'delete'] },
          name: { type: 'string' }, to: { type: 'string' }, content: { type: 'string' },
        },
        required: ['action'],
      },
      run: async (args) => op(args.action, args),
    },
    { name: 'file_read', sideEffect: 'read', description: 'Read a text file from the files folder (capped).', input_schema: NAME_SCHEMA, run: async ({ name }) => op('read', { name }) },
    { name: 'file_list', sideEffect: 'read', description: 'List the files folder (optionally a subfolder).', input_schema: { type: 'object', properties: { name: { type: 'string' } } }, run: async ({ name }) => op('list', { name: name || '.' }) },
  ],
  intents: [
    {
      patterns: [/^list (my )?files$/i, /^what'?s in my files$/i],
      run: async (m, text, ctx) => {
        if (!ctx.verified) return { verify: true, say: 'File access is sensitive — please verify your voice first.' };
        const out = await op('list', {});
        if (out.error) return { say: out.error };
        const files = out.entries.filter((e) => !e.dir).length;
        return { say: out.entries.length ? `${out.entries.length} item(s) in your files — ${files} file(s).` : 'Your files folder is empty.', data: out };
      },
    },
  ],
};
