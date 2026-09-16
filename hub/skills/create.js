'use strict';
/** Create — makes real files on request: PDFs (built-in, zero-dependency pure
 *  Node writer), Word docs (python-docx when present — optional OS package,
 *  NOT an API key), slide decks (python-pptx when present, otherwise a
 *  self-contained HTML deck), and simple static websites (served at /sites/).
 *  Interpreter detection spans python3/python/py so the same story is true on
 *  Windows as on Linux; every degraded path still delivers a file AND says
 *  exactly what to install — never a silent failure. `status()` reports the
 *  live capability set in Settings → Skills.
 *  All output lands in the jailed files folder (see desktop skill). No paid
 *  API of any kind. The LLM brain supplies the words; this module renders. */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT_DIR = path.resolve(process.env.MAX_FILES_ROOT || path.join(__dirname, '..', '..', 'files'));
try { fs.mkdirSync(path.join(ROOT_DIR, 'sites'), { recursive: true }); } catch {}

/* ---------- pure-Node PDF (text, Helvetica, multi-page) ---------- */
const pdfEsc = (s) => String(s).replace(/[^\x20-\x7E]/g, '?').replace(/([\\()])/g, '\\$1');
function wrapText(text, width) {
  const words = String(text || '').split(/\s+/).filter(Boolean);
  const lines = []; let cur = '';
  for (const w of words) {
    if ((cur + ' ' + w).trim().length > width) { lines.push(cur.trim()); cur = w; } else cur += ' ' + w;
  }
  if (cur.trim()) lines.push(cur.trim());
  return lines.length ? lines : [' '];
}
function makePdf(title, paragraphs) {
  const LINES_PER_PAGE = 44;
  const lines = [];
  for (const p of paragraphs) { wrapText(p, 88).forEach((l) => lines.push(l)); lines.push(' '); }
  if (!lines.length) lines.push(' ');
  const pages = [];
  for (let i = 0; i < lines.length; i += LINES_PER_PAGE) pages.push(lines.slice(i, i + LINES_PER_PAGE));

  const objs = [];
  objs[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objs[2] = null; // pages tree (filled after page ids known)
  objs[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
  const kids = [];
  pages.forEach((pageLines) => {
    const pageId = objs.length + 1, contentId = objs.length + 2;
    const content = 'BT /F1 20 Tf 72 740 Td (' + pdfEsc(title) + ') Tj ET\n' +
      'BT /F1 11 Tf 72 712 Td 16 TL\n' + pageLines.map((l) => '(' + pdfEsc(l) + ') Tj T*').join('\n') + '\nET';
    objs[pageId] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentId} 0 R >>`;
    objs[contentId] = `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`;
    kids.push(`${pageId} 0 R`);
  });
  objs[2] = `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${kids.length} >>`;

  let out = '%PDF-1.4\n'; const offsets = [0];
  for (let i = 1; i < objs.length; i++) { offsets[i] = Buffer.byteLength(out, 'latin1'); out += `${i} 0 obj\n${objs[i]}\nendobj\n`; }
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objs.length}\n0000000000 65535 f \n`;
  for (let i = 1; i < objs.length; i++) out += String(offsets[i]).padStart(10, '0') + ' 00000 n \n';
  out += `trailer\n<< /Size ${objs.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(out, 'latin1');
}

/* ---------- optional python docx/pptx (detected at call time) ----------
 * Interpreter discovery, desktop-assistant full parity: on Windows `python3`
 * may be absent (python.exe / the `py -3` launcher are the norm) or, worse, a
 * Microsoft-Store alias STUB that just prints a message. Candidates are
 * therefore validated by actually running `import sys` — a stub can't hijack
 * generation. MAX_PY_CREATE=<path> forces an exact interpreter (documented
 * test/dev hook, same spirit as MAX_NET_PROBE_URL).
 * Fallback contract — a user never meets a silent failure: no interpreter or
 * no library still produces a usable artifact (Markdown / HTML deck) plus one
 * honest line naming EXACTLY what to install; a crash mid-generation surfaces
 * the last error line too, never just a shrug. */
const PY_CANDIDATES = [['python3', []], ['python', []], ['py', ['-3']]];
const PY_TTL = 30000; // cache detection 30 s for the Settings/health surface; forced hooks never cache
let _pyCache = { at: 0, bin: null };
const _hasCache = new Map();

function pyBin() {
  const forced = process.env.MAX_PY_CREATE;
  if (forced) {
    try { return spawnSync(forced, ['-c', 'import sys'], { timeout: 8000 }).status === 0 ? [forced, []] : null; }
    catch { return null; }
  }
  if (Date.now() - _pyCache.at < PY_TTL) return _pyCache.bin;
  _pyCache.at = Date.now(); _pyCache.bin = null;
  for (const [cmd, pre] of PY_CANDIDATES) {
    let r; try { r = spawnSync(cmd, [...pre, '-c', 'import sys'], { timeout: 8000 }); } catch { continue; }
    if (r && r.status === 0) { _pyCache.bin = [cmd, pre]; break; }
  }
  return _pyCache.bin;
}
function pyHas(mod) {
  const bin = pyBin();
  if (!bin) return false;
  const forced = !!process.env.MAX_PY_CREATE;
  if (!forced) { const hit = _hasCache.get(mod); if (hit && Date.now() - hit.at < PY_TTL) return hit.v; }
  let r; try { r = spawnSync(bin[0], [...bin[1], '-c', `import ${mod}`], { timeout: 8000 }); } catch { r = null; }
  const v = !!(r && r.status === 0);
  if (!forced) _hasCache.set(mod, { at: Date.now(), v });
  return v;
}
const pythonMake = (kind, spec, outPath) => pyRun(kind, spec, outPath).ok; // kept: existing _internals consumers

function pyRun(kind, spec, outPath) {
  const lib = kind === 'docx' ? 'docx' : 'pptx';
  const bin = pyBin();
  if (!bin) return { ok: false, why: 'no-python', lib };
  if (!pyHas(lib)) return { ok: false, why: 'no-lib', lib };
  const script = `
import sys, json
spec = json.loads(sys.argv[1])
if '${kind}' == 'docx':
    from docx import Document
    d = Document()
    d.add_heading(spec['title'], level=0)
    for p in spec['paragraphs']: d.add_paragraph(p)
    d.save(sys.argv[2])
else:
    from pptx import Presentation
    from pptx.util import Inches
    prs = Presentation()
    prs.slides.add_slide(prs.slide_layouts[0]).shapes.title.text = spec['title']
    for s in spec['slides']:
        sl = prs.slides.add_slide(prs.slide_layouts[1])
        sl.shapes.title.text = s.get('title', '')
        tf = sl.placeholders[1].text_frame
        for i, b in enumerate(s.get('bullets', [])):
            (tf.paragraphs[0] if i == 0 else tf.add_paragraph()).text = b
    prs.save(sys.argv[2])
print('ok')`;
  let r; try { r = spawnSync(bin[0], [...bin[1], '-c', script, JSON.stringify(spec), outPath], { timeout: 20000 }); } catch { r = null; }
  if (!r || r.status !== 0) {
    const last = String((r && r.stderr) || '').trim().split('\n').filter(Boolean).pop() || '';
    return { ok: false, why: 'gen-failed', lib, detail: last.slice(0, 160) };
  }
  if (!fs.existsSync(outPath) || fs.statSync(outPath).size === 0) return { ok: false, why: 'gen-failed', lib, detail: 'interpreter exited cleanly but produced no file' };
  return { ok: true, lib };
}
function pyNote(res) {
  if (res.why === 'no-python') return 'Python 3 not found (tried python3/python/py) — install it, then `pip install python-docx python-pptx`, for real Word/PowerPoint files. Made a fallback file instead — content is complete, format differs.';
  if (res.why === 'no-lib') return `python-${res.lib} not installed — \`pip install python-${res.lib}\` enables the real ${res.lib === 'docx' ? 'Word' : 'PowerPoint'} file. Made a fallback file instead — content is complete, format differs.`;
  return `python-${res.lib} failed while creating the file${res.detail ? ': ' + res.detail : ''}. Made a fallback file instead — content is complete, format differs.`;
}
/* one-liner for Settings → Skills (capability surface; cached, never throws) */
function statusLine() {
  try {
    if (!pyBin()) return 'Word/PPTX: portable fallback — no Python 3 found (PDF is built-in)';
    const d = pyHas('docx'); const p = pyHas('pptx');
    if (d && p) return 'Word + PowerPoint: native (python-docx, python-pptx)';
    if (d) return 'Word: native · PowerPoint: fallback (pip install python-pptx)';
    if (p) return 'PowerPoint: native · Word: fallback (pip install python-docx)';
    return 'Word/PPTX: fallback (pip install python-docx python-pptx)';
  } catch { return null; }
}

/* ---------- websites ---------- */
const slug = (s) => String(s || 'site').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'site';
function makeSite(title, sections) {
  const cards = sections.map((s) => `  <section class="card"><h2>${escHtml(s.heading)}</h2><p>${escHtml(s.text)}</p></section>`).join('\n');
  const dir = path.join(ROOT_DIR, 'sites', slug(title));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.html'), SITE_HTML(title, cards), 'utf8');
  return { dir: path.relative(ROOT_DIR, dir), url: '/sites/' + slug(title) + '/' };
}
function makeHtmlDeck(title, slides) {
  const cards = slides.map((s) => `  <section class="card slide"><h2>${escHtml(s.title || '')}</h2><ul>${(s.bullets || []).map((b) => `<li>${escHtml(b)}</li>`).join('')}</ul></section>`).join('\n');
  const dir = path.join(ROOT_DIR, 'sites', slug(title + '-deck'));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.html'), SITE_HTML(title, `<h1>${escHtml(title)}</h1>\n${cards}`), 'utf8');
  return { dir: path.relative(ROOT_DIR, dir), url: '/sites/' + slug(title + '-deck') + '/', format: 'html' };
}
const escHtml = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const SITE_HTML = (title, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>${escHtml(title)}</title>
<style>
body{font-family:Quicksand,'Segoe UI',system-ui,sans-serif;background:#FBF4E8;color:#33291F;max-width:760px;margin:40px auto;padding:0 18px;line-height:1.55}
h1{color:#E8674C} .card{background:rgba(255,255,255,.75);border:1px solid #D8C7AC;border-radius:14px;padding:18px 20px;margin:14px 0}
.card h2{margin-top:0;color:#D95436} code{background:#F3E7D3;padding:1px 5px;border-radius:5px}
</style></head><body>
<h1>${escHtml(title)}</h1>
${body}
<p><small>made by Jarvis · ${new Date().toISOString().slice(0, 10)}</small></p>
</body></html>`;

const paras = (v) => (Array.isArray(v) ? v : [v]).map((x) => String(x)).slice(0, 200);

/* one render path per artifact — shared by the LLM tools and the voice
   intents, so both tell the same truth about what was made and why. */
function _makeDoc(title, paragraphs) {
  const spec = { title: title || 'Untitled', paragraphs };
  const file = path.join(ROOT_DIR, slug(title) + '.docx');
  const made = pyRun('docx', spec, file);
  if (made.ok) return { ok: true, file: path.basename(file), bytes: fs.statSync(file).size, format: 'docx' };
  const md = path.join(ROOT_DIR, slug(title) + '.md');
  fs.writeFileSync(md, '# ' + spec.title + '\n\n' + spec.paragraphs.join('\n\n') + '\n', 'utf8');
  return { ok: true, file: path.basename(md), format: 'markdown', note: pyNote(made) };
}
function _makeDeck(title, slides) {
  const spec = { title: title || 'Untitled deck', slides };
  const file = path.join(ROOT_DIR, slug(title) + '.pptx');
  const made = pyRun('pptx', spec, file);
  if (made.ok) return { ok: true, file: path.basename(file), bytes: fs.statSync(file).size, format: 'pptx' };
  const out = makeHtmlDeck(spec.title, spec.slides);
  return { ok: true, ...out, format: 'html', note: pyNote(made) };
}

module.exports = {
  name: 'create',
  label: 'Create Files',
  description: 'Make PDFs, Word docs, slide decks and simple websites on request.',
  status: statusLine, // surfaced in Settings → Skills: which Office backends are live right now
  _internals: { makePdf, makeSite, pythonHas: pyHas, wrapText, pyBin, pyRun, pyNote },
  _makeDoc, _makeDeck,
  tools: [
    {
      name: 'create_pdf', sideEffect: 'write',
      description: 'Render a PDF document in the files folder from a title and paragraphs.',
      input_schema: { type: 'object', properties: { title: { type: 'string' }, paragraphs: { type: 'array', items: { type: 'string' } } }, required: ['title', 'paragraphs'] },
      run: async ({ title, paragraphs }) => {
        const file = path.join(ROOT_DIR, slug(title) + '.pdf');
        fs.writeFileSync(file, makePdf(String(title).slice(0, 120), paras(paragraphs)));
        return { ok: true, file: path.relative(ROOT_DIR, file), bytes: fs.statSync(file).size };
      },
    },
    {
      name: 'create_document', sideEffect: 'write',
      description: 'Render a Word .docx when the optional python-docx OS package is present, otherwise a clean Markdown file — always a real file, with an honest one-line note about what was installed or missed.',
      input_schema: { type: 'object', properties: { title: { type: 'string' }, paragraphs: { type: 'array', items: { type: 'string' } } }, required: ['title', 'paragraphs'] },
      run: async ({ title, paragraphs }) => module.exports._makeDoc(String(title).slice(0, 120), paras(paragraphs)),
    },
    {
      name: 'create_deck', sideEffect: 'write',
      description: 'Render a slide deck: real .pptx when python-pptx is installed, otherwise a self-contained HTML deck — always a usable artifact with an honest note.',
      input_schema: {
        type: 'object',
        properties: { title: { type: 'string' }, slides: { type: 'array', items: { type: 'object' } } },
        required: ['title', 'slides'],
      },
      run: async ({ title, slides }) => module.exports._makeDeck(String(title).slice(0, 120), (Array.isArray(slides) ? slides : []).slice(0, 40)),
    },
    {
      name: 'create_website', sideEffect: 'write',
      description: 'Build a simple static website (title + sections) served at /sites/<slug>/.',
      input_schema: {
        type: 'object',
        properties: { title: { type: 'string' }, sections: { type: 'array', items: { type: 'object' } } },
        required: ['title', 'sections'],
      },
      run: async ({ title, sections }) => {
        const secs = (Array.isArray(sections) ? sections : []).slice(0, 24).map((s) => ({ heading: String(s.heading || '').slice(0, 120), text: String(s.text || '').slice(0, 4000) }));
        const out = makeSite(String(title).slice(0, 120), secs);
        return { ok: true, ...out };
      },
    },
  ],
  intents: [
    {
      patterns: [/^(?:make|create|build)(?: me)? a (?:simple )?website (?:about|for|called)\s+(.+)$/i],
      run: async (m) => {
        const out = makeSite(m[1].replace(/[.?!]+$/, ''), [{ heading: 'About', text: 'A quick one-pager made for you. Ask again with more detail and I will fill this in properly.' }]);
        return { say: `Done — your site is at ${out.url} (files under ${out.dir}).`, data: out };
      },
    },
    {
      patterns: [/^(?:make|create)(?: me)? a pdf (?:about|of|called)\s+(.+)$/i],
      run: async (m) => {
        const title = m[1].replace(/[.?!]+$/, '');
        const file = path.join(ROOT_DIR, slug(title) + '.pdf');
        fs.writeFileSync(file, makePdf(title, ['Ask me to "write a document about …" with the cloud brain on and I will fill this with real content.']));
        return { say: `PDF ready — ${path.basename(file)} in your files folder.`, data: { file: path.basename(file) } };
      },
    },
    /* Word docs + decks as FIRST-CLASS voice requests (Brahma-Lite parity):
       these work offline / lean, and the reply names the exact format made and
       what to install for the native one. */
    {
      patterns: [/^(?:make|create|write)(?: me)? a (?:new )?(?:word doc|word document|docx|document) (?:about|for|called|on)\s+(.+)$/i],
      run: async (m) => {
        const title = m[1].replace(/[.?!]+$/, '');
        const out = await _makeDoc(title, [`First page about ${title}. Ask me to "write a longer document about ${title}" with the cloud brain on and I will fill it with real content.`]);
        return { say: `${out.format === 'docx' ? 'Word document' : 'Markdown doc'} ready — ${out.file} in your files folder.${out.note ? ' ' + out.note : ''}`, data: out };
      },
    },
    {
      patterns: [/^(?:make|create|build)(?: me)? an? (?:powerpoint|power point|presentation|slide deck|deck) (?:about|for|called|on)\s+(.+)$/i],
      run: async (m) => {
        const title = m[1].replace(/[.?!]+$/, '');
        const out = await _makeDeck(title, [
          { title, bullets: [`Opening overview of ${title}.`] },
          { title: 'Next steps', bullets: [`Ask me to "write a presentation about ${title}" with the cloud brain on — I will fill every slide.`] },
        ]);
        return { say: `${out.format === 'pptx' ? 'PowerPoint deck' : 'HTML deck'} ready — ${out.file || out.dir}.${out.note ? ' ' + out.note : ''}`, data: out };
      },
    },
  ],
};
