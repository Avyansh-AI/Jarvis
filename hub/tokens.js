'use strict';
/**
 * Short-lived security tokens: voice-verify tokens + liveness challenges.
 *
 * Chaos properties (regression-tested in tools/test-chaos.js):
 * - Fail-closed under clock skew: a token is valid only inside
 *   [issued - SKEW, exp]. If the wall clock rolls back past issuance the
 *   token is treated as invalid (an NTP rollback can never extend a token's
 *   life), and a forward jump simply expires everything early.
 * - Bounded memory: stores are capped and pruned lazily on write.
 * - Single-use: checks consume; a failed ownership check never consumes
 *   (theft attempts must not destroy the owner's token).
 */
const crypto = require('crypto');

const SKEW_MS = 15000; // tolerated clock disagreement between issue and use

const PHRASE_WORDS = ('amber basil cedar delta ember fjord garnet harbor ivory juniper kodiak lagoon meadow nutmeg onyx prairie'.split(' '));

class TokenBox {
  constructor({ now = Date.now } = {}) {
    this.now = now;
    this.verify = new Map();    // token -> { user, issued, exp }
    this.challenges = new Map(); // id -> { user, words, issued, exp }
  }

  _fresh(rec) {
    const t = this.now();
    if (!rec) return false;
    if (rec.exp <= t) return false;                              // expired (incl. forward jumps)
    if (t < rec.issued - SKEW_MS) return false;                  // clock rolled back past issuance — fail closed
    return true;
  }

  issueVerify(user) {
    const token = crypto.randomBytes(16).toString('hex');
    const t = this.now();
    this.verify.set(token, { user, issued: t, exp: t + 5 * 60000 });
    this._prune(this.verify, 500);
    return token;
  }

  /** Peek without consuming (used to attribute denials to the right user). */
  peekVerify(token) {
    const rec = this.verify.get(String(token || ''));
    return this._fresh(rec) ? rec.user : null;
  }

  /** Consume-only-if-owned. Returns true on success. Failed ownership checks leave the token alive. */
  checkVerify(token, user) {
    const rec = this.verify.get(String(token || ''));
    if (!this._fresh(rec)) return false;
    if (user && rec.user !== user) return false;
    this.verify.delete(String(token));
    return true;
  }

  /** Consume only when the token belongs to an enrolled non-guest non-kid profile (owner gate). */
  checkOwnerVerify(token, isOwner) {
    const rec = this.verify.get(String(token || ''));
    if (!this._fresh(rec)) return false;
    if (typeof isOwner === 'function' && !isOwner(rec.user)) return false;
    this.verify.delete(String(token));
    return true;
  }

  issueChallenge(user) {
    const id = crypto.randomBytes(12).toString('hex');
    const words = [];
    for (let i = 0; i < 3; i++) words.push(PHRASE_WORDS[crypto.randomInt(PHRASE_WORDS.length)]);
    const t = this.now();
    this.challenges.set(id, { user, words, issued: t, exp: t + 75000 });
    this._prune(this.challenges, 200);
    return { id, phrase: words.join(' ') };
  }

  /** Consumes the challenge regardless of outcome — no valid challenge, no verify attempt. */
  takeChallenge(id, user) {
    const rec = this.challenges.get(String(id || ''));
    if (!rec || !this._fresh(rec) || rec.user !== user) return null;
    this.challenges.delete(String(id));
    return rec;
  }

  sweep() {
    const t = this.now();
    for (const [k, v] of this.verify) if (v.exp <= t) this.verify.delete(k);
    for (const [k, v] of this.challenges) if (v.exp <= t) this.challenges.delete(k);
  }

  clear() { this.verify.clear(); this.challenges.clear(); }

  _prune(map, cap) {
    const t = this.now();
    if (map.size > cap) for (const [k, v] of map) if (v.exp <= t) map.delete(k);
    while (map.size > cap) map.delete(map.keys().next().value);
  }
}

module.exports = { TokenBox, PHRASE_WORDS, SKEW_MS };
