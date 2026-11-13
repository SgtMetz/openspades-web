// Test-only WebSocket-to-UDP relay for tools/headless-check.mjs (scenario net). Same wire format as
// ../../relay.mjs (one binary message per datagram), but it forwards only to the single local
// ENet test endpoint given by the caller, which the production relay correctly refuses because
// it is a private address. Never used by server.mjs.
import crypto from 'node:crypto';
import dgram from 'node:dgram';
import http from 'node:http';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
function frame(opcode, payload) {
  const n = payload.length;
  const head = n < 126 ? Buffer.from([0x80 | opcode, n])
    : n < 65536 ? Buffer.from([0x80 | opcode, 126, n >> 8, n & 255])
    : (() => { const b = Buffer.alloc(10); b[0] = 0x80 | opcode; b[1] = 127; b.writeBigUInt64BE(BigInt(n), 2); return b; })();
  return Buffer.concat([head, payload]);
}

// Returns {port, requests: [{host, port}], close()}; requests records what the page asked for.
export function startTestRelay(target) {
  const requests = [];
  const server = http.createServer((req, res) => { res.writeHead(404); res.end(); });
  server.on('upgrade', (req, socket) => {
    const url = new URL(req.url, 'http://localhost');
    const host = url.searchParams.get('host'), port = Number(url.searchParams.get('port'));
    requests.push({host, port});
    if (url.pathname !== '/relay' || !req.headers['sec-websocket-key']) { socket.destroy(); return; }
    const accept = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + GUID).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    const resolved = target.resolve(host, port);
    if (!resolved) { socket.end(frame(0x8, Buffer.from([0x03, 0xf0]))); return; } // 1008
    const udp = dgram.createSocket('udp4');
    udp.on('message', msg => socket.write(frame(0x2, msg)));
    udp.on('error', () => socket.destroy());
    udp.connect(resolved.port, resolved.host);
    const pending = [];
    udp.on('connect', () => { for (const d of pending.splice(0)) udp.send(d); });
    let buffer = Buffer.alloc(0);
    socket.on('close', () => { try { udp.close(); } catch {} });
    socket.on('error', () => {});
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 2) {
        const opcode = buffer[0] & 0x0f;
        let length = buffer[1] & 0x7f, offset = 2;
        if (length === 126) { if (buffer.length < 4) return; length = buffer.readUInt16BE(2); offset = 4; }
        else if (length === 127) { if (buffer.length < 10) return; length = Number(buffer.readBigUInt64BE(2)); offset = 10; }
        if (buffer.length < offset + 4 + length) return;
        const mask = buffer.subarray(offset, offset + 4);
        const payload = Buffer.from(buffer.subarray(offset + 4, offset + 4 + length));
        for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
        buffer = buffer.subarray(offset + 4 + length);
        if (opcode === 0x8) { socket.end(frame(0x8, Buffer.alloc(0))); return; }
        if (opcode !== 0x2) continue;
        try { udp.remoteAddress(); udp.send(payload); } catch { pending.push(payload); }
      }
    });
  });
  return new Promise(r => server.listen(0, '127.0.0.1', () => r({
    port: server.address().port, requests, close: () => server.close(),
  })));
}
