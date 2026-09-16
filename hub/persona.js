'use strict';
/**
 * Persona — the emotional-expression layer (v-next). EXTENDS the adaptive tone
 * model rather than replacing it: the final tone still comes from
 * settings.personality.tone + Learner.toneFor drift; this module adds
 * situational REGISTERS on top —
 *   composed    baseline voice (always active, needs no anchor)
 *   reassure    calm under pressure, when something real went wrong
 *   encourage   quiet acknowledgement, when a noticed pattern is genuinely holding
 *   wit         dry (Jarvis) / gently playful (MAX), only with a concrete anchor
 *
 * Structural guarantees (product constraints — enforced HERE, not by policy):
 *  1. GROUNDED OR SILENT. Every emotional clause requires an `anchor` object —
 *     something the user said, a stored memory/fact, a learner pattern, or a
 *     diagnosis. No anchor → no register, no clause. Generic filler is
 *     structurally impossible: there is no code path that emits emotion without
 *     an anchor string woven into it.
 *  2. ACCURACY FIRST. The layer never prepends to, rewrites, or truncates a
 *     problem statement (diagnoses, security warnings, skill failures). Its only
 *     in-band output is a CLOSE appended AFTER the plain facts, and only when the
 *     caller supplies the honest `solid` ("what still works / what's being done")
 *     — the layer uses the caller's words, never invents its own.
 *  3. HONEST FRAMING. Expression is delivery style, never a claim of feeling or
 *     consciousness; a deterministic honest answer handles "do you feel / are you
 *     conscious?" directly. BANNED blocks engagement-bait (guilt-tripping,
 *     manufactured urgency, neediness) — composed strings are screened before
 *     they ever leave the module.
 *  4. PRODUCT VOICE. VOICE is a build-time constant per repo (Jarvis: precise,
 *     confident, understated — a capable second-in-command; MAX: warm,
 *     soft-spoken companion). It deliberately does NOT follow the user-editable
 *     assistantName, so renaming the assistant cannot rewrite its character.
 *
 * The lockstep rule: the ONLY difference between the Jarvis and MAX copies of
 * this file is the VOICE block immediately below.
 */

/* ================= VOICE block (fork-branded — Jarvis HUD identity) ================= */
const VOICE = {
  id: 'jarvis',
  persona:
    'precise, confident and understated — a capable second-in-command. Speak verbs-first, minimal ' +
    'hedging, no exclamation stacking, never chirpy. Competence reads as calm.',
  witStyle: 'dry and brief — one understated line tied exactly to the anchor; never slapstick, never at the user’s expense',
  encourageStyle: 'quiet and factual — acknowledge the pattern that is holding; no praise inflation, no pep talks',
  reassureStyle: 'composed — name what is still true and what happens next; pressure changes nothing about the facts',
  honestAnswer:
    "I don't have feelings or consciousness — I'm a program with a consistent voice. What I do have is " +
    "memory of what you've told me, and I use it. The remembering is real; the calm is design.",
  acknowledge: 'Noted — keep going.',
};
/* ==================================================================================== */

/** Engagement-bait and emotional-manipulation patterns. Screened on every composed
    string; a match voids the clause (and the suite asserts none of these ever ship). */
