// Live multiplayer test: connects the WebAssembly client to a real public AoS server.
// Usage: node tests/live.mjs [aos://... | host:port] [--via-relay] [--version=0.75|0.76]
// Requires internet access. With --via-relay, traffic goes through server.mjs's WebSocket relay.
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import createOpenSpades from '../dist/engine/openspades.js';

const args = process.argv.slice(2);
const viaRelay = args.includes('--via-relay');
let target = args.find(a => !a.startsWith('--'));
let version = (args.find(a => a.startsWith('--version=')) || '').split('=')[1];
function parseAddress(text) {
  const m = /^(?:aos:\/\/)?([^:/]+)(?::(\d+))?/.exec(text.trim());
  if (!m) throw Error('Bad address ' + text);
  let host = m[1];
  if (/^\d+$/.test(host)) { const n = Number(host); host = [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, n >>> 24].join('.'); }
  return {host, port: Number(m[2] || 32887)};
}
if (!target) {
  const list = await (await fetch('https://services.buildandshoot.com/serverlist.json')).json();
  const pick = list.filter(s => s.players_current < s.players_max).sort((a, b) => a.latency - b.latency)[0];
  target = pick.identifier; version ??= pick.game_version;
  console.log(`Using ${pick.name} (${pick.identifier}, ${pick.game_version}, map ${pick.map})`);
}
const {host, port} = parseAddress(target);
const m = await createOpenSpades();
const queue = [];
let transport;
if (viaRelay) {
  const base = process.env.RELAY || 'ws://127.0.0.1:8080';
  // RELAY_ORIGIN / RELAY_COOKIE: for a hosted relay (wss://...) behind the site's PIN session cookie
  const headers = {Origin: process.env.RELAY_ORIGIN || base.replace(/^ws(s?):/, 'http$1:')};
  if (process.env.RELAY_COOKIE) headers.Cookie = process.env.RELAY_COOKIE;
  const ws = new WebSocket(`${base}/relay?host=${host}&port=${port}`, {headers});
  ws.binaryType = 'arraybuffer';
  const outbox = [];
  ws.onopen = () => { for (const d of outbox.splice(0)) ws.send(d); };
  ws.onmessage = e => queue.push(new Uint8Array(e.data));
  ws.onclose = e => console.log('Relay closed', e.code);
  transport = d => { if (ws.readyState === 1) ws.send(d); else outbox.push(d); return d.length; };
} else {
  const udp = dgram.createSocket('udp4');
  udp.on('message', msg => queue.push(new Uint8Array(msg)));
  udp.connect(port, host);
  await new Promise(r => udp.once('connect', r));
  transport = d => { udp.send(d); return d.length; };
  process.on('exit', () => udp.close());
}
m.osNet = {queue, send: transport};
const info = () => { const p = m._os_net_info() >>> 2; return m.HEAPF32.slice(p, p + 64); };
const state = () => { const p = m._os_state() >>> 2; return m.HEAPF32.slice(p, p + 32); };
function drainMessages() {
  const text = m.UTF8ToString(m._os_net_messages()); m._os_net_clear_messages();
  return text.split('\x1e').filter(Boolean).map(r => r.split('\x1f'));
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
assert.equal(m._os_net_connect(version === '0.76' ? 4 : 3), 0);
const started = Date.now();
let lastLog = 0, status = 0;
while (Date.now() - started < 60000) {
  status = m._os_net_poll();
  for (const [k, a, b] of drainMessages()) if (k === 'D' || k === 'L' || k === 'J') console.log('message', k, a, b ?? '');
  if (status === 3 || status === 4) break;
  if (Date.now() - lastLog > 2000) { lastLog = Date.now(); console.log('status', status, 'map bytes', info()[1]); }
  await sleep(10);
}
assert.equal(status, 3, 'Connected and map loaded');
let i = info();
assert.ok(i[3] >= 0, 'Server assigned a local player id');
let solidCount = 0;
for (let x = 0; x < 512; x += 8) for (let y = 0; y < 512; y += 8) if (m._os_top(x, y) < 63) solidCount++;
assert.ok(solidCount > 100, 'Decoded map has terrain');
let vertices = 0;
for (let c = 0; c < 1024; c += 37) vertices += m._os_mesh(c);
assert.ok(vertices > 0, 'Downloaded map produces geometry');
console.log(`PASS: handshake, map download (${Math.round(i[1] || 0)} B left buffered) and VXL decode; local id ${i[3]}, mode ${i[4] ? 'TC' : 'CTF'}`);
console.log('Teams:', m.UTF8ToString(m._os_team_name(0)), '/', m.UTF8ToString(m._os_team_name(1)));

const name = m.stringToNewUTF8('BrowserPortTest');
m._os_net_join(0, 0, name); m._free(name);
let spawned = false, frames = 0;
const tJoin = Date.now();
while (Date.now() - tJoin < 15000) {
  m._os_net_poll();
  for (const r of drainMessages()) if (r[0] === 'S') spawned = true;
  m._os_net_input(0, 0, 0, 0, 2); m._os_net_step(1 / 60); frames++;
  if (spawned && state()[28]) break;
  await sleep(16);
}
assert.ok(state()[28] && state()[17], 'Local player spawned by server');
const s0 = state();
console.log(`PASS: joined team 0 and spawned at ${s0[0].toFixed(1)}, ${s0[1].toFixed(1)}, ${s0[2].toFixed(1)} with ${s0[7]} rounds`);
let others = 0; const slots = m._os_player_slots(), pp = m._os_players() >>> 2;
for (let k = 0; k < slots; k++) if (m.HEAPF32[pp + k * 16 + 11] && !m.HEAPF32[pp + k * 16 + 14]) others++;
console.log(`Other players visible: ${others}`);

// Walk forward for two seconds, then fire one shot.
const tWalk = Date.now();
while (Date.now() - tWalk < 2000) { m._os_net_poll(); m._os_net_input(1, 0, 0.3, 0, 2); m._os_net_step(1 / 60); await sleep(16); }
const s1 = state();
const moved = Math.hypot(s1[0] - s0[0], s1[1] - s0[1]);
assert.ok(moved > 1 || !s1[17], 'Local movement simulated');
m._os_net_input(0, 1, 0.3, 0, 2); m._os_net_step(1 / 60); m._os_net_poll();
for (let k = 0; k < 30; k++) { m._os_net_input(0, 0, 0.3, 0, 2); m._os_net_step(1 / 60); m._os_net_poll(); await sleep(16); }
assert.ok(state()[7] < s0[7] || !state()[17], 'Shot consumed ammo');
// Stay connected for a few seconds to make sure the server accepts our traffic.
const tStay = Date.now();
while (Date.now() - tStay < 4000) { assert.equal(m._os_net_poll(), 3, 'Still connected'); m._os_net_input(0, 0, 0.3, 0, 2); m._os_net_step(1 / 60); await sleep(16); }
console.log(`PASS: moved ${moved.toFixed(1)} blocks, fired, still connected; ping ${info()[2]} ms`);
m._os_net_disconnect();
console.log('Live multiplayer test passed.');
process.exit(0);
