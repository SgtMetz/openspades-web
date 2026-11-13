// WebSocket-to-UDP datagram relay for Ace of Spades servers. GPL-3.0-or-later.
// Browsers cannot send UDP, so the game's ENet client sends each datagram as one binary
// WebSocket message to /relay?host=<ip or name>&port=<port>; this forwards it unchanged.
import crypto from 'node:crypto';
import dgram from 'node:dgram';
import dns from 'node:dns/promises';
import net from 'node:net';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const IDLE_MS = 60_000;

function frame(opcode, payload) {
  const length = payload.length;
  const header = length < 126 ? Buffer.from([0x80 | opcode, length])
    : length < 65536 ? Buffer.from([0x80 | opcode, 126, length >> 8, length & 255])
    : (() => { const h = Buffer.alloc(10); h[0] = 0x80 | opcode; h[1] = 127; h.writeBigUInt64BE(BigInt(length), 2); return h; })();
  return Buffer.concat([header, payload]);
}

function reject(socket, code, text) {
  socket.end(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

/** Handles an HTTP upgrade request. Returns false if the URL is not the relay endpoint. */
export function handleUpgrade(req, socket, allowedOrigins) {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname !== '/relay') return false;
  // Any web page can open a WebSocket to localhost, so only the game's own origin may use the relay.
  if (!allowedOrigins.has(req.headers.origin)) { reject(socket, 403, 'Forbidden'); return true; }
  const key = req.headers['sec-websocket-key'];
  const host = url.searchParams.get('host') || '', port = Number(url.searchParams.get('port'));
  if (!key || req.headers.upgrade?.toLowerCase() !== 'websocket' || !host || host.length > 253 ||
      !/^[a-z0-9.-]+$/i.test(host) || !Number.isInteger(port) || port < 1 || port > 65535) {
    reject(socket, 400, 'Bad Request');
    return true;
  }
  const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  socket.setNoDelay(true);
  startRelay(socket, host, port);
  return true;
}

// Game servers are on the public Internet; never relay to private, loopback or reserved addresses.
function isPublicIPv4(address) {
  if (net.isIP(address) !== 4) return false;
  const [a, b] = address.split('.').map(Number);
  return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b < 128) ||
    (a === 169 && b === 254) || (a === 172 && b >= 16 && b < 32) || (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)));
}

async function startRelay(socket, host, port) {
  let udp = null, closed = false, buffer = Buffer.alloc(0), fragments = [], idle;
  const pending = [];
  const close = (code = 1000) => {
    if (closed) return;
    closed = true;
    clearTimeout(idle);
    try { udp?.close(); } catch {}
    const payload = Buffer.alloc(2); payload.writeUInt16BE(code);
    socket.end(frame(0x8, payload));
  };
  const touch = () => { clearTimeout(idle); idle = setTimeout(() => close(1001), IDLE_MS); };
  touch();
  socket.on('error', () => close());
  socket.on('close', () => { closed = true; clearTimeout(idle); try { udp?.close(); } catch {} });
  socket.on('data', chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 2) {
      const fin = buffer[0] & 0x80, opcode = buffer[0] & 0x0f, masked = buffer[1] & 0x80;
      let length = buffer[1] & 0x7f, offset = 2;
      if (length === 126) { if (buffer.length < 4) return; length = buffer.readUInt16BE(2); offset = 4; }
      else if (length === 127) { if (buffer.length < 10) return; length = Number(buffer.readBigUInt64BE(2)); offset = 10; }
      if (!masked || length > 1 << 20) { close(1002); return; }
      if (buffer.length < offset + 4 + length) return;
      const mask = buffer.subarray(offset, offset + 4);
      const payload = Buffer.from(buffer.subarray(offset + 4, offset + 4 + length));
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      buffer = buffer.subarray(offset + 4 + length);
      if (opcode === 0x8) { close(); return; }
      if (opcode === 0x9) { socket.write(frame(0xA, payload)); continue; }
      if (opcode === 0xA) continue;
      fragments.push(payload);
      if (!fin) continue;
      const datagram = Buffer.concat(fragments); fragments = [];
      touch();
      if (udp) udp.send(datagram); else pending.push(datagram);
    }
  });
  try {
    const address = net.isIP(host) ? host : (await dns.lookup(host, {family: 4})).address;
    if (closed) return;
    if (!isPublicIPv4(address)) { close(1008); return; }
    udp = dgram.createSocket('udp4');
    udp.on('error', () => close(1011));
    udp.on('message', (msg, rinfo) => {
      if (rinfo.address !== address || rinfo.port !== port || closed) return;
      touch();
      socket.write(frame(0x2, msg));
    });
    udp.connect(port, address, () => { for (const d of pending.splice(0)) udp.send(d); });
  } catch {
    close(1011);
  }
}
