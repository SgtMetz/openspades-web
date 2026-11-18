// Touch input stays separate from the keyboard so releasing one finger never releases another device's keys.
// GPL-3.0-or-later.
export function detectTouch(nav = navigator, media = matchMedia, search = location.search) {
  const override = new URLSearchParams(search).get('touch');
  if (override === '1' || override === '0') return override === '1';
  return !!nav.userAgentData?.mobile || /Android|iPhone|iPad|iPod/i.test(nav.userAgent || '') ||
    (nav.platform === 'MacIntel' && nav.maxTouchPoints > 1) ||
    (nav.maxTouchPoints > 0 && media('(pointer: coarse)').matches);
}

export class TouchControls {
  /**
   * look(dx, dy): view drag in CSS pixels. action(code): one-shot button. fire(): fire pressed. tap(): haptic hook.
   * Buttons: data-key (held key), data-mouse (held mouse bits), data-action (one-shot), data-look (also drags the view).
   */
  constructor(root, {look, action, fire, tap}, win = window) {
    this.root = root; this.keys = new Set(); this.buttons = 0; this.pointers = new Map(); this.active = false;
    this.look = look; this.action = action; this.fire = fire; this.tap = tap;
    this.toggles = new Set(); this.toggleKeys = new Set(['ControlLeft']); this.autoSprint = true;
    this.stick = root.querySelector('#touch-stick'); this.knob = root.querySelector('#touch-knob');
    root.addEventListener('pointerdown', e => this.down(e));
    root.addEventListener('pointermove', e => this.move(e));
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) root.addEventListener(type, e => this.up(e));
    root.addEventListener('contextmenu', e => e.preventDefault());
    win.addEventListener('blur', () => this.reset());
    win.addEventListener('resize', () => this.reset());
    win.document.addEventListener('visibilitychange', () => { if (win.document.hidden) this.reset(); });
  }
  /** Keys in this set toggle on tap instead of being held (e.g. crouch). */
  setToggleKeys(codes) { this.toggleKeys = new Set(codes); for (const k of [...this.toggles]) if (!this.toggleKeys.has(k)) this.toggles.delete(k); this.rebuild(); }
  down(e) {
    if (!this.active || e.button > 0) return;
    const button = e.target.closest('button'), stick = e.target.closest('#touch-stick');
    const kind = button ? 'button' : stick ? 'stick' : 'look';
    if (kind !== 'button' && [...this.pointers.values()].some(p => p.kind === kind)) return;
    e.preventDefault();
    const p = {kind, target: button || this.root, x: e.clientX, y: e.clientY};
    this.pointers.set(e.pointerId, p); p.target.setPointerCapture(e.pointerId);
    if (button) {
      this.tap?.();
      const key = button.dataset.key;
      if (key && this.toggleKeys.has(key)) {
        if (this.toggles.has(key)) this.toggles.delete(key); else this.toggles.add(key);
        p.toggle = true;
      }
      button.classList.add('held');
      if (button.dataset.mouse === '1') this.fire?.();
      this.rebuild();
      // Actions may open a menu and reset all pointers; capture is already established above.
      if (button.dataset.action) this.action(button.dataset.action);
    } else if (stick) this.move(e);
  }
  move(e) {
    const p = this.pointers.get(e.pointerId); if (!p) return;
    e.preventDefault();
    if (p.kind === 'look' || (p.kind === 'button' && 'look' in p.target.dataset)) this.look(e.clientX - p.x, e.clientY - p.y);
    if (p.kind === 'stick') {
      const r = this.stick.getBoundingClientRect(), radius = r.width * .34;
      const dx = e.clientX - r.left - r.width / 2, dy = e.clientY - r.top - r.height / 2;
      const scale = Math.min(1, radius / (Math.hypot(dx, dy) || 1));
      p.dx = dx * scale / radius; p.dy = dy * scale / radius; p.mag = Math.hypot(dx, dy) / radius;
      this.knob.style.transform = `translate(${dx * scale}px, ${dy * scale}px)`;
      this.rebuild();
    }
    p.x = e.clientX; p.y = e.clientY;
  }
  up(e) {
    const p = this.pointers.get(e.pointerId); if (!p) return;
    this.pointers.delete(e.pointerId);
    if (p.target.hasPointerCapture(e.pointerId)) p.target.releasePointerCapture(e.pointerId);
    if (p.kind === 'stick') { this.knob.style.transform = ''; this.stick.classList.remove('sprinting'); }
    if (![...this.pointers.values()].some(other => other.target === p.target)) p.target.classList.remove('held');
    this.rebuild();
  }
  rebuild() {
    this.keys.clear(); this.buttons = 0;
    for (const k of this.toggles) this.keys.add(k);
    for (const p of this.pointers.values()) {
      if (p.kind === 'stick') {
        if (p.dy < -.25) this.keys.add('KeyW'); if (p.dy > .25) this.keys.add('KeyS');
        if (p.dx < -.25) this.keys.add('KeyA'); if (p.dx > .25) this.keys.add('KeyD');
        // Auto-sprint: stick pushed past its rim, mostly forward.
        const sprint = this.autoSprint && p.mag > 1.15 && p.dy < -.7;
        if (sprint) this.keys.add('ShiftLeft');
        this.stick.classList.toggle('sprinting', !!sprint);
      } else if (p.kind === 'button') {
        if (p.target.dataset.key && !p.toggle) this.keys.add(p.target.dataset.key);
        this.buttons |= Number(p.target.dataset.mouse) || 0;
      }
    }
    for (const b of this.root.querySelectorAll('[data-key]')) if (this.toggleKeys.has(b.dataset.key)) b.setAttribute('aria-pressed', String(this.toggles.has(b.dataset.key)));
  }
  reset() {
    const pointers = [...this.pointers.entries()]; this.pointers.clear();
    for (const [id, p] of pointers) {
      p.target.classList.remove('held');
      if (p.target.hasPointerCapture(id)) p.target.releasePointerCapture(id);
    }
    this.toggles.clear();
    this.keys.clear(); this.buttons = 0; this.knob.style.transform = ''; this.stick.classList.remove('sprinting');
    for (const b of this.root.querySelectorAll('[aria-pressed]')) if (b.dataset.key) b.setAttribute('aria-pressed', 'false');
  }
  setActive(active) {
    if (this.active === active) return;
    this.active = active; this.root.hidden = !active;
    if (!active) this.reset();
  }
}
