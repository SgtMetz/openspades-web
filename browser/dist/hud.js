// The original OpenSpades 2D interface, drawn on a canvas with the game's own textures and fonts.
// Layouts and colors follow Sources/Client: Client_Draw.cpp, ChatWindow.cpp, MapView.cpp,
// ScoreboardView.cpp, LimboView.cpp, PaletteView.cpp, CenterMessageView.cpp and TCProgressView.cpp.
const ASSETS = 'assets/';
const IMAGES = ['White', 'Sight', 'HitFeedback', 'Intel', 'MinimapBorder', 'MapBorder', 'MapBg', 'DashLine', 'Palette',
  'AlertIcon', 'Fonts/MapFont', 'Fonts/SquareFontBig', 'Map/Rifle', 'Map/SMG', 'Map/Shotgun', 'Map/View', 'Map/Intel',
  'Map/CommandPost', 'Bullet/7.62mm', 'Bullet/9mm', 'Bullet/12gauge', 'Limbo/MenuItem', 'Limbo/BigMenuItem',
  'Scoreboard/TopShadow', 'Scoreboard/Grunt', 'Scoreboard/PlayersBg', 'TC/ProgressBar', 'TC/ProgressBg'];
export const images = {};
let glyphs = null;
export const FONT = 'AlteDIN1451';

export async function loadHud() {
  await Promise.all(IMAGES.map(name => new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => { images[name] = img; resolve(); };
    img.onerror = () => reject(Error('Missing Gfx/' + name + '.png'));
    img.src = `${ASSETS}Gfx/${name}.png`;
  })));
  glyphs = await (await fetch(ASSETS + 'Gfx/Fonts/SquareFontBig.json')).json();
  const face = new FontFace(FONT, `url(${ASSETS}Gfx/Fonts/AlteDIN1451.ttf)`);
  document.fonts.add(await face.load());
}

// ---- Drawing helpers (renderer->SetColorAlphaPremultiplied + DrawImage) ----
const tintCache = new Map();
/** Returns `img` multiplied by an [r,g,b] color in 0..1, like the renderer's vertex color. */
export function tinted(img, color) {
  if (color[0] === 1 && color[1] === 1 && color[2] === 1) return img;
  const key = img.src + '|' + color.map(c => Math.round(c * 255)).join(',');
  let c = tintCache.get(key);
  if (c) return c;
  c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
  const x = c.getContext('2d');
  x.drawImage(img, 0, 0);
  x.globalCompositeOperation = 'multiply';
  x.fillStyle = rgb(color); x.fillRect(0, 0, c.width, c.height);
  x.globalCompositeOperation = 'destination-in';
  x.drawImage(img, 0, 0);
  if (tintCache.size > 400) tintCache.clear();
  tintCache.set(key, c);
  return c;
}
export function rgb(c, a = 1) { return `rgba(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)},${a})`; }
function image(ctx, name, color, alpha, ...args) {
  if (alpha <= 0) return;
  ctx.globalAlpha = Math.min(1, alpha);
  ctx.drawImage(tinted(images[name], color), ...args);
  ctx.globalAlpha = 1;
}
function rect(ctx, x, y, w, h, color, alpha) { ctx.fillStyle = rgb(color, alpha); ctx.fillRect(x, y, w, h); }
/** Team colors arrive as r | g << 8 | b << 16. */
export function teamRGB(packed) { return [(packed & 255) / 255, ((packed >> 8) & 255) / 255, ((packed >> 16) & 255) / 255]; }
function modifyColor(c) { const avg = (c[0] + c[1] + c[2]) / 3; return c.map(v => (v + (avg - v) * .5) * .8 + .2); }

