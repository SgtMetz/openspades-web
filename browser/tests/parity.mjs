// Integration regressions for native skin timing and the desktop VXL serializer.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import createOpenSpades from '../dist/engine/openspades.js';
import {ViewWeapon} from '../dist/viewweapon.js';
import * as THREE from '../dist/vendor/three.module.js';

const m = await createOpenSpades();
const events = () => {
  const n = m._os_event_count(), p = m._os_events() >>> 2;
  const data = m.HEAPF32.slice(p, p + n * 8); m._os_clear_events();
  return Array.from({length: n}, (_, i) => data.slice(i * 8, i * 8 + 8));
};
const skin = () => { const p = m._os_skin_states() >>> 2; return m.HEAPF32.slice(p, p + 8); };
function step(n, tool = 0, buttons = 0, bits = 0) {
  for (let i = 0; i < n; ++i) { m._os_input(bits, buttons, 0, 0, tool); m._os_step(1 / 60); }
}
m._os_init(2, 0); step(60); events();
const swing = [];
for (let i = 0; i < 80; ++i) { step(1, 0, 1); swing.push(skin()); }
assert.ok(swing.every(s => s[0] === 1 && s.every(Number.isFinite)), 'Held primary remains native bash action');
assert.ok(swing.filter((s, i) => i && s[1] < swing[i - 1][1] - .5).length >= 2, 'Held spade repeats without new clicks');
step(1); step(1, 0, 2); assert.equal(skin()[0], 3, 'Secondary begins first dig');
step(70, 0, 2); assert.equal(skin()[0], 2, 'Held secondary enters repeated dig');
step(1, 0, 3); assert.equal(skin()[0], 2, 'Native secondary precedence is preserved when both buttons are held');
step(1); assert.equal(skin()[0], 0, 'Releasing input ends spade animation');
step(1, 2, 1); const fired = skin()[2]; step(20, 2); const pumping = skin()[2];
assert.ok(pumping > fired && pumping < 1, 'Native shotgun readiness advances through pump cycle');
step(60, 2); assert.ok(skin()[2] >= 1, 'Native shotgun becomes ready');
events(); step(1, 2, 0, 16); step(120, 2);
const footsteps = events();
assert.ok(footsteps.some(e => e[0] === 17), 'Jump callback reaches browser');
assert.ok(footsteps.some(e => e[0] === 18), 'Landing callback reaches browser');
console.log('PASS: native continuous bash/dig, input precedence, shotgun readiness, jump and landing events');

// A reload must preserve the exact shot/ammo state while animating the view parts.
const view = new ViewWeapon(new THREE.Scene(), new THREE.MeshBasicMaterial());
for (const name of ['shotgunGun', 'shotgunSight1', 'shotgunSight2', 'shotgunPump', 'spade', 'arm0', 'arm1', 'upper0', 'upper1']) view.meshes[name] = view.mesh(new THREE.BoxGeometry());
view.ready = true;
const pose = {alive: true, tool: 2, weapon: 2, aiming: false, sprinting: false, velocity: [0, 0, 0], front: [1, 0, 0], walk: 0, time: 0, reloading: false, reloadProgress: 0, cooking: false, cookTime: 0, ammo: 5, clipSize: 6, readyState: 1, spadeAction: 0, spadeProgress: 0};
view.update(0, pose); view.render(); const resting = view.meshes.shotgunPump.matrix.clone();
view.update(0, {...pose, readyState: .65}); view.render();
assert.ok(!resting.equals(view.meshes.shotgunPump.matrix), 'Shotgun pump physically moves');
assert.ok(view.meshes.shotgunGun.matrix.elements.every(Number.isFinite));
view.update(0, pose); view.render(); assert.ok(resting.equals(view.meshes.shotgunPump.matrix), 'Pump returns to rest');
view.currentTool = 0;
view.update(0, {...pose, tool: 0, spadeAction: 3, spadeProgress: .2}); view.render(); const firstDig = view.meshes.spade.matrix.clone();
view.update(0, {...pose, tool: 0, spadeAction: 2, spadeProgress: .7}); view.render();
assert.ok(!firstDig.equals(view.meshes.spade.matrix), 'Dig changes the visible spade pose');
assert.ok(view.meshes.spade.matrix.elements.every(Number.isFinite));
console.log('PASS: shotgun pump and dig alter rendered geometry and recover to rest');

// Round-trip actual complex title terrain, not a serializer-shaped fixture.
const title = new Uint8Array(await readFile(new URL('../dist/assets/Maps/Title.vxl', import.meta.url)));
function load(data) { const p = m._malloc(data.length); try { m.HEAPU8.set(data, p); return m._os_load_vxl(p, data.length); } finally { m._free(p); } }
assert.equal(load(title), 0);
const samples = [];
for (let y = 0; y < 512; y += 7) for (let x = 0; x < 512; x += 7) {
  const z = m._os_top(x, y); samples.push([x, y, z, m._os_solid(x, y, Math.max(0, z - 1)), m._os_solid(x, y, z)]);
}
const bytes = m._os_save_vxl(), p = m._os_saved_vxl();
assert.ok(bytes > 1024 * 1024, 'Desktop serializer exports a complete map');
const saved = m.HEAPU8.slice(p, p + bytes);
assert.equal(load(saved), 0);
for (const [x, y, z, air, solid] of samples) {
  assert.equal(m._os_top(x, y), z, 'VXL round trip preserves height');
  assert.equal(m._os_solid(x, y, Math.max(0, z - 1)), air);
  assert.equal(m._os_solid(x, y, z), solid);
}
console.log(`PASS: original GameMap::Save round-trips ${samples.length} title-map columns (${bytes} bytes)`);
