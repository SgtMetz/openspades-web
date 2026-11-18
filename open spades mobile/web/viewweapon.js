// First-person view weapon: a port of OpenSpades' Scripts/Skin/*/View.as, BasicViewWeapon.as and
// ClientPlayer::AddToSceneFirstPersonView (arms). Everything is computed in OpenSpades eye space
// (x = left, y = forward, z = down) and converted for three.js at the end.
import * as THREE from './vendor/three.module.js';
import {loadModel} from './models.js';

const E = new THREE.Matrix4().set(-1, 0, 0, 0, 0, 0, -1, 0, 0, -1, 0, 0, 0, 0, 0, 1); // eye space -> camera space
const L = new THREE.Matrix4().set(1, 0, 0, 0, 0, 0, -1, 0, 0, -1, 0, 0, 0, 0, 0, 1);  // loadModel's axis mapping (an involution)
const T = (x, y, z) => new THREE.Matrix4().makeTranslation(x, y, z);
const Tv = v => T(v.x, v.y, v.z);
const S = s => new THREE.Matrix4().makeScale(s, s, s);
const R = (x, y, z, a) => new THREE.Matrix4().makeRotationAxis(new THREE.Vector3(x, y, z).normalize(), a);
const mul = (...m) => m.reduce((a, b) => a.clone().multiply(b));
const V = (x, y, z) => new THREE.Vector3(x, y, z);
const apply = (m, x, y, z) => V(x, y, z).applyMatrix4(m);
const mix = (a, b, t) => a.clone().lerp(b, t);
const smooth = x => x * x * (3 - 2 * x);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

const PARTS = {
  rifleGun: 'Weapons/Rifle/WeaponNoMagazine', rifleMag: 'Weapons/Rifle/Magazine', rifleSight1: 'Weapons/Rifle/Sight1', rifleSight2: 'Weapons/Rifle/Sight2',
  smgGun: 'Weapons/SMG/WeaponNoMagazine', smgMag: 'Weapons/SMG/Magazine', smgSight1: 'Weapons/SMG/Sight1', smgSight2: 'Weapons/SMG/Sight2', smgSight3: 'Weapons/SMG/Sight3',
  shotgunGun: 'Weapons/Shotgun/WeaponNoPump', shotgunPump: 'Weapons/Shotgun/Pump', shotgunSight1: 'Weapons/Shotgun/Sight1', shotgunSight2: 'Weapons/Shotgun/Sight2',
  spade: 'Weapons/Spade/Spade', grenade: 'Weapons/Grenade/Grenade',
};
/** Zoom per weapon (Client::GetAimDownZoomScale). */
const ZOOM_DELTA = [1.4, .8, .4];