// ---- Fonts ----
// GUI font: FTFont(AlteDIN1451, 16 px, 20 px line); medium 24/32; large 34/48.
export const fonts = {gui: [16, 20], heading: [20, 26], medium: [24, 32], large: [34, 48]};
export function measure(ctx, text, font = fonts.gui) { ctx.font = `${font[0]}px ${FONT}`; return ctx.measureText(text).width; }
export function drawText(ctx, text, x, y, color = [1, 1, 1], alpha = 1, font = fonts.gui, shadowAlpha = 0, shadowColor = [0, 0, 0]) {
  ctx.font = `${font[0]}px ${FONT}`; ctx.textBaseline = 'alphabetic';
  const base = y + Math.round(font[1] * .5 + font[0] * .36);
  x = Math.floor(x);
  if (shadowAlpha > 0) { ctx.fillStyle = rgb(shadowColor, shadowAlpha); ctx.fillText(text, x + 1, base + 1); }
  ctx.fillStyle = rgb(color, alpha); ctx.fillText(text, x, base);
}
export function squareMeasure(text) {
  let x = 0;
  for (const ch of String(text)) { const g = glyphs[ch.charCodeAt(0)]; if (!g || g[2] === -1) continue; x += g[3] === -2 ? 8 : g[3]; }
  return x;
}
/** The "SquareFont" Quake 3 style bitmap font used for health, ammo and scores (48 px rows). */
export function squareText(ctx, text, x, y, color = [1, 1, 1], alpha = 1) {
  const atlas = tinted(images['Fonts/SquareFontBig'], color);
  ctx.globalAlpha = alpha; x = Math.floor(x); y = Math.floor(y);
  let cx = 0;
  for (const ch of String(text)) {
    const g = glyphs[ch.charCodeAt(0)];
    if (!g || g[2] === -1) continue;
    if (g[3] === -2) { cx += 8; continue; }
    ctx.drawImage(atlas, g[0], g[1], g[2], 48, x + cx, y, g[2], 48);
    cx += g[3];
  }
  ctx.globalAlpha = 1;
}
function squareShadow(ctx, text, x, y, color, shadow = .5) { squareText(ctx, text, x + 1, y + 1, [0, 0, 0], shadow); squareText(ctx, text, x, y, color); }

// ---- ChatWindow: kill feed (top left) and chat (lower left) ----
export const COLOR = {white: [1, 1, 1], red: [1, 0, 0], gray: [.5, .5, .5], green: [0, 1, 0]};
const measureCtx = document.createElement('canvas').getContext('2d');
export class ChatWindow {
  constructor(killfeed) { this.killfeed = killfeed; this.entries = []; this.firstY = 0; this.expanded = false; }
  clear() { this.entries = []; this.firstY = 0; }
  /** parts: [[text, [r,g,b]], ...]. Word-wrapped to half the screen width like the original. */
  add(parts) {
    const maxW = innerWidth / 2, lines = [[]];
    let x = 0;
    for (const [text, color] of parts) {
      for (const word of String(text).split(/(\s+)/)) {
        if (!word) continue;
        const w = measure(measureCtx, word);
        if (x + w > maxW && x > 0 && /\S/.test(word)) { lines.push([]); x = 0; }
        lines[lines.length - 1].push({text: word, color, x});
        x += w;
      }
    }
    const height = lines.length * 20;
    this.entries.unshift({lines, height, fade: 0, bufferFade: 0, timeFade: 15});
    this.firstY -= height;
    if (this.entries.length > 60) this.entries.length = 60;
  }
  normalHeight(H) { return H * (this.killfeed ? .26 : .30); }
  bufferHeight(H) { return this.killfeed ? this.normalHeight(H) : H * .74 - 100; }
  update(dt, H) {
    if (this.firstY < 0) this.firstY = Math.min(0, this.firstY + dt * Math.max(100, -this.firstY));
    const normal = this.normalHeight(H), buffer = this.bufferHeight(H);
    let y = this.firstY;
    for (let i = 0; i < this.entries.length; i++) {
      const e = this.entries[i];
      if (y + e.height > buffer) { e.bufferFade -= dt * 4; if (e.bufferFade < 0) { this.entries.splice(i--, 1); continue; } }
      if (y + e.height > normal) e.fade = Math.max(e.fade - dt * 4, 0);
      else if (y + e.height > 0) { e.fade = Math.min(e.fade + dt * 4, 1); e.bufferFade = Math.min(e.bufferFade + dt * 4, 1); }
      e.timeFade = Math.max(0, e.timeFade - dt);
      y += e.height;
    }
  }
  draw(ctx, W, H) {
    const winH = this.expanded ? this.bufferHeight(H) : this.normalHeight(H);
    const winX = 4, winY = this.killfeed ? 8 : H - winH - 60;
    if (this.expanded) rect(ctx, 0, winY, W / 2, winH, [0, 0, 0], .2);
    let y = this.firstY;
    for (const e of this.entries) {
      let fade = this.expanded ? e.bufferFade : e.fade * Math.min(1, e.timeFade);
      if (fade >= .01) {
        e.lines.forEach((line, li) => {
          for (const s of line) {
            const lum = s.color[0] + s.color[1] + s.color[2];
            drawText(ctx, s.text, s.x + winX, y + li * 20 + winY, s.color, fade, fonts.gui, .8 * fade, lum > .9 ? [0, 0, 0] : [1, 1, 1]);
          }
        });
      }
      y += e.height;
    }
  }
}

