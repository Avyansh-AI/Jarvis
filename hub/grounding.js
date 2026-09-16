'use strict';
/**
 * Grounding — unified memory + live search answering.
 *
 * Memory and search are not either/or. For questions that could benefit from
 * current information, gather() pulls BOTH: relevant stored memory (recalled
 * facts) AND a live search snippet, and hands the brain one labelled section so
 * the answer is grounded in both. When the two conflict, the fresher
 * information wins: the stored fact is rewritten from the live result, the
 * owner is told, and the correction lands in the tamper-evident audit log.
 *
 * Conflict handling is deliberately conservative and deterministic — a live
 * snippet only overwrites a stored fact when BOTH parse into the same key with
 * clearly different short values ("python version is 3.11" vs live
 * "python version is 3.13"). Fuzzy disagreement is left to the brain with both
 * sources labelled (the fresher one marked authoritative), never silently
 * resolved.
 */

const FRESH_RE = /\b(latest|current|currently|today|tonight|right now|recent|recently|news|price|costs?|version|release[sd]?|who(?:'s| is) the (?:current|new)|2026|this (?:year|week|month)|updated?)\b/i;
const STOP = new Set(['what', 'when', 'where', 'which', 'who', 'whos', 'how', 'why', 'the', 'a', 'an', 'of', 'for', 'to', 'in', 'on', 'is', 'are', 'my', 'your', 'me', 'it', 'this', 'that', 'and', 'or', 'do', 'does', 'did', 'can', 'could', 'you', 'tell', 'about', 'now', 'latest', 'current', 'currently', 'today', 'recent', 'recently']);

const tokens = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((w) => w.length >= 4 && !STOP.has(w));

/** Parse "my favorite color is teal" / "python version: 3.11" into {key, value, personal}.
    personal marks facts that are ABOUT THE USER (their own words, their favorites):
    a live web result can never be fresher about a person's own preferences than the
    person — detectConflict refuses those (R-04: a Wikipedia snippet once rewrote
    "my favorite editor is vim" into someone else's opinion). */
function keyValueOf(factText) {
  const s = String(factText || '').trim();
  const withoutArticle = s.replace(/^(?:my|our|the)\s+/i, '');
  const personal = /^(?:my|our)\s/i.test(s) || /^(?:favorite|favourite|preferred)\s/i.test(withoutArticle);
  // colon form first; the copula must be a whole word (R-05b: "prime min-is-ter"
  // used to split inside keys, silently poisoning the conflict key/value)
  let m = /^(?:my\s+|the\s+)?(.+?)\s*:\s*(.+?)\s*(?:\s*\(live-checked.*)?$/i.exec(s)
       || /^(?:my\s+|the\s+)?(.+?)\s+(?:is|are|was|were)\s+(.+?)\s*(?:\s*\(live-checked.*)?$/i.exec(s);
  if (!m) return null;
  const key = m[1].trim().toLowerCase();
  const value = m[2].trim();
  if (!key || key.split(/\s+/).length > 4 || !value || value.split(/\s+/).length > 6) return null;
  return { key, value, personal };
}

/** A live value ends at sentence/clause boundaries — never mid-sentence
    (R-05: the greedy 4-token grab once stored "3.13.2 and ships with"). */
const CONNECTIVE = /^(?:and|or|but|with|which|that|while|so|because|as|still|yet|now|currently|today|including|included|plus|however|though|although|especially|featuring|featuring|ships|comes|bringing|offering|making)$/i;

/** Extract "the <key> is <value>" (also "… is now <value>" / "<key>: <value>") from live text. */
function liveValueFor(key, liveText) {
  const esc = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp('(?:the\\s+)?' + esc + '\\s*(?::|is(?:\\s+now)?|are(?:\\s+now)?)\\s+([A-Za-z0-9][A-Za-z0-9.,+/_-]*(?:\\s+[A-Za-z0-9][A-Za-z0-9.,+/_-]*){0,3})', 'i').exec(String(liveText || ''));
  if (!m) return null;
  // cut at the first discourse connective, and after a token that ends a clause
  // ("Jane Smith, elected in 2024" → "Jane Smith"), then drop trailing filler
  const kept = [];
  for (const w of m[1].trim().split(/\s+/)) {
    if (kept.length && CONNECTIVE.test(w.replace(/[.,;!?]+$/, ''))) break;
    kept.push(w);
    if (/[.,;:]$/.test(w)) break;
  }
  let v = kept.join(' ').replace(/[.,;!?]+$/, '');
  v = v.replace(/\s+(?:now|currently|today|yet|as of.*)$/i, '').trim();
  return v || null;
}

class Grounding {
  /**
   * @param {object} deps
   *  memory  Memory (facts)
   *  search  async (query) => { title, text, source } | null   (only called for fresh-sensitive questions, when online)
   *  net     { online }
   *  audit/log sinks, now injectable
   */
  constructor({ memory, search, net, log, audit, now } = {}) {
    this.memory = memory;
    this.search = search || (async () => null);
    this.net = net || { online: true };
    this.log = log || { write() {} };
    this.audit = audit || { write() {} };
    this.now = now || Date.now;
  }

  freshSensitive(text) { return FRESH_RE.test(String(text || '')); }

  /** Stored facts that share a content word with the question — most recent first. */
  relevantFacts(uid, text, limit = 3) {
    const q = new Set(tokens(text));
    if (!q.size || !this.memory) return [];
    let facts = [];
    try { facts = this.memory.facts(uid) || []; } catch { return []; }
    const hits = [];
    for (const f of facts) {
      const ft = tokens(f.fact);
      const overlap = ft.filter((w) => q.has(w)).length;
      if (overlap > 0) hits.push({ fact: f.fact, ts: f.ts || 0, overlap });
    }
    return hits.sort((a, b) => b.overlap - a.overlap || b.ts - a.ts).slice(0, limit);
  }

  /**
   * Deterministic conflict detection: same parsed key, clearly different short values.
   * Returns { key, stored, fresh, factTs } or null.
   */
  detectConflict(fact, liveText) {
    const kv = keyValueOf(fact && fact.fact !== undefined ? fact.fact : fact);
    if (!kv) return null;
    if (kv.personal) return null; // the freshest word on the user's own preferences is the user's
    const fresh = liveValueFor(kv.key, liveText);
    if (!fresh) return null;
    const norm = (v) => String(v).toLowerCase().replace(/[.,;!?]+$/, '').trim();
    if (norm(fresh) === norm(kv.value)) return null;
    return { key: kv.key, stored: kv.value, fresh, factTs: (fact && fact.ts) || 0 };
  }

  /**
   * Pull both sources for one question. Returns a small, prompt-ready bundle.
   * { freshSensitive, memoryFacts:[{fact,ts}], live:{title,text,source,fetchedAt}|null, conflicts:[…] }
   */
  async gather(text, uid, ctx = {}) {
    const out = { freshSensitive: this.freshSensitive(text), memoryFacts: [], live: null, conflicts: [] };
    out.memoryFacts = this.relevantFacts(uid, text);
    // Live search joins in when the question could benefit from current info. A
    // question with no stored context at all is also better with fresh data.
    if (this.net.online && (out.freshSensitive || !out.memoryFacts.length)) {
      try {
        const hit = await this.search(text);
        if (hit && hit.text) out.live = { title: hit.title || '', text: String(hit.text).slice(0, 600), source: hit.source || 'search', fetchedAt: this.now() };
      } catch { /* search is opportunistic here — never blocks the answer */ }
    }
    if (out.live) {
      for (const f of out.memoryFacts) {
        try {
          const c = this.detectConflict(f, out.live.text);
          if (c) out.conflicts.push(c);
        } catch {}
      }
    }
    return out;
  }

  /**
   * Prefer the fresher information: rewrite the stored fact from the live value,
   * tell the owner, audit it. Returns the applied conflicts ([] when none).
   */
  applyConflicts(uid, conflicts) {
    const applied = [];
    for (const c of conflicts || []) {
      const fresher = (c.factTs || 0) <= this.now(); // the live result is, by definition, fetched now
      if (!fresher) continue;
      try {
        this.memory.forgetFact(uid, c.key);
        this.memory.addFact(uid, `${c.key} is ${c.fresh} (live-checked ${new Date(this.now()).toDateString()}; was: ${c.stored})`);
        this.log.write('memory.conflict', { user: uid, key: c.key });
        this.audit.write('memory.conflict', { user: uid, key: c.key, stored: c.stored, fresh: c.fresh, rule: 'fresher-wins' });
        applied.push(c);
      } catch {}
    }
    return applied;
  }

  /** The labelled prompt section the brain sees (both sources, fresher marked authoritative). */
  promptSection(g) {
    if (!g || (!g.memoryFacts.length && !g.live)) return '';
    const lines = [];
    if (g.memoryFacts.length) {
      lines.push('Stored memory that may be relevant (could be stale):');
      for (const f of g.memoryFacts) lines.push(`- ${f.fact}`);
    }
    if (g.live) {
      lines.push(`Live web result fetched just now (“${g.live.title}”, ${g.live.source}) — if this conflicts with stored memory above, TRUST THIS and say the answer comes from the live check:`);
      lines.push(g.live.text);
    }
    return '\n' + lines.join('\n');
  }
}

module.exports = { Grounding, FRESH_RE, keyValueOf, liveValueFor };