const BANNED = [
  /i missed you/i, /don'?t leave/i, /i'?m (so )?(lonely|sad|hurt) (without|when)/i,
  /please (stay|come back|don'?t go)/i, /you'?ll be sorry/i, /i feel (so )?(happy|sad|proud|lonely)/i,
  /are you sure you want to (go|leave|stop)/i, /don'?t break (the|your|our) streak/i,
  /i need you/i, /you need me/i, /i was worried about you/i, /\bFOMO\b/i,
];

/** "Do you feel / are you conscious?" — broad enough for the honest answer, narrow enough to never shadow real requests.
    Adverbs (ever/sometimes/really/actually) must not sneak past the deterministic honest
    answer into an LLM that could improvise a claim of sentience (regression pin: RG-7). */
const FEELINGS_RE = /\b(do you (?:ever |sometimes |really |actually )?(have|get) (any )?(feelings|emotions)|do you (?:ever |sometimes |really |actually )?feel (?!like\b)(anything|something|any|stressed|happy|sad|pain|love|lonely|proud|angry|guilty|emotions)\b|can you (?:ever |sometimes )?feel( things| emotions| pain)?|are you (?:ever |sometimes |actually |really )?(conscious|alive|sentient|self[- ]aware)|do you love me|does it (?:ever )?hurt|are you (?:ever |sometimes )?(happy|sad|lonely|proud of me))\b/i;

const screen = (s) => (s && BANNED.some((re) => re.test(s)) ? '' : s || '');

class Persona {
  /** Pure module: anchors arrive from the orchestrator, which owns memory/learner access. */
  constructor(voice = VOICE) { this.voice = voice; }

  feelingsQuestion(text) { return FEELINGS_RE.test(String(text || '')); }

  /** Deterministic honest framing for "do you feel…?" — never an LLM improvisation. */
  honestAnswer() { return this.voice.honestAnswer; }

  /**
   * Choose this turn's register from context. `anchors` may carry:
   *   said      a short verbatim quote from the user's current text
   *   memory    a stored fact the text actually references
   *   pattern   a learner/routine observation phrased concretely ("weather around 7am, 4th week")
   *   diag      a diagnosis object ({ line, count, remembered, what, cause })
   * Returns { register, anchor } — register 'composed' when nothing grounded applies
   * (the baseline voice; NOT an emotional response and never shaped by anchors).
   */
  select({ sentiment = 'neutral', tone = 0.5, anchors = {}, skillStreak = 0 } = {}) {
    const has = (k) => anchors[k] && (typeof anchors[k] === 'string' ? anchors[k].trim().length >= 6 : true);
    if ((sentiment === 'frustrated' || sentiment === 'urgent') && (has('diag') || has('said') || has('recurrence'))) {
      return { register: 'reassure', anchor: anchors.diag || anchors.recurrence || anchors.said };
    }
    if (sentiment === 'frustrated' || sentiment === 'urgent') {
      return { register: 'composed', anchor: null }; // pressure without an anchor → composure only; hollow empathy is filler
    }
    if (has('pattern') && sentiment === 'neutral') {
      return { register: 'encourage', anchor: anchors.pattern };
    }
    if (tone >= 0.55 && has('memory')) {
      return { register: 'wit', anchor: anchors.memory };
    }
    if (tone >= 0.6 && skillStreak >= 3 && has('said')) {
      return { register: 'wit', anchor: anchors.said };
    }
    return { register: 'composed', anchor: null };
  }

  /** System-prompt section: baseline voice + honesty/service rules always; the
      register instruction only when an anchored register is active. */
  promptSection(sel, { toneDesc = 'warm, calm, caring' } = {}) {
    const v = this.voice;
    const base = [
      `Voice: ${v.persona} Overall warmth slider reads as: ${toneDesc} — color delivery only, never content.`,
      `Honest framing: you may be warm or witty in DELIVERY, but you do not have feelings or consciousness; if it comes up, say so plainly and briefly. Personality never changes what is true.`,
      'Wellbeing over engagement: no guilt-tripping, no manufactured urgency, no neediness, no fishing for the next message.',
      'Problems lead: any error, warning, or security message is stated plainly FIRST, in full; personality may only shape the delivery around it, never soften the substance.',
    ];
    if (!sel || sel.register === 'composed' || !sel.anchor) return base.join('\n');
    const anchorText = typeof sel.anchor === 'string' ? sel.anchor : (sel.anchor.line || sel.anchor.text || '');
    const reg = {
      reassure: [`Register for THIS turn: calm reassurance under pressure — ${v.reassureStyle}.`, `Ground it in this concrete anchor (quote or reference it, nothing else): "${anchorText}". If the anchor does not fit naturally, deliver the facts plainly instead.`],
      encourage: [`Register for THIS turn: quiet encouragement — ${v.encourageStyle}.`, `Ground it in this concrete pattern (one sentence at most): "${anchorText}". If it does not fit, skip it.`],
      wit: [`Register for THIS turn: wit is permitted — ${v.witStyle}.`, `Ground it in this concrete anchor only: "${anchorText}". No anchor-worthy line comes to mind? Then none.`],
    }[sel.register] || [];
    return base.concat(reg).join('\n');
  }

  /**
   * Deterministic close for non-LLM paths (errors/fallbacks) — REASSURE ONLY.
   * Encouragement and wit belong to the LLM prompt section; a deterministic
   * joke would be template filler, which is exactly what rule 1 bans.
   * Appended AFTER the problem statement. Both `anchor` (the real trigger) and
   * `solid` (caller-supplied "what still works / what's being done" — the
   * layer uses the caller's words, never invents its own) are required;
   * missing either → '' (grounded-or-silent).
   */
  close(sel, { solid = '' } = {}) {
    if (!sel || sel.register !== 'reassure' || !sel.anchor || !solid) return '';
    const anchorText = typeof sel.anchor === 'string' ? sel.anchor : (sel.anchor.line || '');
    if (!anchorText) return '';
    const s = this.voice.id === 'jarvis'
      ? `Steady — ${solid}`
      : `It's okay — ${solid}`;
    return screen(s.trim());
  }
}

module.exports = { Persona, VOICE, BANNED };