// ---- Center messages (large font, 100 px from the top) and alerts ----
export class CenterMessages {
  constructor() { this.entries = []; }
  add(text) {
    const used = new Set(this.entries.map(e => e.line));
    let line = 0; while (used.has(line) && line < 4) line++;
    if (line >= 4) { line = this.entries[this.entries.length - 1].line; this.entries.pop(); }
    this.entries.unshift({text, line, fade: 10});
  }
  update(dt) { this.entries = this.entries.filter(e => (e.fade -= dt) > 0); }
  draw(ctx, W) {
    for (const e of this.entries) {
      const f = Math.min(1, e.fade), w = measure(ctx, e.text, fonts.large);
      drawText(ctx, e.text, (W - w) / 2, 100 + 32 * e.line, [1, 1, 1], f, fonts.large, f * .5);
    }
  }
}
export class Alert {
  constructor() { this.text = ''; this.type = 0; this.appear = -10; this.disappear = -10; }
  /** type: 0 notice, 1 warning, 2 error. */
  show(text, type, now, timeout = 3) { this.text = text; this.type = type; this.appear = now; this.disappear = now + timeout; }
  draw(ctx, W, H, now) {
    const fade = Math.min(1, 1 - (now - this.disappear));
    if (fade <= 0 || !this.text) return;
    const borderFade = Math.max(0, Math.min(1, 1 - (now - this.appear) * 1.5)) * fade;
    const textW = measure(ctx, this.text);
    let cw = textW + (this.type ? 22 : 0) + 16, ch = 20 + 16;
    cw = Math.floor(cw); ch = Math.floor(ch);
    const x = Math.floor((W - cw) * .5), y = Math.floor((H - ch) * .7 + 40);
    const tone = this.type === 1 ? [1, 1, 0] : [1, 0, 0];
    if (this.type) {
      ctx.fillStyle = rgb(tone, .7 * borderFade);
      ctx.fillRect(x - 1, y - 1, cw + 2, 1); ctx.fillRect(x - 1, y + ch, cw + 2, 1);
      ctx.fillRect(x - 1, y, 1, ch); ctx.fillRect(x + cw, y, 1, ch);
    }
    rect(ctx, x, y, cw, ch, [0, 0, 0], fade * .5);
    if (this.type) image(ctx, 'AlertIcon', tone, fade, x + 8, y + (ch - 16) / 2);
    drawText(ctx, this.text, x + cw - textW - 8, y + (ch - 20) / 2, [1, 1, 1], fade, fonts.gui, fade * .5);
  }
}

