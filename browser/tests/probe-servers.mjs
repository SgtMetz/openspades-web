// Checks which public servers accept a connection through a relay (or directly over UDP), without joining a game.
// For each server in the Build and Shoot list it connects, waits until the map has downloaded (accepted: the player
// could now pick a team) or the server disconnects (refused, with its reason), then disconnects without joining.
// Some servers (aloha.pk) accept the handshake and only ban a VPN/datacenter address during the map download.
// Usage: [SERVERLIST=url] RELAY=wss://example.org RELAY_ORIGIN=https://example.org node tests/probe-servers.mjs [--direct] [--json] [--only=text]
// GPL-3.0-or-later.
import dgram from 'node:dgram';
import createOpenSpades from '../dist/engine/openspades.js';

const direct = process.argv.includes('--direct'), asJson = process.argv.includes('--json');
const base = process.env.RELAY || 'ws://127.0.0.1:8080';
const origin = process.env.RELAY_ORIGIN || base.replace(/^ws(s?):/, 'http$1:');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const ipOf = id => { const m = /^aos:\/\/(\d+):(\d+)/.exec(id); if (!m) return null; const n = Number(m[1]); return {host: [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, n >>> 24].join('.'), port: Number(m[2])}; };

const m = await createOpenSpades();
const drain = () => { const t = m.UTF8ToString(m._os_net_messages()); m._os_net_clear_messages(); return t.split('\x1e').filter(Boolean).map(r => r.split('\x1f')); };

async function probe(server) {
  const target = ipOf(server.identifier);
  if (!target) return {result: 'bad address'};
  const queue = []; let close = () => {}, transportClosed = null;
  if (direct) {
    const udp = dgram.createSocket('udp4');
    udp.on('message', msg => queue.push(new Uint8Array(msg)));
    udp.on('error', () => {});
    udp.connect(target.port, target.host); await new Promise(r => udp.once('connect', r));
    m.osNet = {queue, send: d => { udp.send(d); return d.length; }};
    close = () => udp.close();
  } else {
    const ws = new WebSocket(`${base}/relay?host=${target.host}&port=${target.port}`, {headers: {Origin: origin}});
    ws.binaryType = 'arraybuffer';
    const outbox = [];
    ws.onopen = () => { for (const d of outbox.splice(0)) ws.send(d); };
    ws.onmessage = e => queue.push(new Uint8Array(e.data));
    ws.onclose = e => { transportClosed = e.code; };
    ws.onerror = () => {};
    m.osNet = {queue, send: d => { if (ws.readyState === 1) ws.send(d); else if (ws.readyState === 0) outbox.push(d); return d.length; }};
    close = () => { try { ws.close(); } catch {} };
  }
  if (m._os_net_connect(server.game_version === '0.76' ? 4 : 3) !== 0) { close(); return {result: 'client error'}; }
  const started = Date.now(); let reason = '', status = 1;
  while (Date.now() - started < 30000) {
    status = m._os_net_poll();
    for (const [k, a] of drain()) if (k === 'D') reason = a;
    if (status >= 3 || transportClosed !== null) break;
    await sleep(10);
  }
  const ms = Date.now() - started;
  m._os_net_disconnect(); for (let i = 0; i < 20; i++) { m._os_net_poll(); await sleep(5); }
  close();
  if (status === 3) return {result: 'accepted', ms};
  if (status === 2) return {result: 'map stalled', ms};
  if (status === 4) return {result: 'refused', reason: reason || 'disconnected', ms};
  if (transportClosed !== null) return {result: 'relay closed', reason: `code ${transportClosed}`, ms};
  return {result: 'no response', ms};
}

const only = (process.argv.find(a => a.startsWith('--only=')) || '').slice(7);
const list = (await (await fetch(process.env.SERVERLIST || 'https://services.buildandshoot.com/serverlist.json')).json()).filter(s => s && s.identifier && (!only || s.identifier.includes(only)));
const results = [];
for (const s of list) {
  const r = await probe(s);
  results.push({identifier: s.identifier, ip: ipOf(s.identifier)?.host, name: s.name, version: s.game_version, ...r});
  if (!asJson) console.log(`${r.result.padEnd(12)} ${(r.reason || '').slice(0, 40).padEnd(40)} ${s.identifier.padEnd(24)} ${s.name}`);
}
if (asJson) console.log(JSON.stringify(results, null, 1));
process.exit(0);
