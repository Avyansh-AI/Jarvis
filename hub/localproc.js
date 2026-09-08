'use strict';
/**
 * LocalProc — the hub manages the Ollama process itself.
 *
 * When local routing needs the local model (privacy-topic routing or cloud-outage
 * fallback), ensureUp() makes it real: probe first; if down, spawn `ollama serve`
 * as a detached background process and wait until the API answers before anything
 * routes to it. If Ollama isn't installed, say so plainly — the caller turns that
 * into a user-facing diagnosis, never a silent failure.
 *
 * Properties:
 *  - single-flight: concurrent ensureUp() calls share one attempt
 *  - cooldown after a failed start, so a broken install isn't spawn-spammed
 *  - the spawned daemon is meant to outlive the hub (ollama serve is a system
 *    service); we never kill it
 *  - every start/failure lands in the audit log + event log (the activity feed
 *    reads the event log — "Local model started" shows up there)
 *  - spawn is injectable so tests never touch a real process table
 */
const { spawn } = require('child_process');

const START_TIMEOUT_MS = 25000;
const FAIL_COOLDOWN_MS = 60000;
const POLL_MS = 800;

class LocalProc {
  /**
   * @param {object} deps
   *  ollama  Ollama client (ping(), url())
   *  audit/log sinks, now/sleep/spawn injectable for tests
   */
  constructor({ ollama, audit, log, now, sleep, spawnFn } = {}) {
    this.ollama = ollama;
    this.audit = audit || { write() {} };
    this.log = log || { write() {} };
    this.now = now || Date.now;
    this.sleep = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.spawnFn = spawnFn || null;
    this._flight = null;       // in-flight ensureUp promise (single-flight)
    this._failAt = 0;          // cooldown marker after a failed start
    this._lastFailReason = null;
    this._child = null;        // last spawned `ollama serve` (orphan guard — R-03)
    this._childErred = false;  // spawn 'error' fired (ENOENT etc.) → treat as dead
  }

  _spawn() {
    if (this.spawnFn) return this.spawnFn('ollama', ['serve']);
    const child = spawn('ollama', ['serve'], { detached: true, stdio: 'ignore' });
    child.unref();
    return child;
  }

  /**
   * Make sure the local model API is answering.
   * Returns { ok, state: 'already'|'started'|'unavailable', reason?, startedByUs }
   */
  async ensureUp({ timeoutMs = START_TIMEOUT_MS } = {}) {
    if (this._flight) return this._flight; // single-flight
    this._flight = this._ensureUp({ timeoutMs }).finally(() => { this._flight = null; });
    return this._flight;
  }

  async _ensureUp({ timeoutMs }) {
    if (await this.ollama.ping()) return { ok: true, state: 'already', startedByUs: false };
    if (this.now() - this._failAt < FAIL_COOLDOWN_MS) {
      return { ok: false, state: 'unavailable', reason: this._lastFailReason || 'recent start attempt failed (cooldown)', startedByUs: false };
    }
    // Never multiply daemons: a previous spawn that is STILL ALIVE but never began
    // answering is hung — spawning another would orphan processes on every trigger
    // (R-03). Exited / error'd children are dead and a fresh attempt is fine.
    if (this._child && !this._childErred && this._child.exitCode == null && !this._child.killed) {
      return this._fail('a previously started `ollama serve` (pid ' + (this._child.pid || 'unknown') + ') is still running but never began answering — refusing to spawn another; kill it (or reboot) and retry');
    }
    let child, spawnErr = null;
    try {
      child = this._spawn();
      this._child = child; this._childErred = false;
      if (child && typeof child.on === 'function') child.on('error', (e) => { spawnErr = e; this._childErred = true; }); // ENOENT surfaces here and via exit code
    } catch (e) {
      return this._fail('not installed — ' + (/ENOENT/.test(e.message) ? 'the `ollama` binary was not found' : e.message));
    }
    this.log.write('model.local.starting', { url: this.ollama.url() });
    const deadline = this.now() + timeoutMs;
    while (this.now() < deadline) {
      await this.sleep(POLL_MS);
      if (await this.ollama.ping()) {
        this.log.write('model.local.started', { url: this.ollama.url() });
        this.audit.write('model.local.started', { url: this.ollama.url(), by: 'hub', reason: 'local routing requested' });
        return { ok: true, state: 'started', startedByUs: true };
      }
      if (spawnErr) return this._fail(/ENOENT/i.test(spawnErr.message || '') ? 'Ollama is not installed on this machine (no `ollama` binary)' : spawnErr.message);
      if (child && typeof child.exitCode === 'number' && child.exitCode !== null) {
        return this._fail(child.exitCode === -2 ? 'Ollama is not installed on this machine (no `ollama` binary)' : 'the `ollama serve` process exited immediately (code ' + child.exitCode + ')');
      }
    }
    return this._fail('timed out waiting for Ollama at ' + this.ollama.url());
  }

  _fail(reason) {
    this._failAt = this.now();
    this._lastFailReason = reason;
    this.log.write('model.local.unavailable', { reason });
    this.audit.write('model.local.unavailable', { reason });
    return { ok: false, state: 'unavailable', reason, startedByUs: false };
  }
}

module.exports = { LocalProc, START_TIMEOUT_MS, FAIL_COOLDOWN_MS };