// ---- Alive player HUD: sight, hit feedback, ammo, stock, health, center hint ----
const BULLETS = [['Bullet/7.62mm', 6, 24, 2], ['Bullet/9mm', 4, 16, 2], ['Bullet/12gauge', 30, 7.5, -6]];
export function drawSight(ctx, W, H, alpha = 1) {
  const img = images.Sight;
  image(ctx, 'Sight', [1, 1, 1], alpha, Math.floor((W - img.width) / 2), Math.floor((H - img.height) / 2));
}
export function drawHitFeedback(ctx, W, H, amount, friendly) {
  if (amount <= 0) return;
  const img = images.HitFeedback;
  image(ctx, 'HitFeedback', friendly ? [.02, 1, .02] : [1, .02, .04], amount, (W - img.width) / 2, (H - img.height) / 2);
}
/** s: {tool, weapon, ammo, clipSize, stock, maxStock, blocks, grenades, reloading, hp} */
export function drawAliveHud(ctx, W, H, s) {
  let iconH = 0, stock, warn = 0;
  if (s.tool === 2) {
    const [name, iw, ih, spacing] = BULLETS[s.weapon];
    iconH = ih;
    const clip = Math.max(s.clipSize, s.ammo);
    for (let i = 0; i < clip; i++) {
      const g = s.ammo >= i + 1 ? 1 : .4;
      image(ctx, name, [g, g, g], 1, W - 16 - (i + 1) * (iw + spacing), H - 16 - ih, iw, ih);
    }
    stock = s.stock; warn = Math.floor(s.maxStock / 3);
  } else stock = s.tool === 3 ? s.grenades : s.blocks;
  const color = [1, 1, 1];
  if (stock === 0) color[1] = color[2] = .3; else if (stock <= warn) color[2] = .3;
  const str = String(stock);
  squareShadow(ctx, str, W - 16 - squareMeasure(str), H - 16 - iconH - 48, color);
  let msg = '';
  if (s.tool === 1 && s.blocks === 0) msg = 'Out of Block';
  else if (s.tool === 3 && s.grenades === 0) msg = 'Out of Grenade';
  else if (s.tool === 2) {
    if (s.reloading) msg = 'Reloading';
    else if (s.ammo === 0 && s.stock === 0) msg = 'Out of Ammo';
    else if (s.stock > 0 && s.ammo < s.clipSize / 4) msg = 'Press [R] to Reload';
  }
  if (msg) drawText(ctx, msg, (W - measure(ctx, msg)) / 2, H * 2 / 3, [1, 1, 1], 1, fonts.gui, .5);
  drawHealth(ctx, H, s.hp);
}
export function drawHealth(ctx, H, hp) {
  const color = [1, 1, 1];
  if (hp === 0) color[1] = color[2] = .3; else if (hp <= 50) color[2] = .3;
  squareShadow(ctx, String(hp), 16, H - 16 - 48, color);
}
export function drawRespawn(ctx, W, H, secs) {
  const msg = secs > 0 ? `You will respawn in: ${Math.ceil(secs)}` : 'Waiting for respawn';
  drawText(ctx, msg, (W - measure(ctx, msg)) / 2, H / 3, [1, 1, 1], 1, fonts.gui, .5);
}
export function drawSpectateHelp(ctx, W, lines) {
  let y = 256 + 32 + 10;
  for (const line of lines) { drawText(ctx, line, W - 8 - measure(ctx, line), y, [1, 1, 1], 1, fonts.gui, .5); y += 20; }
}
export function drawIntelCarried(ctx, W, H, time) {
  image(ctx, 'Intel', [1, 1, 1], Math.abs(Math.sin(time * 2)), W - 260, H - 64);
}

// ---- Block palette (PaletteView) ----
export const PALETTE = (() => {
  const base = [[128, 128, 128], [256, 0, 0], [256, 128, 0], [256, 256, 0], [0, 256, 0], [0, 256, 256], [0, 0, 256], [256, 0, 256]];
  const out = [];
  const div = (c, n) => c.map(v => Math.max(0, Math.trunc(v * n / 8) - 1));
  for (const c of base) {
    for (const n of [1, 3, 5, 7]) out.push(div(c, n));
    const rem = c.map(v => 256 - v);
    for (const n of [1, 3, 5, 7]) out.push(c.map((v, i) => v + Math.trunc(rem[i] * n / 8) - 1));
  }
  return out;
})();
export function paletteIndex(packed) {
  const r = packed & 255, g = (packed >> 8) & 255, b = (packed >> 16) & 255;
  return PALETTE.findIndex(c => c[0] === r && c[1] === g && c[2] === b);
}
export function drawPalette(ctx, W, H, selected) {
  for (let phase = 0; phase < 2; phase++) {
    PALETTE.forEach((c, i) => {
      if ((selected === i) !== (phase === 1)) return;
      const x = W - 100 + 10 * (i % 8), y = H - 146 + 10 * Math.floor(i / 8), sel = selected === i ? 16 : 0;
      ctx.drawImage(tinted(images.Palette, c.map(v => v / 255)), 0, sel, 16, 16, x, y, 16, 16);
      ctx.drawImage(images.Palette, 16, sel, 16, 16, x, y, 16, 16);
    });
  }
}

