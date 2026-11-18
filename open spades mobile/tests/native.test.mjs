// Tests web/native.js against a simulated Android shell (the WebMessageListener port). Run: node tests/native.test.mjs
import assert from 'node:assert/strict';

const sent = [];
const port = {onmessage: null, postMessage(s) { sent.push(JSON.parse(s)); }};
globalThis.OpenSpadesNative = port;
globalThis.document = {documentElement: {style: {props: {}, setProperty(k, v) { this.props[k] = v; }}}};
const N = await import('../web/native.js');
const shell = m => port.onmessage({data: JSON.stringify(m)});

assert.equal(N.isNative, true);
assert.deepEqual(sent.shift(), {op: 'ready'});

// open → shell confirms → send base64 datagrams → receive a batch → remote close
const s = N.openDatagramSocket('203.0.113.5', 32887);
assert.ok(s instanceof N.NativeUdpSocket);
assert.deepEqual(sent.shift(), {op: 'udp', ev: 'open', id: s.id, host: '203.0.113.5', port: 32887});
s.send(new Uint8Array([1, 2, 3]));
assert.equal(sent.length, 0, 'nothing is sent before the socket opens');
let opened = false; s.onopen = () => { opened = true; };
shell({op: 'udp', ev: 'open', id: s.id});
assert.ok(opened); assert.equal(s.readyState, 1);

const big = new Uint8Array(70000).map((_, i) => i * 7);
s.send(big.subarray(10, 1410));                 // a view into a larger buffer: only the view's bytes go out
const out = sent.shift();
assert.equal(out.ev, 'send');
assert.deepEqual([...Buffer.from(out.data, 'base64')], [...big.subarray(10, 1410)]);

const got = []; s.onmessage = e => got.push([...new Uint8Array(e.data)]);
shell({op: 'udp', ev: 'data', id: s.id, data: [Buffer.from([9, 8]).toString('base64'), Buffer.from([255, 0, 7]).toString('base64')]});
assert.deepEqual(got, [[9, 8], [255, 0, 7]]);

let closed = null; s.onclose = e => { closed = e; };
shell({op: 'udp', ev: 'close', id: s.id, code: 1011, reason: 'The network connection was lost.'});
assert.equal(closed.reason, 'The network connection was lost.'); assert.equal(s.readyState, 3);
s.send(new Uint8Array([1])); assert.equal(sent.length, 0, 'no sends after close');

// local close notifies the shell once
const t = N.openDatagramSocket('example.org', 1); sent.length = 0;
shell({op: 'udp', ev: 'open', id: t.id}); t.close(); t.close();
assert.deepEqual(sent, [{op: 'udp', ev: 'close', id: t.id}]);

// insets become CSS variables; haptics can be switched off
shell({op: 'insets', top: 0, right: 0, bottom: 12.5, left: 32});
assert.equal(document.documentElement.style.props['--native-left'], '32px');
sent.length = 0; N.haptic('hit'); N.setHaptics(false); N.haptic('hit');
assert.deepEqual(sent, [{op: 'haptic', kind: 'hit'}]);
console.log('native bridge: all tests passed');
