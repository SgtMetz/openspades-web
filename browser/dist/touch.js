// Touch input stays separate from the keyboard so releasing one finger never releases another device's keys.
export function detectTouch(nav = navigator, media = matchMedia, search = location.search) {
  const override = new URLSearchParams(search).get('touch');
  if (override === '1' || override === '0') return override === '1';
  return !!nav.userAgentData?.mobile || /Android|iPhone|iPad|iPod/i.test(nav.userAgent || '') ||
    (nav.platform === 'MacIntel' && nav.maxTouchPoints > 1) ||
    (nav.maxTouchPoints > 0 && media('(pointer: coarse)').matches);
}

export class TouchControls {
  constructor(root, {look, action, fire}, win = window) {
    this.root = root; this.keys = new Set(); this.buttons = 0; this.pointers = new Map(); this.active = false;
    this.look = look; this.action = action; this.fire = fire;
    this.stick = root.querySelector('#touch-stick'); this.knob = root.querySelector('#touch-knob');
    root.addEventListener('pointerdown', e => this.down(e));
    root.addEventListener('pointermove', e => this.move(e));
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) root.addEventListener(type, e => this.up(e));
    root.addEventListener('contextmenu', e => e.preventDefault());
    win.addEventListener('blur', () => this.reset());
    win.addEventListener('resize', () => this.reset());
    win.document.addEventListener('visibilitychange', () => { if (win.document.hidden) this.reset(); });
  }
  down(e) {
    if (!this.active || e.button > 0) return;
    const button = e.target.closest('button'), stick = e.target.closest('#touch-stick');
    const kind = button ? 'button' : stick ? 'stick' : 'look';
    if (kind !== 'button' && [...this.pointers.values()].some(p => p.kind === kind)) return;
    e.preventDefault();
    const p = {kind, target: button || this.root, x: e.clientX, y: e.clientY};
    this.pointers.set(e.pointerId, p); p.target.setPointerCapture(e.pointerId);
    if (button) {
      button.classList.add('held');
      if (button.dataset.mouse === '1') this.fire();
      this.rebuild();
      // Actions may open a menu and reset all pointers; capture is already established above.
      if (button.dataset.action) this.action(button.dataset.action);
    } else if (stick) this.move(e);
  }
  move(e) {
    const p = this.pointers.get(e.pointerId); if (!p) return;
    e.preventDefault();
    if (p.kind === 'look') this.look(e.clientX - p.x, e.clientY - p.y);
    if (p.kind === 'stick') {
      const r = this.stick.getBoundingClientRect(), radius = r.width * .34;
      const dx = e.clientX - r.left - r.width / 2, dy = e.clientY - r.top - r.height / 2;
      const scale = Math.min(1, radius / (Math.hypot(dx, dy) || 1));
      p.dx = dx * scale / radius; p.dy = dy * scale / radius;
      this.knob.style.transform = `translate(${dx * scale}px, ${dy * scale}px)`;
      this.rebuild();
    }
    p.x = e.clientX; p.y = e.clientY;
  }
  up(e) {
    const p = this.pointers.get(e.pointerId); if (!p) return;
    this.pointers.delete(e.pointerId);
    if (p.target.hasPointerCapture(e.pointerId)) p.target.releasePointerCapture(e.pointerId);
    if (p.kind === 'stick') this.knob.style.transform = '';
    if (![...this.pointers.values()].some(other => other.target === p.target)) p.target.classList.remove('held');
    this.rebuild();
  }
  rebuild() {
    this.keys.clear(); this.buttons = 0;
    for (const p of this.pointers.values()) {
      if (p.kind === 'stick') {
        if (p.dy < -.25) this.keys.add('KeyW'); if (p.dy > .25) this.keys.add('KeyS');
        if (p.dx < -.25) this.keys.add('KeyA'); if (p.dx > .25) this.keys.add('KeyD');
      } else if (p.kind === 'button') {
        if (p.target.dataset.key) this.keys.add(p.target.dataset.key);
        this.buttons |= Number(p.target.dataset.mouse) || 0;
      }
    }
  }
  reset() {
    const pointers = [...this.pointers.entries()]; this.pointers.clear();
    for (const [id, p] of pointers) {
      p.target.classList.remove('held');
      if (p.target.hasPointerCapture(id)) p.target.releasePointerCapture(id);
    }
    this.keys.clear(); this.buttons = 0; this.knob.style.transform = '';
  }
  setActive(active) {
    if (this.active === active) return;
    this.active = active; this.root.hidden = !active;
    if (!active) this.reset();
  }
}
