import assert from 'node:assert/strict';
import {GameAudio} from '../dist/audio.js';

const nodes = [], sources = [], pending = [];
function node() { const n = {gain: {value: 0}, playbackRate: {value: 0}, positionX: {value: 0}, positionY: {value: 0}, positionZ: {value: 0}, connect(target) { this.target = target; return target; }, disconnect() { this.disconnected = true; }}; nodes.push(n); return n; }
globalThis.AudioContext = class {
  constructor() { this.state = 'suspended'; this.destination = {}; this.listener = Object.fromEntries(['position', 'forward', 'up'].flatMap(p => ['X', 'Y', 'Z'].map(a => [p + a, {value: 0}]))); }
  async resume() { this.state = 'running'; }
  createGain() { return node(); }
  createBufferSource() { const n = node(); n.start = () => { n.started = true; }; sources.push(n); return n; }
  createPanner() { const n = node(); n.panner = true; return n; }
  createDynamicsCompressor() { const n = node(); n.limiter = true; for (const k of ['threshold', 'knee', 'ratio', 'attack', 'release']) n[k] = {value: 0}; return n; }
  async decodeAudioData(b) { return b; }
};
globalThis.fetch = path => new Promise(resolve => pending.push({path, resolve}));
const sound = new GameAudio(); await sound.unlock();
sound.listener({x: 10, y: 20, z: 30}, {x: 1, y: 0, z: 0}, {x: 0, y: 1, z: 0});
assert.ok(sound.master.target.limiter && sound.master.target.target === sound.context.destination, 'Mix is limited before the output');
assert.equal(sound.context.listener.positionX.value, 10);
assert.equal(sound.context.listener.forwardX.value, 1);
assert.equal(sound.context.listener.upY.value, 1);
const burst = Array.from({length: 40}, (_, i) => sound.play('same', 1, 1, {x: i, y: 5, z: 9}));
assert.equal(sound.active, 32, 'Voice limit applies while buffers are still downloading');
assert.equal(pending.length, 1, 'Concurrent voices share one decode');
pending.shift().resolve({ok: true, arrayBuffer: async () => new ArrayBuffer(8)});
await Promise.all(burst);
assert.equal(sources.length, 32);
const panners = nodes.filter(n => n.panner);
assert.equal(panners.length, 32);
assert.equal(panners[20].positionX.value, 20, 'Each voice retains its own source position');
assert.equal(panners[0].panningModel, 'HRTF');
sound.volume = .1; assert.equal(sound.master.gain.value, .1, 'Volume changes affect already-playing sounds');
for (const s of sources) s.onended();
assert.equal(sound.active, 0);
assert.ok(panners.every(p => p.disconnected), 'Spatial nodes are released');
const delayed = sound.play('late'); sound.reset();
pending.shift().resolve({ok: true, arrayBuffer: async () => new ArrayBuffer(8)});
await delayed;
assert.equal(sound.active, 0); assert.equal(sources.length, 32, 'Leaving a match cancels sounds awaiting download');
const local = sound.play('same'); await local;
assert.equal(nodes.filter(n => n.panner).length, 32, 'Local and menu sounds remain centered');
sources.at(-1).onended();
const failed = sound.play('missing');
pending.shift().resolve({ok: false}); await failed;
assert.equal(sound.active, 0); assert.equal(sound.buffers.has('missing'), false, 'Failed downloads do not leak voices or poison the cache');
console.log('PASS: listener orientation, positional voices, volume, decode sharing, voice limit, cancellation and cleanup');