// ---- Minimap and large map (MapView) ----
const PLAYER_PALETTE = [[0, 0, 0], [255, 255, 255], [128, 128, 128], [255, 255, 0], [0, 255, 255], [255, 0, 255], [255, 0, 0], [0, 255, 0], [0, 0, 255], [128, 0, 0], [0, 128, 0], [0, 0, 128], [128, 128, 0], [128, 0, 128], [0, 128, 128], [255, 128, 0], [255, 0, 128], [128, 0, 255], [0, 128, 255], [128, 255, 0], [0, 255, 128], [255, 128, 128], [128, 255, 128], [128, 128, 255], [128, 255, 255], [255, 255, 128], [255, 128, 255], [165, 42, 42], [255, 69, 0], [255, 165, 0], [139, 69, 19], [210, 105, 30]].map(c => c.map(v => v / 255));
export function playerColor(id) { return PLAYER_PALETTE[id % 32]; }
export {modifyColor};
function nineSlice(ctx, name, x0, y0, x1, y1, alpha) {
  const img = images[name];
  ctx.globalAlpha = alpha;
  ctx.drawImage(img, 0, 0, 16, 16, x0 - 16, y0 - 16, 16, 16);
  ctx.drawImage(img, 16, 0, 16, 16, x1, y0 - 16, 16, 16);
  ctx.drawImage(img, 0, 16, 16, 16, x0 - 16, y1, 16, 16);
  ctx.drawImage(img, 16, 16, 16, 16, x1, y1, 16, 16);
  ctx.drawImage(img, 15.5, 0, 1, 16, x0, y0 - 16, x1 - x0, 16);
  ctx.drawImage(img, 15.5, 16, 1, 16, x0, y1, x1 - x0, 16);
  ctx.drawImage(img, 0, 15.5, 16, 1, x0 - 16, y0, 16, y1 - y0);
  ctx.drawImage(img, 16, 15.5, 16, 1, x1, y0, 16, y1 - y0);
  ctx.globalAlpha = 1;
}
/**
 * m: {map (canvas, 512x512 top-down colors), large, zoom (0..1 animation), center {x,y},
 *     players [{x,y,angle,weapon,id,focus,spectator}], objects [{x,y,icon,color,alpha}], tracers}
 */