export class ViewWeapon {
  constructor(scene, material) {
    this.root = new THREE.Group(); scene.add(this.root);
    this.material = material; this.meshes = {}; this.ready = false;
    this.ads = 0; this.raise = 1; this.currentTool = 2; this.sprint = 0; this.sprintSmooth = 0; this.vibration = 0;
    this.swing = V(0, 0, 0); this.lastFront = null; this.armColor = -1; this.blockColor = -1;
  }
  async load() {
    const entries = await Promise.all(Object.entries(PARTS).map(async ([k, n]) => [k, await loadModel(n)]));
    for (const [k, g] of entries) this.meshes[k] = this.mesh(g);
    for (const k of ['arm0', 'arm1', 'upper0', 'upper1', 'block']) this.meshes[k] = this.mesh(null);
    this.ready = true;
  }
  mesh(g) {
    const m = new THREE.Mesh(g || new THREE.BufferGeometry(), this.material);
    m.matrixAutoUpdate = false; m.frustumCulled = false; m.visible = false; this.root.add(m);
    return m;
  }
  setArmColor(color) {
    if (this.armColor === color) return; this.armColor = color;
    Promise.all([loadModel('Player/Arm', color), loadModel('Player/UpperArm', color)]).then(([a, u]) => {
      if (this.armColor !== color) return;
      this.meshes.arm0.geometry = this.meshes.arm1.geometry = a; this.meshes.upper0.geometry = this.meshes.upper1.geometry = u;
    }).catch(() => {});
  }
  setBlockColor(color) {
    if (this.blockColor === color) return; this.blockColor = color;
    loadModel('Weapons/Block/Block2', color).then(g => { if (this.blockColor === color) this.meshes.block.geometry = g; }).catch(() => {});
  }
  fired() { this.vibration = 1; }
  /** Raw aim-down-sight state (0..1) as used by Draw2D. */
  get aimDownState() { return this.ads; }
  /** Client::GetAimDownZoomScale for the current weapon. */
  zoomScale(tool, weapon) {
    if (tool !== 2) return 1;
    const a = this.ads;
    return 1 + (3 - 2 * Math.pow(a, 1.5)) * Math.pow(a, 3) * ZOOM_DELTA[weapon];
  }
  /**
   * p: {alive, tool, weapon, aiming, sprinting, velocity [x,y,z], front [x,y,z], walk, time, reloading,
   *     reloadProgress, cooking, cookTime, ammo, clipSize}
   */
  update(dt, p) {
    // ClientPlayer::Update: aim-down-sight, tool raise and sprint states.
    if (p.aiming && p.tool === 2 && p.alive) this.ads = Math.min(1, this.ads + dt * 8);
    else this.ads = Math.max(0, this.ads - dt * 3);
    if (this.currentTool === p.tool) this.raise = Math.min(1, this.raise + dt * 4);
    else { this.raise -= dt * 4; if (this.raise < 0) { this.raise = 0; this.currentTool = p.tool; } }
    this.sprint = p.sprinting ? Math.min(1, this.sprint + dt * 5) : Math.max(0, this.sprint - dt * 5);
    const ss = this.sprint * this.sprint;
    this.sprintSmooth = ss > this.sprintSmooth ? this.sprintSmooth + (ss - this.sprintSmooth) * (1 - Math.pow(.001, dt)) : ss;
    this.vibration = Math.max(0, this.vibration - dt * 10);
    // View weapon sway from movement and camera rotation.
    const front = V(...p.front), right = V(-front.y, front.x, 0).normalize(), up = front.clone().cross(right).normalize().negate();
    if (Math.abs(front.z) > .999) right.set(1, 0, 0);
    const vel = V(...p.velocity);
    this.swing.x += vel.dot(right) * dt; this.swing.y -= vel.dot(front) * dt; this.swing.z += vel.dot(up) * dt;
    if (this.lastFront) { const d = front.clone().sub(this.lastFront); this.swing.x += d.dot(right) * .05; this.swing.z += d.dot(up) * .05; }
    this.lastFront = front;
    if (dt > 0) this.swing.multiplyScalar(Math.pow(.02, dt));
    const soft = (v, lo, hi) => { const t = (hi - lo) / 2; if (v < lo) v += (lo - v) * Math.min(1, (lo - v) / t); if (v > hi) v += (hi - v) * Math.min(1, (v - hi) / t); return v; };
    this.swing.x = soft(this.swing.x, -.06, .06); this.swing.y = soft(this.swing.y, -.06, .06); this.swing.z = soft(this.swing.z, -.06, .06);
    // While aiming down the sight, keep the weapon nearly still so the sights stay lined up.
    if (this.currentTool === 2 && p.aiming && p.alive) {
      if (dt > 0) this.swing.multiplyScalar(Math.pow(.01, dt));
      this.swing.x = soft(this.swing.x, -.003, .003); this.swing.z = soft(this.swing.z, 0, .003);
    }
    this.state = p; this.speed = vel.length();
  }
  /** Places every part for this frame. Returns false when nothing should be drawn. */
  render() {
    for (const m of Object.values(this.meshes)) m.visible = false;
    const p = this.state;
    if (!this.ready || !p || !p.alive) return false;
    // ClientPlayer::AddToSceneFirstPersonView: walk bobbing, slow pulse.
    const swing = this.swing.clone(), sp0 = 1 - this.ads;
    { const sp = sp0 * .3 * Math.min(1, this.speed * 5); swing.x += Math.sin(p.walk * Math.PI * 2) * .013 * sp; const vl = Math.cos(p.walk * Math.PI * 2); swing.z += vl * vl * .018 * sp; }
    { const vl = Math.sin(p.time); swing.x += vl * .001 * sp0; swing.y += vl * .0007 * sp0; swing.z += vl * .003 * sp0; }
    const tool = this.currentTool;
    const hands = tool === 2 ? this.weapon(p, swing) : tool === 0 ? this.spade(swing) : tool === 1 ? this.block(swing) : this.grenadeView(p, swing);
    if (hands) this.arms(hands[0], hands[1]);
    return true;
  }
  place(name, m) { const mesh = this.meshes[name]; mesh.matrix.copy(mul(E, m, L)); mesh.matrixWorldNeedsUpdate = true; mesh.visible = true; }
  adsSmooth() { return smooth(this.ads); }
  /** BasicViewWeapon::GetViewWeaponMatrix */
  viewWeaponMatrix(zpos, swing) {
    const a = this.adsSmooth(), motion = 1 - a * .4;
    let mat = new THREE.Matrix4();
    const s = this.sprintSmooth;
    if (s > 0) mat = mul(T(.23 * s, -.05 * s, .15 * s), R(0, 0, 1, s * -.55), R(1, 0, 0, s * .3), R(0, 1, 0, s * -.1), mat);
    if (this.raise < 1) { const d = 1 - this.raise; mat = mul(T(.1 * d, -.3 * d, .1 * d), R(0, 1, 0, d * .2), R(0, 0, 1, d * -1.3), mat); }
    const vib = this.vibration;
    const hip = V(Math.sin(vib * Math.PI * 2) * .008 * motion, vib * (vib - 1) * .14 * motion, vib * (1 - vib) * .03 * motion);
    const fire = mix(hip, V(0, vib * (vib - 1) * vib * .3 * motion, 0), a);
    const trans = V(-.13 * (1 - a), .5, zpos).add(swing.clone().multiplyScalar(motion)).add(fire);
    return mul(Tv(trans), mat);
  }
  /** Rotates the gun so the sight lands in the screen center (AdjustToAlignSight). */
  align(mat, sight, fade) {
    const p = sight.clone().applyMatrix4(mat);
    mat = mul(R(0, 0, 1, Math.atan(p.x / p.y) * fade), mat);
    return mul(R(-1, 0, 0, Math.atan(p.z / p.y) * fade), mat);
  }
  weapon(p, swing) {
    const a = this.adsSmooth(), w = p.weapon;
    let mat = mul(this.viewWeaponMatrix([.2 - a * .052, .2 - a * .038, .2 - a * .0535][w], swing), S(.033));
    let reload = p.reloadProgress;
    if (w === 0) {
      let left = apply(mat, 1, 6, 1), right = apply(mat, 0, -8, 2);
      const left2 = apply(mat, 5, -10, 4), right3 = apply(mat, -2, -7, -4), right4 = apply(mat, -3, -4, -6);
      if (a > .8) mat = this.align(mat, V(0, 16, -4.6), (a - .8) / .2);
      this.place('rifleGun', mul(mat, S(.5), T(-.5, 0, 0)));
      this.place('rifleSight1', mul(mat, T(.0125, -8, -4.5), S(.025)));
      this.place('rifleSight2', mul(mat, T(.025, 16, -4.575), S(.05)));
      mat = mul(mat, T(0, 1, 1)); reload *= 2.5;
      if (p.reloading) {
        if (reload < .1) left = mix(left, apply(mat, 0, 0, 4), smooth(reload / .1));
        else if (reload < .7) {
          let per = (reload - .1) / .6;
          if (per < .2) per = clamp(per * 4 - .4, 0, .2);
          if (per > .5) per += per - .5;
          mat = mul(mat, T(0, 0, per * per * 10)); left = apply(mat, 0, 0, 4);
          if (per > .5) left = mix(left, left2, smooth(per - .5));
        } else if (reload < 1.4) {
          let per = (1.4 - reload) / .7;
          if (per < .3) per = clamp(per * 4 - .4, 0, .3);
          mat = mul(mat, T(0, 0, per * per * 10)); left = apply(mat, 0, 0, 4);
        } else if (reload < 1.9) {
          const per = (reload - 1.4) / .5, orig = left;
          left = mix(apply(mat, 0, 0, 4), orig, smooth(per)); right = mix(right, right3, smooth(per));
        } else if (reload < 2.2) right = mix(right3, right4, smooth((reload - 1.9) / .3));
        else right = mix(right4, right, smooth((reload - 2.2) / .3));
      }
      this.place('rifleMag', mat);
      return [left, right];
    }
    if (w === 1) {
      let left = apply(mat, 1, 6, 1); const right = apply(mat, 0, -8, 4);
      const left2 = apply(mat, 5, -10, 4), left3 = apply(mat, 1, 6, -4), left4 = apply(mat, 1, 9, -6);
      if (a > .8) mat = this.align(mat, V(0, 5, -4.9), (a - .8) / .2);
      this.place('smgGun', mat);
      this.place('smgSight1', mul(mat, T(.05, 5, -4.85), S(.1)));
      this.place('smgSight3', mul(mat, T(.025, 5, -4.875), S(.05)));
      this.place('smgSight2', mul(mat, T(.04, -9, -4.9), S(.08)));
      mat = mul(mat, T(0, 3, 1)); reload *= 2.5;
      if (p.reloading) {
        if (reload < .7) { const per = reload / .7; mat = mul(mat, T(0, 0, per * per * 50)); left = mix(left, left2, smooth(per)); }
        else if (reload < 1.4) { let per = (1.4 - reload) / .7; if (per < .3) per = clamp(per * 4 - .4, 0, .3); mat = mul(mat, T(0, 0, per * per * 10)); left = apply(mat, 0, 0, 4); }
        else if (reload < 1.9) left = mix(apply(mat, 0, 0, 4), left3, smooth((reload - 1.4) / .5));
        else if (reload < 2.2) left = mix(left3, left4, smooth((reload - 1.9) / .3));
        else left = mix(left4, left, smooth((reload - 2.2) / .3));
      }
      this.place('smgMag', mat);
      return [left, right];
    }
    const right = apply(mat, 0, -8, 2), left2 = apply(mat, 5, -10, 4), left3 = apply(mat, 1, 1, 2);
    if (a > .8) mat = this.align(mat, V(0, 8.5, -4.4), (a - .8) / .2);
    this.place('shotgunGun', mat);
    this.place('shotgunSight1', mul(mat, T(.025, -9, -4.4), S(.05)));
    this.place('shotgunSight2', mul(mat, T(.025, 8.5, -4.4), S(.05)));
    reload *= .5;
    let left = apply(mat, 0, 4, 2);
    if (p.reloading) {
      if (reload < .2) left = mix(left, left2, smooth(reload / .2));
      else if (reload < .35) left = mix(left2, left3, smooth((reload - .2) / .15));
      else if (reload < .5) left = mix(left3, left, smooth((reload - .35) / .15));
    }
    // Scripts/Skin/Shotgun/View.as: native readiness drives the pump and supporting hand.
    let cockFade = 1;
    if (p.reloading) cockFade = reload < .25 || p.ammo < p.clipSize - 1 ? 0 : Math.min(1, (reload - .25) * 10);
    if (cockFade > 0) {
      let cock = 0, tim = 1 - p.readyState;
      if (tim < 0) {
        if (p.ammo >= p.clipSize && reload > .5 && reload < 1) {
          tim = reload - .5;
          if (tim >= .05 && tim < .12) cock = (tim - .05) / .07;
          else if (tim >= .12 && tim < .26) cock = 1;
          else if (tim >= .26 && tim < .36) cock = 1 - (tim - .26) / .1;
        }
      } else if (tim >= .2 && tim < .3) cock = (tim - .2) / .1;
      else if (tim >= .3 && tim < .42) cock = 1;
      else if (tim >= .42 && tim < .52) cock = 1 - (tim - .42) / .1;
      mat = mul(mat, T(0, cock * cockFade * -1.5, 0));
      left = mix(left, apply(mat, 0, 4, 2), cockFade);
    }
    this.place('shotgunPump', mat);
    return [left, right];
  }
  spade(swing) {
    let mat = S(.033);
    const {spadeAction: action, spadeProgress: progress} = this.state;
    if (action === 1) {
      const per = 1 - progress;
      mat = mul(T(0, per * .3, 0), R(1, 0, 0, per * 1.7), mat);
    } else if (action === 2 || action === 3) {
      let per = progress, angle, front = -.8, side = 1;
      if (per < .5) {
        if (action === 3) { per = 4 * per * per; angle = per * .6; side = per; front = per * -.8; }
        else { per = ((.5 - per) / .5) ** 4; angle = .6 + per * .6; front += per * 2; }
      } else { per = (per - .5) / .5; per = 1 - (1 - per) ** 2; angle = .6 + per * .6; front += per * 2; }
      mat = mul(T(side * .3, front * .1, front * .02), R(0, 0, 1, front * .15), R(1, 0, 0, angle), mat);
    }
    if (this.sprintSmooth > 0 || this.raise < 1) { const per = Math.max(this.sprintSmooth, 1 - this.raise); mat = mul(T(.3 * per, -.4 * per, -.1 * per), R(0, 1, 0, per * 1.3), mat); }
    mat = mul(Tv(swing), T(-.3, .7, .3), T(0, (1 - this.raise) * -.3, 0), mat);
    this.place('spade', mat);
    return [apply(mat, 0, 0, 7), apply(mat, 0, 0, -2)];
  }
  block(swing) {
    let mat = S(.033);
    const s = this.sprintSmooth, d = 1 - this.raise;
    if (s > 0) mat = mul(T(.1 * s, -.4 * s, -.05 * s), R(0, 0, 1, s * -.3), mat);
    mat = mul(T(-.1 * d, -.3 * d, .2 * d), Tv(swing), T(-.3, .7, .3), mat);
    this.place('block', mat);
    return [apply(mat, 5, -1, 4), apply(mat, -5.5, 3, -5)];
  }
  grenadeView(p, swing) {
    let mat = S(.033), bring = 1, pin = 0, side = 0;
    if (p.cooking && p.cookTime > .0001) { pin = Math.min(p.cookTime * 8, 2); if (pin > 1) { side += pin - 1; bring -= (pin - 1) * 2; } }
    const s = this.sprintSmooth, d = 1 - this.raise;
    if (s > 0) mat = mul(T(.1 * s, -.2 * s, -.05 * s), R(0, 0, 1, s * -.3), mat);
    mat = mul(Tv(swing), T(-.1 * d, -.3 * d, .1 * d), T(-.3 - side * .8, .8 - bring * .1, .45 - bring * .15), mat);
    this.place('grenade', mat);
    let left = apply(mat, 10, -1, 10); const right = apply(mat, -3, 1, 5), left2 = apply(mat, 2, 1, -2), left3 = apply(mat, 8, -1, 10);
    left = pin < 1 ? mix(left, left2, pin) : mix(left2, left3, pin - 1);
    return [left, right];
  }
  /** Two-bone arms from fixed shoulders to the skin's hand positions. */
  arms(left, right) {
    if (left.lengthSq() < .001 || right.lengthSq() < .001) return;
    const shoulders = [V(.4, 0, .25), V(-.4, 0, .25)], hands = [left, right], bends = [V(.5, .2, 0), V(-.5, .2, 0)];
    const basis = (dir, origin) => {
      const a2 = dir.clone().normalize(), a1 = a2.clone().cross(V(0, 0, 1)).normalize(), a0 = a1.clone().cross(a2).normalize();
      return mul(new THREE.Matrix4().makeBasis(a0, a1, a2).setPosition(origin), S(.05));
    };
    for (let i = 0; i < 2; i++) {
      const shoulder = shoulders[i], hand = hands[i], d = hand.clone().sub(shoulder);
      const bendLen = Math.sqrt(Math.max(.25 - d.lengthSq() * .25, 0));
      const bend = bends[i].clone().cross(d).normalize();
      if (bend.z < 0) bend.z = -bend.z;
      const elbow = hand.clone().add(shoulder).multiplyScalar(.5).addScaledVector(bend, bendLen);
      this.place('arm' + i, basis(hand.clone().sub(elbow), elbow));
      this.place('upper' + i, basis(elbow.clone().sub(shoulder), shoulder));
    }
  }
}
