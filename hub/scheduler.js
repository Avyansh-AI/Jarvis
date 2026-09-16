'use strict';
/**
 * Persistent scheduler: timers, alarms, reminders (one-shot + recurring).
 * Jobs live in an encrypted store and fire via the supplied onFire callback.
 */
class Scheduler {
  constructor(store, onFire) {
    this.store = store;
    this.onFire = onFire;
    this.store.data.jobs = this.store.data.jobs || [];
    this._timer = setInterval(() => this._tick(), 1000);
    this._timer.unref?.();
  }

  list(includeFired = false) {
    return this.store.data.jobs.filter((j) => includeFired || !j.fired).sort((a, b) => a.at - b.at);
  }

  add(job) {
    if (!job || typeof job !== 'object') throw new Error('job must be an object');
    const pending = this.store.data.jobs.filter((j) => !j.fired).length;
    if (pending >= 500) throw new Error('Schedule is full (500 pending jobs) — clear old timers/reminders first.');
    job.id = job.id || ('j_' + Math.random().toString(36).slice(2, 10));
    job.created = Date.now();
    job.fired = false;
    this.store.data.jobs.push(job);
    this.store.save();
    return job;
  }

  remove(id) {
    const i = this.store.data.jobs.findIndex((j) => j.id === id);
    if (i < 0) return false;
    this.store.data.jobs.splice(i, 1);
    this.store.save();
    return true;
  }

  snooze(id, minutes = 10) {
    const job = this.store.data.jobs.find((j) => j.id === id);
    if (!job) return null;
    job.fired = false;
    job.at = Date.now() + minutes * 60000;
    job.snoozed = (job.snoozed || 0) + 1;
    this.store.save();
    return job;
  }

  clearKind(kind) {
    const before = this.store.data.jobs.length;
    this.store.data.jobs = this.store.data.jobs.filter((j) => j.kind !== kind);
    if (before !== this.store.data.jobs.length) this.store.save();
    return before - this.store.data.jobs.length;
  }

  _tick() {
    const now = Date.now();
    let dirty = false;
    for (const j of this.store.data.jobs) {
      if (!j.at || now < j.at) continue;
      if (j.repeat) {
        this._fire(j);
        j.at = nextOccurrence(j, now + 1000);
        dirty = true;
      } else if (!j.fired) {
        j.fired = true;
        this._fire(j);
        dirty = true;
      }
    }
    // prune one-shots fired >24h ago
    const before = this.store.data.jobs.length;
    this.store.data.jobs = this.store.data.jobs.filter((j) => j.repeat || !j.fired || now - j.at < 86400000);
    if (dirty || before !== this.store.data.jobs.length) this.store.save();
  }

  _fire(job) {
    try { this.onFire(job); } catch (e) { console.error('[scheduler]', e); }
  }
}

/**
 * Next fire time for recurring jobs.
 * job: { hour, minute, repeat: 'daily'|'weekdays'|'weekly', dow?: 0-6 }
 */
function nextOccurrence(job, fromMs = Date.now()) {
  const from = new Date(fromMs);
  for (let d = 0; d < 370; d++) {
    const cand = new Date(from.getFullYear(), from.getMonth(), from.getDate() + d, job.hour ?? 9, job.minute ?? 0, 0, 0);
    if (cand.getTime() < fromMs) continue;
    if (job.repeat === 'daily') return cand.getTime();
    if (job.repeat === 'weekdays' && cand.getDay() >= 1 && cand.getDay() <= 5) return cand.getTime();
    if (job.repeat === 'weekly' && cand.getDay() === (job.dow ?? from.getDay())) return cand.getTime();
  }
  return null;
}

module.exports = { Scheduler, nextOccurrence };