export function drawMap(ctx, W, H, m) {
  const mapW = 512, mapH = 512, [bx0, by0, bx1, by1] = m.bounds || [0, 0, 512, 512];
  let wnd = m.size || 128, zoomed = W < 512 || H < 512 ? 256 : 512, alpha = 1;
  let center = {x: m.center.x + (256 - m.center.x) * m.zoom, y: m.center.y + (256 - m.center.y) * m.zoom};
  if (m.large) {
    let per = 1 - m.zoom; per = 1 - per * per; per = .7 + .3 * per;
    zoomed *= per; wnd = zoomed; alpha = m.zoom;
  }
  let inX = center.x - wnd / 2, inY = center.y - wnd / 2, inW = wnd, inH = wnd;
  if (m.large) { inX = bx0; inY = by0; inW = bx1 - bx0; inH = by1 - by0; }
  else { inX = Math.max(bx0, Math.min(bx1 - inW, inX)); inY = Math.max(by0, Math.min(by1 - inH, inY)); }
  let outX = W - wnd - 16, outY = 16, outW = wnd, outH = wnd;
  if (m.large) { outX = (W - zoomed) / 2; outY = (H - zoomed) / 2; outW = outH = zoomed; }
  if (alpha <= 0) return;
  if (m.large) { const size = Math.max(W, H); image(ctx, 'MapBg', [0, 0, 0], alpha * .5, (W - size) / 2, (H - size) / 2, size, size); }
  const bw = m.large ? 3 * outH / zoomed : 2, inflate = bw - 8;
  nineSlice(ctx, m.large ? 'MapBorder' : 'MinimapBorder', outX - inflate, outY - inflate, outX + outW + inflate, outY + outH + inflate, alpha);
  ctx.globalAlpha = alpha; ctx.imageSmoothingEnabled = false;
  ctx.drawImage(m.map, inX, inY, inW, inH, outX, outY, outW, outH);
  ctx.globalAlpha = 1;
  const project = (x, y) => [(x - inX) / inW * outW + outX, (y - inY) / inH * outH + outY];
  ctx.fillStyle = rgb([0, 0, 0], .8 * alpha);
  for (let x = 64; x < mapW; x += 64) { const wx = (x - inX) / inW; if (wx < 0 || wx >= 1) continue; const px = Math.round(wx * outW + outX); for (let y = 0; y < outH; y += 2) ctx.fillRect(px, outY + y, 1, 1); }
  for (let y = 64; y < mapH; y += 64) { const wy = (y - inY) / inH; if (wy < 0 || wy >= 1) continue; const py = Math.round(wy * outH + outY); for (let x = 0; x < outW; x += 2) ctx.fillRect(outX + x, py, 1, 1); }
  const font = images['Fonts/MapFont'];
  for (let axis = 0; axis < 2; axis++) {
    for (let i = 0; i < 8; i++) {
      const start = i * 64, end = start + 64, min = axis ? inY : inX, max = min + (axis ? inH : inW);
      if (start > max || end < min) continue;
      const fade = Math.min((Math.min(end, max) - Math.max(start, min)) / 64 * 2, 1);
      const c = (Math.max(start, min) + Math.min(end, max)) / 2;
      ctx.globalAlpha = fade * .8 * alpha;
      if (!axis) ctx.drawImage(font, (i & 3) * 8, (i >> 2) * 8, 8, 8, Math.round((c - inX) / inW * outW + outX) - 4, outY + 4, 8, 8);
      else ctx.drawImage(font, (i & 3) * 8, (i >> 2) * 8 + 16, 8, 8, outX + 4, Math.round((c - inY) / inH * outH + outY) - 4, 8, 8);
    }
  }
  ctx.globalAlpha = 1;
  const icon = (x, y, name, color, a, angle = 0) => {
    if (x < inX || x > inX + inW || y < inY || y > inY + inH || a <= 0) return;
    const [px, py] = project(x, y), img = images[name];
    ctx.save(); ctx.translate(Math.floor(px), Math.floor(py)); if (angle) ctx.rotate(angle);
    ctx.globalAlpha = Math.min(1, a); ctx.drawImage(tinted(img, color), -img.width / 2, -img.height / 2);
    ctx.restore();
  };
  for (const p of m.players) {
    const color = modifyColor(p.spectator ? [200 / 255, 200 / 255, 200 / 255] : playerColor(p.id));
    if (p.focus) icon(p.x, p.y, 'Map/View', color, alpha * .9, p.angle);
    icon(p.x, p.y, ['Map/Rifle', 'Map/SMG', 'Map/Shotgun'][p.weapon] || 'Map/Rifle', color, alpha, p.angle);
  }
  for (const o of m.objects) icon(o.x, o.y, o.icon, modifyColor(o.color), alpha * (o.alpha ?? 1));
  ctx.strokeStyle = rgb([1, 1, 1], alpha * .8); ctx.lineWidth = 2;
  for (const t of m.tracers || []) { const a = project(t[0], t[1]), b = project(t[2], t[3]); ctx.beginPath(); ctx.moveTo(...a); ctx.lineTo(...b); ctx.stroke(); }
}

// ---- TC capture progress (TCProgressView) ----
export function drawTcProgress(ctx, W, H, ownerColor, progress, fade, label) {
  const x = (W - 256) / 2, y = H * .7;
  image(ctx, 'TC/ProgressBg', ownerColor, fade, x, y);
  if (progress) image(ctx, 'TC/ProgressBar', progress.color, fade, 0, 0, 256 * progress.value, 32, x, y, 256 * progress.value, 32);
  if (label) drawText(ctx, label, (W - measure(ctx, label)) / 2, y - 22, [1, 1, 1], fade, fonts.gui, fade * .5);
}

