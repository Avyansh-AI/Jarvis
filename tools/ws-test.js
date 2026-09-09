'use strict';
/* Raw WebSocket client test (no deps): handshake + one utterance + satellite hello. */
const net = require('net');
const crypto = require('crypto');

function wsTest(path, messages, onMsg, done) {
  const key = crypto.randomBytes(16).toString('base64');
  const sock = net.connect(8080, '127.0.0.1');
  let shook = false, buf = Buffer.alloc(0);
  sock.on('connect', () => {
    sock.write(
      `GET ${path} HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
      `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`
    );
  });
  sock.on('data', (d) => {
    buf = Buffer.concat([buf, d]);
    if (!shook) {
      const idx = buf.indexOf('\r\n\r\n');
      if (idx < 0) return;
      const head = buf.slice(0, idx).toString();
      if (!head.includes('101')) { console.error('handshake failed:', head); process.exit(1); }
      shook = true;
      buf = buf.slice(idx + 4);
      for (const m of messages) sock.write(frame(JSON.stringify(m)));
    }
    for (;;) {
      if (buf.length < 2) return;
      let len = buf[1] & 0x7f, off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      if (buf.length < off + len) return;
      const op = buf[0] & 0x0f;
      const payload = buf.slice(off, off + len).toString('utf8');
      buf = buf.slice(off + len);
      if (op === 1) onMsg(JSON.parse(payload), sock, done);
    }
  });
  sock.on('error', (e) => { console.error('sock err', e.message); process.exit(1); });
}

function frame(str) {
  const p = Buffer.from(str);
  const mask = crypto.randomBytes(4);
  for (let i = 0; i < p.length; i++) p[i] ^= mask[i & 3];
  let header;
  if (p.length < 126) header = Buffer.from([0x81, 0x80 | p.length]);
  else { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 0x80 | 126; header.writeUInt16BE(p.length, 2); }
  return Buffer.concat([header, mask, p]);
}

let step = 0;
wsTest('/ws/satellite', [{ type: 'satellite.hello', id: 'test-node', name: 'Test Bench', caps: { sensors: true } }], (msg, sock, done) => {
  console.log('satellite got:', msg.type);
  if (msg.type === 'satellite.welcome') { sock.destroy(); appTest(); }
});

function appTest() {
  wsTest('/ws/app?user=default', [{ type: 'utterance', text: 'set a timer for 10 seconds' }], (msg, sock) => {
    console.log('app got:', msg.type, msg.say ? '→ ' + msg.say : '');
    if (msg.type === 'response') { sock.destroy(); process.exit(0); }
  });
}
setTimeout(() => { console.error('timeout'); process.exit(1); }, 8000);
