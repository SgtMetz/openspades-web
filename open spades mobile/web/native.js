// Bridge to the Android shell (MainActivity). GPL-3.0-or-later.
// The shell injects `OpenSpadesNative` with WebViewCompat.addWebMessageListener. Messages are JSON strings.
// Without the shell (desktop browser preview) everything falls back to web APIs.
const port = globalThis.OpenSpadesNative || null;
export const isNative = !!port;
const sockets = new Map(), handlers = {};
let nextId = 1;

function post(message) { port?.postMessage(JSON.stringify(message)); }
function toBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
function fromBase64(text) {
  const s = atob(text), out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

if (port) {
  port.onmessage = event => {
    let m; try { m = JSON.parse(event.data); } catch { return; }
    if (m.op === 'udp') {
      const s = sockets.get(m.id); if (!s) return;
      if (m.ev === 'open') { s.readyState = 1; s.onopen?.(); }
      else if (m.ev === 'data') for (const d of m.data) s.onmessage?.({data: fromBase64(d).buffer});
      else if (m.ev === 'close') { sockets.delete(m.id); s.readyState = 3; s.onclose?.({code: m.code || 1000, reason: m.reason || ''}); }
      return;
    }
    handlers[m.op]?.(m);
  };
}

/** WebSocket-shaped UDP socket: each message is one ENet datagram, exactly like the web relay. */
export class NativeUdpSocket {
  constructor(host, port) {
    this.id = nextId++; this.readyState = 0; this.binaryType = 'arraybuffer';
    this.onopen = this.onmessage = this.onclose = this.onerror = null;
    sockets.set(this.id, this);
    post({op: 'udp', ev: 'open', id: this.id, host, port});
  }
  send(data) {
    if (this.readyState !== 1) return;
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data.buffer ?? data, data.byteOffset ?? 0, data.byteLength);
    post({op: 'udp', ev: 'send', id: this.id, data: toBase64(bytes)});
  }
  close() {
    if (this.readyState >= 2) return;
    this.readyState = 3; sockets.delete(this.id);
    post({op: 'udp', ev: 'close', id: this.id});
  }
}

/** Opens a datagram channel to an AoS server: native UDP in the app, the WebSocket relay elsewhere. */
export function openDatagramSocket(host, udpPort) {
  if (port) return new NativeUdpSocket(host, udpPort);
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/relay?host=${encodeURIComponent(host)}&port=${udpPort}`);
  ws.binaryType = 'arraybuffer';
  return ws;
}

/** Saves a file: Android's "Save to…" picker in the app, a download link elsewhere. */
export async function saveFile(blob, name) {
  if (port) {
    post({op: 'save', name, mime: blob.type || 'application/octet-stream', data: toBase64(new Uint8Array(await blob.arrayBuffer()))});
    return;
  }
  const url = URL.createObjectURL(blob), link = document.createElement('a');
  link.href = url; link.download = name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}

let hapticsEnabled = true;
export function setHaptics(on) { hapticsEnabled = on; }
/** Short vibration. kind: 'tap' | 'hit' | 'hurt' | 'heavy'. */
export function haptic(kind = 'tap') {
  if (!hapticsEnabled) return;
  if (port) post({op: 'haptic', kind});
  else navigator.vibrate?.({tap: 8, hit: 15, hurt: 35, heavy: 60}[kind] || 10);
}
export function openExternal(url) { if (port) post({op: 'open', url}); else open(url, '_blank', 'noopener'); }
export function setKeepAwake(on) { post({op: 'keepAwake', on: !!on}); }
export function setGameActive(on) { post({op: 'gameActive', on: !!on}); }
export function exitApp() { post({op: 'exit'}); }
export function onNative(op, fn) { handlers[op] = fn; }
/** The local player just died: the app may show a full-screen ad (it applies its own cooldown). */
export function playerDied() { post({op: 'died'}); }
/** Opens Google's consent form again (Settings → Privacy & ad choices). */
export function showPrivacyOptions() { post({op: 'privacyOptions'}); }

// Safe-area insets pushed by the shell (in CSS pixels).
onNative('insets', m => {
  const s = document.documentElement.style;
  for (const k of ['top', 'right', 'bottom', 'left']) s.setProperty(`--native-${k}`, `${Math.max(0, Number(m[k]) || 0)}px`);
});
if (port) post({op: 'ready'});
