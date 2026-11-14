import assert from 'node:assert/strict';
import {detectTouch, TouchControls} from '../dist/touch.js';

const desktop = {userAgent:'Windows', platform:'Win32', maxTouchPoints:0};
assert.equal(detectTouch(desktop, () => ({matches:false}), ''), false);
assert.equal(detectTouch({...desktop,userAgent:'iPhone'}, () => ({matches:false}), ''), true);
assert.equal(detectTouch({...desktop,platform:'MacIntel',maxTouchPoints:5}, () => ({matches:false}), ''), true);
assert.equal(detectTouch({...desktop,maxTouchPoints:2}, () => ({matches:true}), ''), true);
assert.equal(detectTouch(desktop, () => ({matches:false}), '?touch=1'), true);
assert.equal(detectTouch({...desktop,userAgent:'Android'}, () => ({matches:true}), '?touch=0'), false);

// Exercise separate pointer ownership and cancellation without requiring browser-specific touch emulation.
class Element {
  constructor(dataset = {}, kind = '') {
    this.dataset = dataset; this.kind = kind; this.captured = new Set(); this.style = {};
    this.classList = {add(){},remove(){}};
  }
  addEventListener() {}
  closest(selector) { return selector === 'button' && this.kind === 'button' || selector === '#touch-stick' && this.kind === 'stick' ? this : null; }
  setPointerCapture(id) { this.captured.add(id); }
  hasPointerCapture(id) { return this.captured.has(id); }
  releasePointerCapture(id) { this.captured.delete(id); }
  getBoundingClientRect() { return {left:0,top:0,width:100,height:100}; }
}
const root = new Element(), stick = new Element({},'stick'), knob = new Element();
root.querySelector = selector => selector === '#touch-stick' ? stick : knob;
const win = {addEventListener(){},document:{addEventListener(){}}};
const looks = [], actions = []; let shots = 0;
const controls = new TouchControls(root, {look:(...p)=>looks.push(p),action:code=>actions.push(code),fire:()=>shots++}, win);
const event = (pointerId, target, clientX = 50, clientY = 50) => ({pointerId,target,clientX,clientY,button:0,preventDefault(){}});
const fire = new Element({mouse:'1'},'button'), aim = new Element({mouse:'2'},'button'), jump = new Element({key:'Space'},'button');
controls.setActive(true);
controls.down(event(1,stick,80,10));
assert.ok(controls.keys.has('KeyW') && controls.keys.has('KeyD'), 'Diagonal movement');
controls.down(event(2,root,200,100)); controls.move(event(2,root,220,90));
assert.deepEqual(looks,[[20,-10]],'Swipe-to-look is independent of movement');
controls.down(event(3,fire)); controls.down(event(4,aim)); controls.down(event(5,jump));
assert.equal(controls.buttons,3,'Simultaneous firing and aiming');
assert.equal(shots,1); assert.ok(controls.keys.has('Space') && controls.keys.has('KeyW'));
controls.up(event(4,aim));
assert.equal(controls.buttons,1,'Releasing aim preserves firing');
controls.up(event(1,stick));
assert.equal(controls.keys.has('KeyW'),false); assert.ok(controls.keys.has('Space'));
assert.equal(controls.buttons,1,'Releasing joystick preserves firing');
controls.up(event(3,fire)); assert.equal(controls.buttons,0,'Grenade/fire release clears native button');
controls.down(event(6,new Element({action:'KeyR'},'button'))); assert.deepEqual(actions,['KeyR']);
controls.reset(); assert.equal(controls.keys.size,0); assert.equal(controls.pointers.size,0);
assert.equal(controls.buttons,0); assert.equal(root.captured.size,0); assert.equal(stick.captured.size,0);
controls.setActive(false); controls.down(event(7,fire)); assert.equal(controls.buttons,0,'Menus reject touch input');

// Opening a menu during pointerdown may reset capture immediately; it must leave no held keys or buttons.
controls.action = () => controls.setActive(false); controls.setActive(true);
controls.down(event(8,new Element({action:'menu'},'button')));
assert.equal(controls.pointers.size,0); assert.equal(controls.buttons,0);

// main.js constructs TouchControls without a fire callback; Fire / Use must still hold mouse button 1.
const plain = new TouchControls(root, {look(){}, action(){}}, win); plain.setActive(true);
plain.down(event(9, new Element({mouse:'1'},'button')));
assert.equal(plain.buttons, 1);
console.log('PASS: phone/tablet detection, overrides, multitouch move/look/aim/fire/jump, independent releases, reset, menu transitions, fire without callback');
