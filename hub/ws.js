'use strict';
/**
 * Minimal, dependency-free WebSocket (RFC 6455) server implementation.
 * Supports text/binary frames, fragmentation, ping/pong, close.
 * Server -> client frames are never masked; client frames are unmasked.
 */
const crypto = require('crypto');
const { EventEmitter } = require('events');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_FRAME = 1 << 20;   // 1 MB per frame — anything bigger is nonsense here
const MAX_BUFFER = 2 << 20;  // 2 MB pending accumulation cap → close connection

class WSClient extends EventEmitter {
  constructor(socket, req) {
    super();
    this.id = crypto.randomUUID();
    this.socket = socket;
    this.req = req;
    this.buffer = Buffer.alloc(0);
    this.frag = [];
    this.fragOp = 0;
    this.closed = false;
    this.lastPong = Date.now();
    socket.on('data', (d) => {
      if (this.closed) return;
      this.buffer = Buffer.concat([this.buffer, d]);
      if (this.buffer.length > MAX_BUFFER) { this.close(); return; }
      this._drain();
    });
    socket.on('close', () => this._die());
    socket.on('error', () => this._die());
  }

  _die() {
    if (this.closed) return;
    this.closed = true;
    try { this.socket.destroy(); } catch {}
    this.emit('close');
  }

  _drain() {
    for (;;) {
      const b = this.buffer;
      if (b.length < 2) return;
      const fin = (b[0] & 0x80) !== 0;
      const op = b[0] & 0x0f;
      const masked = (b[1] & 0x80) !== 0;
      let len = b[1] & 0x7f;
      let off = 2;
      if (len === 126) {
        if (b.length < 4) return;
        len = b.readUInt16BE(2); off = 4;
      } else if (len === 127) {
        if (b.length < 10) return;
        len = Number(b.readBigUInt64BE(2)); off = 10;
      }
      if (len > MAX_FRAME) { this.close(); return; }
      let mask = null;
      if (masked) {
        if (b.length < off + 4) return;
        mask = b.slice(off, off + 4); off += 4;
      }
      if (b.length < off + len) return;
      const payload = Buffer.from(b.slice(off, off + len));
      this.buffer = b.slice(off + len);
      if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];

      if (op === 8) { this._sendFrame(8, Buffer.alloc(0)); this._die(); return; }
      if (op === 9) { this._sendFrame(10, payload); continue; }
      if (op === 10) { this.lastPong = Date.now(); this.emit('pong'); continue; }
      if (op === 0 || op === 1 || op === 2) {
        if (op !== 0) { this.frag = [payload]; this.fragOp = op; }
        else this.frag.push(payload);
        if (fin) {
          const full = Buffer.concat(this.frag);
          const kind = this.fragOp;
          this.frag = [];
          if (kind === 1) this.emit('message', full.toString('utf8'));
          else this.emit('binary', full);
        }
      }
    }
  }

  _sendFrame(op, payload) {
    if (this.closed) return;
    const len = payload.length;
    let header;
    if (len < 126) {
      header = Buffer.from([0x80 | op, len]);
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | op; header[1] = 126; header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | op; header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2);
    }
    try { this.socket.write(Buffer.concat([header, payload])); } catch { this._die(); }
  }

  send(str) { this._sendFrame(1, Buffer.from(String(str), 'utf8')); }
  sendJSON(obj) { this.send(JSON.stringify(obj)); }
  ping() { this._sendFrame(9, Buffer.alloc(0)); }
  close() { this._sendFrame(8, Buffer.alloc(0)); this._die(); }
}

/** Attach WS upgrade handling to an http.Server. routes: { '/path': (client, req) => {} } */
function attach(httpServer, routes) {
  const clients = new Set();
  // liveness: ping every 30s; reap clients silent for >90s (half-open sockets, dead Wi-Fi)
  const sweeper = setInterval(() => {
    for (const c of clients) {
      if (Date.now() - c.lastPong > 90000) { c.close(); continue; }
      c.ping();
    }
  }, 30000);
  sweeper.unref?.();

  httpServer.on('upgrade', (req, socket) => {
    let pathname;
    try { pathname = new URL(req.url, 'http://localhost').pathname; } catch { socket.destroy(); return; }
    const handler = routes[pathname];
    const key = req.headers['sec-websocket-key'];
    if (!handler || !key) { socket.destroy(); return; }
    const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
    );
    socket.setNoDelay(true);
    const client = new WSClient(socket, req);
    clients.add(client);
    client.on('close', () => clients.delete(client));
    handler(client, req);
  });
}

module.exports = { attach, WSClient };
