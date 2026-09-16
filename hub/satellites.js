'use strict';
/**
 * Satellite (ESP32 node) registry + command failover queue.
 * Satellites connect over WS, report sensors, raise wake events, and receive
 * say/play commands. If a satellite drops offline, commands queue (capped) and
 * deliver on reconnect; the hub announces the dropout instead of failing silently.
 *
 * Round 6 — mutual authentication + swap awareness:
 *  - satellite→hub: SATELLITE_TOKEN in the hello (existing).
 *  - hub→satellite: the welcome carries `proof = HMAC(token, id|ts)`; a satellite
 *    that knows the token can verify it's talking to the real hub (rogue-hub
 *    impersonation fails without the token).
 *  - every authenticated hello re-fingerprints id+IP; an id suddenly arriving
 *    from a new IP emits `satellite.swap` (alert-visible, not blocked — DHCP
 *    churn is normal on home networks; silent impersonation is not).
 */
const { EventEmitter } = require('events');
const crypto = require('crypto');

function hubProof(id, ts) {
  const tok = process.env.SATELLITE_TOKEN || '';
  if (!tok) return null; // no shared secret configured — proof mode off
  return crypto.createHmac('sha256', tok).update(`${id}|${ts}`).digest('hex');
}
function verifyHubProof(id, ts, proof) { // exported for tests + the firmware reference
  const expect = hubProof(id, ts);
  if (expect === null) return null; // indeterminate: no token configured
  if (typeof proof !== 'string' || !/^[a-f0-9]{64}$/.test(proof)) return false;
  const a = Buffer.from(expect, 'hex'), b = Buffer.from(proof, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

class Satellites extends EventEmitter {
  constructor(log) {
    super();
    this.log = log;
    this.nodes = new Map(); // id -> { id, name, caps, sensors, ip, client, lastSeen, online, queue }
  }

  handle(client) {
    let id = null;
    let greeted = false;
    // if SATELLITE_TOKEN is set, the hello must carry it — otherwise the socket is a stranger
    setTimeout(() => { if (!greeted) { try { client.close(); } catch {} } }, 10000).unref?.();
    client.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      if (msg.type === 'satellite.hello') {
        const expected = process.env.SATELLITE_TOKEN || '';
        if (expected && msg.token !== expected) {
          this.log.write('satellite.rejected', { ip: (client.req.socket.remoteAddress || '').replace(/^::ffff:/, '') });
          client.sendJSON({ type: 'satellite.error', error: 'bad satellite token' });
          client.close();
          return;
        }
        greeted = true;
        id = String(msg.id || client.id).replace(/[^\w-]/g, '').slice(0, 40) || client.id;
        if (!this.nodes.has(id) && this.nodes.size >= 64) {
          this.log.write('satellite.rejected', { satellite: id, reason: 'registry full' });
          client.sendJSON({ type: 'satellite.error', error: 'registry full (64 max)' });
          client.close();
          return;
        }
        const node = this.nodes.get(id) || { id, queue: [] };
        const ip = client.req.socket.remoteAddress;
        const swapped = this.fingerprints && this.fingerprints.has(id) && this.fingerprints.get(id) !== ip;
        Object.assign(node, {
          name: msg.name || id,
          caps: msg.caps || {},
          sensors: node.sensors || {},
          ip,
          client, online: true, lastSeen: Date.now(),
        });
        this.nodes.set(id, node);
        this.log.write('satellite.online', { satellite: id });
        if (swapped) {
          // same id, new network identity: visible, logged, dashboard-alerted — never silent
          this.log.write('satellite.swap', { satellite: id, from: this.fingerprints.get(id), to: ip });
          this.emit('satellite.swap', id, this.fingerprints.get(id), ip);
        }
        if (this.fingerprints) { this.fingerprints.set(id, ip); this.onFingerprint && this.onFingerprint(id, ip); }
        const ts = Date.now();
        client.sendJSON({ type: 'satellite.welcome', id, ts, proof: hubProof(id, ts) });
        this.emit('change');
        // flush queued commands (graceful recovery)
        while (node.queue.length) client.sendJSON(node.queue.shift());
      } else if (id) {
        const node = this.nodes.get(id);
        if (!node) return;
        node.lastSeen = Date.now();
        if (msg.type === 'satellite.sensor') {
          node.sensors = { ...node.sensors, ...msg.data, at: Date.now() };
          this.emit('sensor', node.id, node.sensors);
          this.emit('change');
        } else if (msg.type === 'satellite.wake') {
          this.log.write('satellite.wake', { satellite: id });
          this.emit('wake', node.id);
        } else if (msg.type === 'satellite.log') {
          this.log.write('satellite.log', { satellite: id, message: msg.message });
        }
      }
    });
    client.on('close', () => {
      if (!id) return;
      const node = this.nodes.get(id);
      if (node) {
        node.online = false;
        node.client = null;
        this.log.write('satellite.offline', { satellite: id });
        this.emit('satellite.offline', id);
        this.emit('change');
      }
    });
  }

  /** Send a command to one satellite; queue if offline. Returns true if live-delivered. */
  send(id, msg) {
    const node = this.nodes.get(id);
    if (node && node.online && node.client) {
      try { node.client.sendJSON(msg); return true; } catch {}
    }
    if (!node) return false;
    node.queue = node.queue || [];
    if (node.queue.length < 50) node.queue.push(msg);
    return false;
  }

  /** Say something on all satellites that have speakers; returns count spoken live. */
  speak(text, audioUrl = null) {
    let live = 0;
    for (const node of this.nodes.values()) {
      if (!node.caps || !node.caps.speaker) continue;
      if (this.send(node.id, { type: 'satellite.say', text, audioUrl })) live++;
    }
    return live;
  }

  list() {
    return [...this.nodes.values()].map((n) => ({
      id: n.id, name: n.name, online: !!n.online, caps: n.caps,
      sensors: n.sensors, lastSeen: n.lastSeen, queued: (n.queue || []).length, ip: n.ip,
    }));
  }
}

module.exports = { Satellites, hubProof, verifyHubProof };