// ---- Scoreboard (ScoreboardView) ----
function adjust(c, bright, sat) { c = c.map(v => v * bright); const avg = (c[0] + c[1] + c[2]) / 3; return c.map(v => avg + (v - avg) * sat); }
/** b: {teams: [{name, color, score}], capLimit, players: [{id, name, team, kills, alive, local}]} */
export function drawScoreboard(ctx, W, b) {
  const top = 120, barH = 60, left = W / 2 - 400, right = W / 2 + 400, playersTop = top + barH, playersH = 300, specH = 78;
  const spectators = b.players.filter(p => p.team >= 2);
  image(ctx, 'Scoreboard/TopShadow', [0, 0, 0], .2, 0, top - 32, W, 32);
  ctx.save(); ctx.translate(0, playersTop + playersH + 32); ctx.scale(1, -1); image(ctx, 'Scoreboard/TopShadow', [0, 0, 0], .2, 0, 0, W, 32); ctx.restore();
  rect(ctx, 0, top, W / 2, barH, adjust(b.teams[0].color, .8, .3), 1);
  rect(ctx, W / 2, top, W / 2, barH, adjust(b.teams[1].color, .8, .3), 1);
  image(ctx, 'Scoreboard/Grunt', [1, 1, 1], 1, left, top + barH - 60, 120, 60);
  ctx.save(); ctx.translate(right, 0); ctx.scale(-1, 1); image(ctx, 'Scoreboard/Grunt', [1, 1, 1], 1, 0, top + barH - 60, 120, 60); ctx.restore();
  squareText(ctx, b.teams[0].name, left + 110, top + 7, [0, 0, 0], .5); squareText(ctx, b.teams[0].name, left + 110, top + 5);
  const n1 = b.teams[1].name, w1 = squareMeasure(n1);
  squareText(ctx, n1, right - 110 - w1, top + 7, [0, 0, 0], .5); squareText(ctx, n1, right - 110 - w1, top + 5);
  if (b.capLimit >= 0) {
    const s0 = `${b.teams[0].score}-${b.capLimit}`, s1 = `${b.teams[1].score}-${b.capLimit}`;
    squareText(ctx, s0, W / 2 - squareMeasure(s0) - 15, top + 5, [1, 1, 1], .5);
    squareText(ctx, s1, W / 2 + 15, top + 5, [1, 1, 1], .5);
  }
  image(ctx, 'Scoreboard/PlayersBg', [0, 0, 0], 1, 0, playersTop, W, playersH + (spectators.length ? specH : 0));
  for (let t = 0; t < 2; t++) {
    const entries = b.players.filter(p => p.team === t).sort((a, c) => c.kills - a.kills);
    const x0 = t ? W / 2 : left, width = (right - left) / 2;
    let maxRows = Math.floor(playersH / 24), cols = Math.max(1, Math.ceil(entries.length / maxRows));
    maxRows = Math.ceil(entries.length / cols) || 1;
    const colW = width / cols;
    entries.forEach((p, i) => {
      const row = i % maxRows, col = Math.floor(i / maxRows), y = playersTop + 6 + row * 24, x = x0 + colW * col;
      const id = '#' + p.id;
      drawText(ctx, id, x + 35 - measure(ctx, id), y, modifyColor(playerColor(p.id)));
      drawText(ctx, p.name, x + 45, y, p.local ? b.teams[t].color : p.alive ? [1, 1, 1] : [.5, .5, .5]);
      const k = String(p.kills);
      drawText(ctx, k, x + colW - 10 - measure(ctx, k), y, [1, 1, 1]);
    });
  }
  if (spectators.length) {
    const label = spectators.length === 1 ? 'Spectator:' : 'Spectators:';
    const sw = squareMeasure(label);
    squareText(ctx, label, W / 2 - sw / 2, playersTop + playersH, [1, 1, 1], .8);
    let total = 0;
    for (const p of spectators) total += measure(ctx, '#' + p.id) + measure(ctx, p.name) + 20;
    let x = W / 2 - total / 2;
    const y = playersTop + playersH + 48;
    for (const p of spectators) {
      const id = '#' + p.id;
      drawText(ctx, id, x, y, [.8, .8, .8]);
      drawText(ctx, p.name, x + measure(ctx, id) + 5, y, [1, 1, 1]);
      x += measure(ctx, id) + measure(ctx, p.name) + 20;
    }
  }
}

