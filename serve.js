/* STARFALL — serve.js
   Static file server + a shard server for co-op, with zero dependencies.
   The WebSocket bits are RFC6455 by hand: no `ws`, no install step.

     node serve.js            -> http://localhost:7722
     PORT=8080 node serve.js  -> another port
*/

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 7722;   // 7733 is the counter app
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_PLAYERS = 8;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.md': 'text/markdown; charset=utf-8'
};

/* ------------------------------------------------------------- http     */

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/' || p.endsWith('/')) p += 'index.html';
  const file = path.join(ROOT, path.normalize(p).replace(/^([/\\])+/, ''));
  if (!file.startsWith(ROOT)) { res.writeHead(403).end('nope'); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }).end('404'); return; }
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache'
    });
    res.end(data);
  });
});

/* -------------------------------------------------------- websocket     */

class Conn {
  constructor(socket, id) {
    this.socket = socket;
    this.id = id;
    this.buf = Buffer.alloc(0);
    this.alive = true;
    this.name = 'Guardian';
    this.classId = 'warden';
    this.x = 0; this.y = 0; this.z = 0; this.yaw = 0; this.h = 1; this.s = 0;
    this.onMessage = null;
    this.onClose = null;
    socket.on('data', d => this._data(d));
    socket.on('error', () => this.close());
    socket.on('close', () => this._closed());
  }

  _data(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    // Cap the buffer: a client that floods us gets dropped, not OOMs us.
    if (this.buf.length > 1 << 20) { this.close(); return; }
    while (this.alive) {
      const frame = this._readFrame();
      if (!frame) break;
      if (frame.opcode === 0x8) { this.close(); break; }
      if (frame.opcode === 0x9) { this._sendRaw(0xA, frame.payload); continue; }
      if (frame.opcode === 0xA) continue;
      if (frame.opcode === 0x1 || frame.opcode === 0x0) {
        const text = frame.payload.toString('utf8');
        if (this.onMessage) this.onMessage(text);
      }
    }
  }

  _readFrame() {
    const b = this.buf;
    if (b.length < 2) return null;
    const fin = (b[0] & 0x80) !== 0;
    const opcode = b[0] & 0x0f;
    const masked = (b[1] & 0x80) !== 0;
    let len = b[1] & 0x7f;
    let off = 2;
    if (len === 126) {
      if (b.length < off + 2) return null;
      len = b.readUInt16BE(off); off += 2;
    } else if (len === 127) {
      if (b.length < off + 8) return null;
      const hi = b.readUInt32BE(off), lo = b.readUInt32BE(off + 4);
      len = hi * 4294967296 + lo;
      off += 8;
    }
    let mask = null;
    if (masked) {
      if (b.length < off + 4) return null;
      mask = b.slice(off, off + 4);
      off += 4;
    }
    if (b.length < off + len) return null;
    const payload = Buffer.from(b.slice(off, off + len));
    if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
    this.buf = b.slice(off + len);
    return { fin, opcode, payload };
  }

  _sendRaw(opcode, payload) {
    if (!this.alive || this.socket.destroyed) return;
    const len = payload.length;
    let header;
    if (len < 126) {
      header = Buffer.alloc(2);
      header[1] = len;
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[1] = 127;
      header.writeUInt32BE(Math.floor(len / 4294967296), 2);
      header.writeUInt32BE(len >>> 0, 6);
    }
    header[0] = 0x80 | opcode;
    try { this.socket.write(Buffer.concat([header, payload])); } catch (e) { this.close(); }
  }

  sendText(str) { this._sendRaw(0x1, Buffer.from(str, 'utf8')); }
  sendJSON(obj) { this.sendText(JSON.stringify(obj)); }

  close() {
    if (!this.alive) return;
    this.alive = false;
    try { this._sendRaw(0x8, Buffer.alloc(0)); } catch (e) { /* already gone */ }
    try { this.socket.destroy(); } catch (e) { /* already gone */ }
    this._closed();
  }

  _closed() {
    if (this._done) return;
    this._done = true;
    this.alive = false;
    if (this.onClose) this.onClose();
  }
}

/* ------------------------------------------------------------- shard    */

class Shard {
  constructor() {
    this.players = new Map();
    this.hostId = null;
    this.nextId = 1;
    setInterval(() => this.tick(), 1000 / 12);
  }

  add(conn) {
    if (this.players.size >= MAX_PLAYERS) { conn.sendJSON({ t: 'full' }); conn.close(); return; }
    this.players.set(conn.id, conn);
    if (!this.hostId) this.hostId = conn.id;
  }

  remove(conn) {
    this.players.delete(conn.id);
    this.broadcast({ t: 'leave', id: conn.id, name: conn.name }, conn.id);
    if (this.hostId === conn.id) {
      // Promote the next player; the shard keeps running without a gap.
      this.hostId = this.players.size ? this.players.keys().next().value : null;
      if (this.hostId) this.broadcast({ t: 'host', id: this.hostId });
    }
  }

  broadcast(msg, exceptId = null) {
    const str = JSON.stringify(msg);
    for (const [id, c] of this.players) {
      if (id === exceptId) continue;
      c.sendText(str);
    }
  }

  sendTo(id, msg) {
    const c = this.players.get(id);
    if (c) c.sendJSON(msg);
  }

  handle(conn, raw) {
    let m;
    try { m = JSON.parse(raw); } catch (e) { return; }
    if (!m || typeof m.t !== 'string') return;
    switch (m.t) {
      case 'hello': {
        conn.name = String(m.name || 'Guardian').slice(0, 16);
        conn.classId = String(m.classId || 'warden');
        conn.sendJSON({
          t: 'welcome',
          id: conn.id,
          host: this.hostId === conn.id,
          count: this.players.size,
          players: [...this.players.values()].filter(c => c !== conn).map(c => ({
            id: c.id, name: c.name, classId: c.classId, x: c.x, y: c.y, z: c.z
          }))
        });
        this.broadcast({ t: 'join', id: conn.id, name: conn.name, classId: conn.classId }, conn.id);
        break;
      }
      case 'state':
        conn.x = m.x; conn.y = m.y; conn.z = m.z;
        conn.yaw = m.yaw; conn.h = m.h; conn.s = m.s;
        break;
      case 'chat':
        this.broadcast({ t: 'chat', id: conn.id, name: conn.name, text: String(m.text || '').slice(0, 140) });
        break;
      case 'esnap':
      case 'edie':
      case 'obj':
      case 'banner':
        // Only the host's world state is authoritative.
        if (conn.id === this.hostId) this.broadcast(m, conn.id);
        break;
      case 'ehit':
        if (this.hostId && conn.id !== this.hostId) this.sendTo(this.hostId, { ...m, from: conn.id });
        break;
    }
  }

  tick() {
    if (!this.players.size) return;
    const p = [];
    for (const c of this.players.values()) {
      p.push({ id: c.id, x: c.x, y: c.y, z: c.z, yaw: c.yaw, h: c.h, s: c.s });
    }
    this.broadcast({ t: 'states', p });
  }
}

const shard = new Shard();

server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (!key) { socket.destroy(); return; }
  const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );
  socket.setNoDelay(true);
  const conn = new Conn(socket, shard.nextId++);
  conn.onMessage = raw => shard.handle(conn, raw);
  conn.onClose = () => shard.remove(conn);
  shard.add(conn);
});

server.listen(PORT, () => {
  console.log(`STARFALL -> http://localhost:${PORT}   (shard server on the same port)`);
});
