'use strict';
/**
 * Openers — proactive, context-grounded "what should we start with" suggestions.
 *
 * Rules (product constraints, structural):
 *  - GROUNDED OR SILENT. Candidates come only from real, local sources:
 *    today's calendar (skills/calendar.today()), due/today reminders
 *    (Scheduler store), and in-progress routine patterns for this hour-of-week
 *    (Learner.emergingRoutines — the personalization layer, reused, not
 *    paralleled). Zero candidates → null. There is intentionally NO open-ended
 *    fallback phrasing ("What would you like to do?" is the anti-goal).
 *  - SUGGESTION ONLY. An opener is text plus a parked READ-ONLY accept
 *    (kind:'opener' in the session confirm slot — it names no registry tool,
 *    carries no write, and can never mint verification). The follow-up "yes"
 *    surfaces the item's details; every gate everywhere else is untouched.
 *  - TOGGLEABLE. master settings.proactive.enabled AND settings.proactive.openers
 *    (default on), as an extension of the proactive-notification opt-in.
 *  - PRIVACY. Guests and kid profiles never receive openers (they would leak
 *    personal schedule data).
 *  - VOICE comes from persona.js (the one fork-branded block) — phrasing only.
 */
const { VOICE } = require('./persona');
const { fmtTime } = require('./skills/_timeparse');

class Openers {
  /**
   * @param deps calendar  skills/calendar module (read-only use: today())
   *             scheduler  Scheduler (store.data.jobs read-only)
   *             learner    Learner (emergingRoutines — may be null)
   *             settings   settings facade
   *             now        injectable clock for tests
   */
  constructor({ calendar, scheduler, learner, settings, now } = {}) {
    this.calendar = calendar || { today: () => [] };
    this.scheduler = scheduler || { store: { data: { jobs: [] } } };
    this.learner = learner || null;
    this.settings = settings || { data: {} };
    this.now = now || Date.now;
  }

  /** Toggle: master proactive opt-in + the openers sub-toggle; profile privacy. */
  enabled(user) {
    if (!user || user.guest || user.kid) return false;
    const p = (this.settings.data && this.settings.data.proactive) || {};
    return p.enabled !== false && p.openers !== false;
  }

  /** Gather + rank candidates. Pure read of the three sources. */
  candidates(uid, now = this.now()) {
    const out = [];
    const d = new Date(now);
    const dayStart = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const dayEnd = dayStart + 86400e3;
    try {
      for (const ev of this.calendar.today() || []) {
        if (!ev || !ev.title || typeof ev.start !== 'number') continue;
        const soon = ev.start >= now && ev.start <= now + 3 * 3600e3;
        out.push({
          kind: 'event', at: ev.start, title: String(ev.title).slice(0, 80),
          score: (soon ? 100 : 40) - Math.abs(ev.start - now) / 3600e3,
        });
      }
    } catch {}
    try {
      const jobs = (this.scheduler.store && this.scheduler.store.data && this.scheduler.store.data.jobs) || [];
      for (const j of jobs) {
        if (!j || j.fired || j.kind !== 'reminder' || typeof j.at !== 'number') continue;
        if (j.at >= dayEnd || j.at < dayStart - 86400e3) continue; // today or genuinely overdue (yesterday, still not fired)
        if (j.user && uid && j.user !== uid) continue; // reminders are per-user — never leak someone else's
        out.push({
          kind: 'reminder', at: j.at,
          title: String(j.label || j.text || 'reminder').replace(/^remind(er)?( me)?( to)?:?\s*/i, '').slice(0, 80),
          score: (j.at <= now ? 90 : 30) - Math.abs(j.at - now) / 8640e3,
        });
      }
    } catch {}
    try {
      if (this.learner && typeof this.learner.emergingRoutines === 'function') {
        const hour = d.getHours(), dow = d.getDay();
        for (const r of this.learner.emergingRoutines(uid) || []) {
          if (r.hour !== hour || r.dow !== dow || (r.n || 0) < 2) continue;
          out.push({
            kind: 'routine', at: now, title: String(r.skill).replace(/_/g, ' '),
            score: 20 + Math.min(10, r.n), n: r.n,
          });
        }
      }
    } catch {}
    out.sort((a, b) => b.score - a.score);
    // one per kind keeps the suggestion varied and short
    const seen = new Set();
    return out.filter((c) => (seen.has(c.kind) ? false : (seen.add(c.kind), true))).slice(0, 3);
  }

  _phrase(items, voice) {
    const bits = items.map((c) => {
      if (c.kind === 'event') return `${c.title}${c.at > this.now() ? ' at ' + fmtTime(c.at) : ' (already on)'}`;
      if (c.kind === 'reminder') return c.at <= this.now() ? `the open reminder "${c.title}"` : `the reminder "${c.title}" at ${fmtTime(c.at)}`;
      return `your usual ${c.title} slot${c.n ? ` (week ${Math.min(c.n, 9)} of the pattern)` : ''}`;
    });
    const list = bits.length === 1 ? bits[0] : bits.slice(0, -1).join(', ') + (bits.length > 2 ? ', and ' : ' and ') + bits[bits.length - 1];
    return voice.id === 'jarvis'
      ? `On the board: ${list}. Start there, or is something else first?`
      : `You've got ${list} — want to start there, or something else first?`;
  }

  /**
   * Compose an opener for this user right now. Returns null when nothing real is
   * queued (silence over filler) or when gated off. Otherwise:
   *   { say, top, items } — `top` feeds the read-only detail on acceptance.
   */
  compose(uid, user, now = this.now()) {
    if (!this.enabled(user)) return null;
    const items = this.candidates(uid, now);
    if (!items.length) return null;
    return { say: this._phrase(items, VOICE), top: items[0], items: items.map((c) => ({ kind: c.kind, at: c.at, title: c.title })) };
  }

  /** Answer for an explicit "where do we start?" — honest when the board is empty. */
  explicit(uid, user, now = this.now()) {
    const c = this.compose(uid, user, now);
    if (c) return c;
    if (!this.enabled(user)) return null; // caller falls through to normal routing
    return {
      say: VOICE.id === 'jarvis'
        ? 'Board is clear — nothing on the calendar today, no reminders due, no pattern due right now. Your call.'
        : "Nothing specific is queued — today's calendar is clear and no reminders are due. Whatever you'd like!",
      top: null, items: [],
    };
  }

  /** Read-only detail shown when the owner accepts an opener. Data, not actions. */
  detail(top) {
    if (!top) return VOICE.id === 'jarvis' ? 'Nothing queued — the floor is yours.' : 'Nothing queued — lead the way!';
    const when = typeof top.at === 'number' ? fmtTime(top.at) : '';
    if (top.kind === 'event') {
      return VOICE.id === 'jarvis'
        ? `"${top.title}" — ${when}. Say "briefing" for the full rundown, or tell me what you need around it.`
        : `Your event "${top.title}" is at ${when}. I can give you the full briefing, or help you prepare — just say the word.`;
    }
    if (top.kind === 'reminder') {
      return VOICE.id === 'jarvis'
        ? `Reminder: "${top.title}"${when ? ` — ${when}` : ''}. Say "reminders" to see them all, or get it done and I'll strike it.`
        : `The reminder is "${top.title}"${when ? ` at ${when}` : ''}. Ask me for all your reminders, or tell me when it's done.`;
    }
    return VOICE.id === 'jarvis'
      ? `This is usually your ${top.title} time. Say the word and we'll run it.`
      : `It's usually your ${top.title} time around now — want to do that? Just ask!`;
  }
}

module.exports = { Openers };