// ---- Team and weapon selection (LimboView) ----
export class Limbo {
  constructor() { this.team = 2; this.weapon = 0; this.teams = true; this.mouse = {x: -1, y: -1}; }
  items(W, H, teamNames) {
    const left = (W - 800) / 2, top = H - 150, firstY = top + 35, mw = 200, mh = 25, row = 28;
    const list = [
      {type: 0, x: left + 10, y: firstY, w: mw, h: mh, text: teamNames[0]},
      {type: 1, x: left + 10, y: firstY + row, w: mw, h: mh, text: teamNames[1]},
      {type: 3, x: left + 260, y: firstY, w: mw, h: mh, text: 'Rifle'},
      {type: 4, x: left + 260, y: firstY + row, w: mw, h: mh, text: 'SMG'},
      {type: 5, x: left + 260, y: firstY + row * 2, w: mw, h: mh, text: 'Shotgun'},
      {type: 6, x: left + 800 - 266, y: firstY + 4, w: 256, h: 64, text: 'Spawn'},
    ];
    for (const it of list) it.visible = !(it.type >= 3 && this.team === 2) && !(it.type <= 2 && !this.teams);
    return list;
  }
  hit(W, H, teamNames, x, y) {
    return this.items(W, H, teamNames).find(it => it.visible && x >= it.x && x < it.x + it.w && y >= it.y && y < it.y + it.h);
  }
  draw(ctx, W, H, teamNames) {
    const left = (W - 800) / 2, top = H - 150;
    if (this.teams) drawText(ctx, 'Select Team:', left + 10, top + 10, [1, 1, 1], 1, fonts.gui, .4);
    if (this.team !== 2) drawText(ctx, 'Select Weapon:', left + 260, top + 10, [1, 1, 1], 1, fonts.gui, .4);
    for (const it of this.items(W, H, teamNames)) {
      if (!it.visible) continue;
      const hover = this.mouse.x >= it.x && this.mouse.x < it.x + it.w && this.mouse.y >= it.y && this.mouse.y < it.y + it.h;
      let selected = false, index = 0;
      if (it.type <= 2) { selected = this.team === it.type; index = this.team === 2 ? it.type + 1 : 0; }
      else if (it.type <= 5) { selected = this.weapon === it.type - 3; index = this.team !== 2 ? it.type - 2 : 0; }
      // Premultiplied (.2,.2,.2,.5), (.4,.4,.4,1)*.7 and (.7,.7,.7,1)*.9 in the original.
      let fill = [.4, .4, .4], a = .5;
      if (hover) a = .7;
      if (selected) { fill = [.7, .7, .7]; a = .9; }
      image(ctx, it.type === 6 ? 'Limbo/BigMenuItem' : 'Limbo/MenuItem', fill, a, it.x, it.y, it.w, it.h);
      if (it.type === 6) {
        const w = measure(ctx, it.text);
        drawText(ctx, it.text, it.x + (it.w - w) / 2 + 2, it.y + (it.h - 20) / 2, [1, 1, 1], 1, fonts.gui, .4);
      } else {
        drawText(ctx, it.text, it.x + 5, it.y + (it.h - 20) / 2, [1, 1, 1], 1, fonts.gui, .4);
        if (index > 0) drawText(ctx, String(index), it.x + it.w - 5 - measure(ctx, String(index)), it.y + (it.h - 20) / 2, [1, 1, 1], 1, fonts.gui, .4);
      }
    }
  }
}

// ---- Connecting / map loading screen (Draw2DWithoutWorld) ----
export function drawLoading(ctx, W, H, status, progress, time) {
  rect(ctx, 0, 0, W, H, [0, 0, 0], 1);
  const w = measure(ctx, status);
  drawText(ctx, status, W - 16 - w, H - 24 - 20, [1, 1, 1], .95);
  if (progress != null) {
    rect(ctx, W - 236, H - 18, 222, 4, [1, 1, 1], .2);
    rect(ctx, W - 236, H - 18, 222 * progress, 4, [1, 1, 1], 1);
  } else {
    let pos = time / 3.6; pos -= Math.floor(pos); pos = 1 - pos * 2;
    for (let v = 0; v < .6; v += .14) {
      let p = pos + v;
      if (p < .01 || p > .99) continue;
      p = Math.asin(p * 2 - 1) / Math.PI + .5;
      rect(ctx, W - 236 + p * 234, H - 18, 4, 4, [1, 1, 1], p * (1 - p) * 4);
    }
  }
}
